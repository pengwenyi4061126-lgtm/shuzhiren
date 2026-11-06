"""Picture layer (captions, product card, price sticker, background) for the Shuzhiren LiveTalking image.

LiveTalking composes every output frame in this order (runtime/patches/livetalking-overlay.patch):

    background -> product card and price sticker -> caption -> AIGC label

The AIGC label (shuzhiren_aigc_label.py) is always drawn last and is the only
layer whose failure drops a frame. A failing picture layer never costs the frame
or the label: render_output_frame() falls back to the frame without the picture
layer and counts the failure.

Inputs, all validated here (fail closed: a scene or caption that does not parse is refused or ignored whole):

  scene     version 1 JSON frozen by the control plane when a show revision is approved, delivered by the Runtime
            Gateway together with its SHA-256 (parse_scene). Layout of the scene document:
              caption        {"enabled": bool, "position": "bottom_band" | "top_band"}
              productCard    null | {"anchor": top-left | top-right | bottom-left | bottom-right | middle-left |
                                     middle-right, "title": str}
              priceSticker   null | {"priceText": str, "note": str | null, "validUntil": ISO 8601 UTC | null}
                             (needs productCard; hidden once validUntil has passed)
              background     null | {"mode": "none"} | {"mode": "canvas", "assetSha256": 64 hex,
                                     "avatarAnchor": left | center | right, "avatarScalePermille": 500..1000} |
                             {"mode": "chroma_key", "assetSha256": 64 hex, "keyColor": "#rrggbb", "tolerance": 0..255}
            Unknown extra keys are ignored.
  caption   multipart field `shuzhiren_caption` of /humanaudio: JSON {"id": str, "cues": [{"text", "start_ms",
            "end_ms"}]} built by the Runtime Gateway from the real sample counts of the synthesized chunks
            (parse_caption). CaptionTrack advances it only with the audio frames that carry its id (20 ms each).
  assets    background images are read only from SHUZHIREN_OVERLAY_ASSET_DIR (default /opt/shuzhiren/overlay-assets)
            as <sha256 hex>.png or <sha256 hex>.jpg, hash-checked and limited to 4096 x 4096. Anything else closes the
            background layer (reason background_asset_unavailable) and leaves the other layers alone.

Frames are uint8 numpy arrays (H x W x 3 or 4). LiveTalking frames are BGR; pass channel_order="rgb" otherwise.
compose() never modifies its input frame. numpy and Pillow are imported lazily, so parse_scene, parse_caption,
layout, CaptionTrack and status() work with the standard library only.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import threading
import time
import unicodedata
import weakref
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from typing import Callable, NamedTuple, Sequence

import shuzhiren_aigc_label as aigc

logger = logging.getLogger("shuzhiren_overlay")

ENV_ASSET_DIR = "SHUZHIREN_OVERLAY_ASSET_DIR"
DEFAULT_ASSET_DIR = "/opt/shuzhiren/overlay-assets"

SCENE_VERSION = 1
MAX_SCENE_CHARS = 8192
CAPTION_POSITIONS = ("bottom_band", "top_band")
CARD_ANCHORS = ("top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right")
BACKGROUND_MODES = ("none", "canvas", "chroma_key")
AVATAR_ANCHORS = ("left", "center", "right")
MIN_AVATAR_SCALE_PERMILLE = 500
MAX_AVATAR_SCALE_PERMILLE = 1000
MAX_TOLERANCE = 255
MAX_TITLE_CHARS = 60
MAX_PRICE_TEXT_CHARS = 16
MAX_NOTE_CHARS = 40
MAX_REVISION_ID_CHARS = 64

MAX_CAPTION_FORM_BYTES = 16 * 1024
MAX_CUES = 200
MAX_CUE_TEXT_CHARS = 80
MAX_CAPTION_ID_CHARS = 64
MAX_CUE_MS = 24 * 60 * 60 * 1000
MAX_CAPTION_IDS = 16
FRAME_MS = 20
CLEAR_AFTER_MS = 300

MAX_ASSET_SIDE = 4096
MAX_ASSET_BYTES = 32 * 1024 * 1024

LAYER_CONFLICT = "layer_conflicts_aigc_label"
BACKGROUND_UNAVAILABLE = "background_asset_unavailable"
LAYERS = ("product_card", "price_sticker", "caption")

# Geometry, as fractions of the frame (see layout()).
EDGE_FRACTION = 0.02
GAP_FRACTION = 0.01
CARD_WIDTH_FRACTION = 0.24
CARD_HEIGHT_FRACTION = 0.12
STICKER_HEIGHT_FRACTION = 0.08
CAPTION_WIDTH_FRACTION = 0.8
CAPTION_HEIGHT_FRACTION = 0.10
LAYOUT_MARGIN_FRACTION = 0.01
MIN_FONT_PX = 6

_SHA256 = re.compile(r"[0-9a-f]{64}")
_KEY_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
_CAPTION_ID = re.compile(r"[A-Za-z0-9_.:\-]{1,64}")


class OverlayError(Exception):
    """A scene, caption or frame is unusable. `reason` is a short machine-readable category."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"overlay {reason}" + (f": {detail}" if detail else ""))
        self.reason = reason


class Rect(NamedTuple):
    x: int
    y: int
    w: int
    h: int


class Cue(NamedTuple):
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class ProductCard:
    anchor: str
    title: str


@dataclass(frozen=True)
class PriceSticker:
    price_text: str
    note: str | None
    valid_until: datetime | None


@dataclass(frozen=True)
class Background:
    mode: str  # "canvas" or "chroma_key"
    asset_sha256: str
    avatar_anchor: str | None = None
    avatar_scale_permille: int | None = None
    key_color: tuple[int, int, int] | None = None  # RGB
    tolerance: int | None = None


@dataclass(frozen=True)
class Scene:
    version: int
    revision_id: str | None
    caption_enabled: bool
    caption_position: str
    product_card: ProductCard | None
    price_sticker: PriceSticker | None
    background: Background | None
    sha256: str


# ─── scene parsing ────────────────────────────────────────────────────────────────────────────────


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _object(value, reason: str) -> dict:
    if not isinstance(value, dict):
        raise OverlayError(reason)
    return value


def _text(value, reason: str, max_chars: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_chars:
        raise OverlayError(reason)
    if any(unicodedata.category(character).startswith("C") for character in value):
        raise OverlayError(reason)
    return value


def _choice(value, reason: str, allowed: Sequence[str]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise OverlayError(reason)
    return value


def _parse_valid_until(value) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 40:
        raise OverlayError("price_sticker_invalid")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError:
        raise OverlayError("price_sticker_invalid") from None
    if parsed.tzinfo is None:
        raise OverlayError("price_sticker_invalid")
    return parsed.astimezone(timezone.utc)


def _parse_background(value) -> Background | None:
    if value is None:
        return None
    data = _object(value, "background_invalid")
    mode = _choice(data.get("mode"), "background_invalid", BACKGROUND_MODES)
    if mode == "none":
        return None
    asset = data.get("assetSha256")
    if not isinstance(asset, str) or not _SHA256.fullmatch(asset):
        raise OverlayError("background_invalid")
    if mode == "canvas":
        scale = data.get("avatarScalePermille")
        if not _is_int(scale) or not MIN_AVATAR_SCALE_PERMILLE <= scale <= MAX_AVATAR_SCALE_PERMILLE:
            raise OverlayError("background_invalid")
        return Background(mode, asset, avatar_anchor=_choice(data.get("avatarAnchor"), "background_invalid", AVATAR_ANCHORS), avatar_scale_permille=scale)
    key = data.get("keyColor")
    tolerance = data.get("tolerance")
    if not isinstance(key, str) or not _KEY_COLOR.fullmatch(key) or not _is_int(tolerance) or not 0 <= tolerance <= MAX_TOLERANCE:
        raise OverlayError("background_invalid")
    return Background(mode, asset, key_color=(int(key[1:3], 16), int(key[3:5], 16), int(key[5:7], 16)), tolerance=tolerance)


def parse_scene(scene_json: str, scene_sha256: str) -> Scene:
    """Validates a version 1 scene document against its SHA-256; raises OverlayError(reason) on any problem."""
    if not isinstance(scene_json, str):
        raise OverlayError("scene_json_invalid")
    if not isinstance(scene_sha256, str) or not _SHA256.fullmatch(scene_sha256):
        raise OverlayError("scene_hash_invalid")
    if len(scene_json) > MAX_SCENE_CHARS:
        raise OverlayError("scene_too_long")
    try:
        encoded = scene_json.encode("utf-8")
    except UnicodeEncodeError:
        raise OverlayError("scene_json_invalid") from None
    if hashlib.sha256(encoded).hexdigest() != scene_sha256:
        raise OverlayError("scene_hash_mismatch")
    try:
        data = json.loads(scene_json)
    except (ValueError, RecursionError):
        raise OverlayError("scene_json_invalid") from None
    data = _object(data, "scene_not_object")
    version = data.get("version")
    if not _is_int(version) or version != SCENE_VERSION:
        raise OverlayError("scene_version_unsupported")
    revision_id = data.get("revisionId")
    if revision_id is not None:
        revision_id = _text(revision_id, "revision_id_invalid", MAX_REVISION_ID_CHARS)

    caption = _object(data.get("caption", {"enabled": False, "position": "bottom_band"}), "caption_invalid")
    if not isinstance(caption.get("enabled"), bool):
        raise OverlayError("caption_invalid")
    caption_position = _choice(caption.get("position", "bottom_band"), "caption_invalid", CAPTION_POSITIONS)

    card = None
    if data.get("productCard") is not None:
        raw = _object(data["productCard"], "product_card_invalid")
        card = ProductCard(_choice(raw.get("anchor"), "product_card_invalid", CARD_ANCHORS), _text(raw.get("title"), "product_card_invalid", MAX_TITLE_CHARS))

    sticker = None
    if data.get("priceSticker") is not None:
        raw = _object(data["priceSticker"], "price_sticker_invalid")
        note = raw.get("note")
        sticker = PriceSticker(
            _text(raw.get("priceText"), "price_sticker_invalid", MAX_PRICE_TEXT_CHARS),
            None if note is None else _text(note, "price_sticker_invalid", MAX_NOTE_CHARS),
            _parse_valid_until(raw.get("validUntil")),
        )
        if card is None:
            raise OverlayError("price_sticker_requires_product_card")

    return Scene(
        version=SCENE_VERSION,
        revision_id=revision_id,
        caption_enabled=caption["enabled"],
        caption_position=caption_position,
        product_card=card,
        price_sticker=sticker,
        background=_parse_background(data.get("background")),
        sha256=scene_sha256,
    )


# ─── layout ───────────────────────────────────────────────────────────────────────────────────────


def _clamp(x: int, y: int, w: int, h: int, width: int, height: int) -> Rect:
    w, h = min(max(1, w), width), min(max(1, h), height)
    return Rect(min(max(0, x), width - w), min(max(0, y), height - h), w, h)


def _intersects(a: Rect, b: Rect) -> bool:
    return a.x < b.x + b.w and b.x < a.x + a.w and a.y < b.y + b.h and b.y < a.y + a.h


def layout(scene: Scene, width: int, height: int, aigc_box: tuple[int, int, int, int], margin: int) -> tuple[dict[str, Rect], list[str]]:
    """Rectangles of the product card, price sticker and caption for a width x height frame.

    Every returned rectangle lies inside the frame and does not intersect `aigc_box` (x, y, w, h of the AIGC label)
    grown by `margin` on all sides. A layer that would intersect it is left out of the first result and named in
    the second (reason LAYER_CONFLICT). The background is a full-frame base layer and takes no part in this.
    Pure function: the same input gives the same output.
    """
    if not _is_int(width) or not _is_int(height) or width <= 0 or height <= 0:
        raise OverlayError("frame_invalid", "frame size must be positive")
    margin = max(0, int(margin))
    box_x, box_y, box_w, box_h = aigc_box
    forbidden = Rect(box_x - margin, box_y - margin, box_w + 2 * margin, box_h + 2 * margin)
    edge = max(1, round(min(width, height) * EDGE_FRACTION))
    gap = max(1, round(height * GAP_FRACTION))
    candidates: dict[str, Rect] = {}
    card_rect = None
    if scene.product_card is not None:
        card_w, card_h = max(1, round(width * CARD_WIDTH_FRACTION)), max(1, round(height * CARD_HEIGHT_FRACTION))
        anchor = scene.product_card.anchor
        x = edge if anchor.endswith("left") else width - card_w - edge
        y = edge if anchor.startswith("top") else height - card_h - edge if anchor.startswith("bottom") else (height - card_h) // 2
        card_rect = candidates["product_card"] = _clamp(x, y, card_w, card_h, width, height)
    if scene.price_sticker is not None and card_rect is not None:
        sticker_h = max(1, round(height * STICKER_HEIGHT_FRACTION))
        above = scene.product_card.anchor.startswith("bottom")
        y = card_rect.y - sticker_h - gap if above else card_rect.y + card_rect.h + gap
        candidates["price_sticker"] = _clamp(card_rect.x, y, card_rect.w, sticker_h, width, height)
    if scene.caption_enabled:
        caption_w, caption_h = max(1, round(width * CAPTION_WIDTH_FRACTION)), max(1, round(height * CAPTION_HEIGHT_FRACTION))
        y = edge if scene.caption_position == "top_band" else height - caption_h - edge
        candidates["caption"] = _clamp((width - caption_w) // 2, y, caption_w, caption_h, width, height)
    rects: dict[str, Rect] = {}
    excluded: list[str] = []
    for name in LAYERS:
        rect = candidates.get(name)
        if rect is None:
            continue
        if _intersects(rect, forbidden):
            excluded.append(name)
        else:
            rects[name] = rect
    return rects, excluded


def layout_margin(width: int, height: int) -> int:
    return max(1, round(min(width, height) * LAYOUT_MARGIN_FRACTION))


# ─── captions ─────────────────────────────────────────────────────────────────────────────────────


def parse_caption(raw) -> tuple[str, tuple[Cue, ...]]:
    """Validates the `shuzhiren_caption` form field; raises OverlayError(reason). Returns (caption_id, cues)."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            raise OverlayError("caption_invalid") from None
    if not isinstance(raw, str):
        raise OverlayError("caption_invalid")
    try:
        if len(raw.encode("utf-8")) > MAX_CAPTION_FORM_BYTES:
            raise OverlayError("caption_too_large")
    except UnicodeEncodeError:
        raise OverlayError("caption_invalid") from None
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        raise OverlayError("caption_invalid") from None
    data = _object(data, "caption_invalid")
    caption_id = data.get("id")
    if not isinstance(caption_id, str) or not _CAPTION_ID.fullmatch(caption_id):
        raise OverlayError("caption_invalid")
    cues = data.get("cues")
    if not isinstance(cues, list) or len(cues) > MAX_CUES:
        raise OverlayError("caption_invalid")
    parsed = []
    for cue in cues:
        cue = _object(cue, "caption_invalid")
        start, end = cue.get("start_ms"), cue.get("end_ms")
        if not _is_int(start) or not _is_int(end) or not 0 <= start <= end <= MAX_CUE_MS:
            raise OverlayError("caption_invalid")
        parsed.append(Cue(_text(cue.get("text"), "caption_invalid", MAX_CUE_TEXT_CHARS), start, end))
    return caption_id, tuple(parsed)


class _CaptionEntry:
    __slots__ = ("cues", "elapsed_ms")

    def __init__(self, cues: Sequence[Cue]) -> None:
        self.cues = tuple(cues)
        self.elapsed_ms = 0

    def text_at(self, elapsed_ms: int) -> str | None:
        for cue in self.cues:
            if cue.start_ms <= elapsed_ms < cue.end_ms:
                return cue.text
        return None


class CaptionTrack:
    """Caption time follows the audio frames that carry the caption id, never the wall clock.

    Each audio frame event point (userdata) stands for FRAME_MS of audio. A point carrying a registered
    `shuzhiren_caption_id` advances that caption by FRAME_MS and selects the cue covering its new position; any other
    point adds FRAME_MS of silence, and CLEAR_AFTER_MS of consecutive silence clears the caption. A point whose
    status is "end" unregisters its id. At most MAX_CAPTION_IDS ids are kept, the oldest is dropped first.
    """

    FRAME_MS = FRAME_MS
    CLEAR_AFTER_MS = CLEAR_AFTER_MS

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, _CaptionEntry] = OrderedDict()
        self._current: str | None = None
        self._silence_ms = 0

    def register(self, caption_id: str, cues: Sequence[Cue]) -> None:
        with self._lock:
            self._entries.pop(caption_id, None)
            self._entries[caption_id] = _CaptionEntry(cues)
            while len(self._entries) > MAX_CAPTION_IDS:
                self._entries.popitem(last=False)

    def registered_ids(self) -> list[str]:
        with self._lock:
            return list(self._entries)

    def advance(self, userdatas: Sequence) -> str | None:
        with self._lock:
            for userdata in userdatas or ():
                caption_id = userdata.get("shuzhiren_caption_id") if isinstance(userdata, dict) else None
                entry = self._entries.get(caption_id) if isinstance(caption_id, str) else None
                if entry is None:
                    self._silence_ms += self.FRAME_MS
                    if self._silence_ms >= self.CLEAR_AFTER_MS:
                        self._current = None
                    continue
                entry.elapsed_ms += self.FRAME_MS
                self._current = entry.text_at(entry.elapsed_ms)
                self._silence_ms = 0
                if userdata.get("status") == "end":
                    del self._entries[caption_id]
            return self._current


# ─── drawing ──────────────────────────────────────────────────────────────────────────────────────


def _imaging():
    try:
        import numpy
        from PIL import Image, ImageDraw
    except ImportError as error:
        raise OverlayError("dependency_missing", f"numpy and Pillow are required ({error.name or 'import failed'})") from None
    return numpy, Image, ImageDraw


def _fit_font(text: str, max_w: int, max_h: int, font_file: str, start: int):
    """Largest font (down to MIN_FONT_PX) in which `text` fits max_w x max_h; the text is cut with an ellipsis at the floor."""
    size = max(MIN_FONT_PX, start)
    while True:
        font = aigc._font(font_file, size)  # shared, cached face loader of the label module
        left, top, right, bottom = font.getbbox(text)
        if right - left <= max_w and bottom - top <= max_h:
            return font, text
        if size > MIN_FONT_PX:
            size = max(MIN_FONT_PX, int(size * 0.85))
        elif len(text) <= 1:
            return font, text
        else:
            text = text[:-2] + "…" if len(text) > 2 else text[:1]


def _printable(text: str, font_file: str) -> str:
    """Drops characters the font has no glyph for (they would be drawn as boxes)."""
    try:
        missing = set(aigc.missing_glyphs(text, font_file))
    except Exception:  # noqa: BLE001 - a font probe failure must not stop the panel from drawing
        return text
    return "".join(character for character in text if character not in missing)


def _panel(width: int, height: int, color: tuple[int, int, int, int]):
    numpy, Image, ImageDraw = _imaging()
    image = Image.new("RGBA", (width, height), color)
    return image, ImageDraw.Draw(image)


def _finish(image):
    numpy, _, _ = _imaging()
    bitmap = numpy.array(image, dtype=numpy.uint8)
    bitmap.setflags(write=False)
    return bitmap


@lru_cache(maxsize=16)
def _card_bitmap(title: str, width: int, height: int, font_file: str):
    image, draw = _panel(width, height, (0, 0, 0, 166))
    pad = max(1, round(height * 0.12))
    text = _printable(title, font_file)
    if text:
        font, text = _fit_font(text, max(1, width - 2 * pad), max(1, height - 2 * pad), font_file, int(height * 0.45))
        draw.text((width / 2, height / 2), text, font=font, fill=(255, 255, 255, 255), anchor="mm")
    return _finish(image)


@lru_cache(maxsize=16)
def _price_bitmap(price_text: str, note: str, width: int, height: int, font_file: str):
    image, draw = _panel(width, height, (214, 40, 40, 235))
    pad = max(1, round(height * 0.1))
    price = _printable(price_text, font_file)
    note = _printable(note, font_file) if note else ""
    price_h = max(1, round(height * 0.62)) if note else max(1, height - 2 * pad)
    if price:
        font, price = _fit_font(price, max(1, width - 2 * pad), max(1, price_h - pad), font_file, int(height * 0.55))
        draw.text((width / 2, (price_h + pad) / 2 if note else height / 2), price, font=font, fill=(255, 255, 255, 255), anchor="mm")
    if note:
        note_h = max(1, height - price_h - pad)
        font, note = _fit_font(note, max(1, width - 2 * pad), note_h, font_file, int(height * 0.22))
        draw.text((width / 2, price_h + note_h / 2), note, font=font, fill=(255, 255, 255, 255), anchor="mm")
    return _finish(image)


@lru_cache(maxsize=64)
def _caption_bitmap(text: str, width: int, height: int, font_file: str):
    image, draw = _panel(width, height, (0, 0, 0, 140))
    pad = max(1, round(height * 0.1))
    text = _printable(text, font_file)
    if text:
        font, text = _fit_font(text, max(1, width - 2 * pad), max(1, height - 2 * pad), font_file, int(height * 0.6))
        draw.text((width / 2, height / 2), text, font=font, fill=(255, 255, 255, 255), anchor="mm")
    return _finish(image)


def _paste(out, bitmap, rect: Rect, bgr: bool) -> None:
    """Alpha-blends an RGBA bitmap of rect size into `out` (a frame this call owns) in place."""
    numpy, _, _ = _imaging()
    region = out[rect.y:rect.y + rect.h, rect.x:rect.x + rect.w, :3]
    alpha = bitmap[..., 3:4].astype(numpy.float32) / 255.0
    color = bitmap[..., :3][..., ::-1] if bgr else bitmap[..., :3]
    region[...] = numpy.clip(region.astype(numpy.float32) * (1.0 - alpha) + color.astype(numpy.float32) * alpha + 0.5, 0, 255).astype(numpy.uint8)


class _AssetError(Exception):
    pass


def _read_asset(asset_dir: str, sha256: str) -> bytes:
    for extension in (".png", ".jpg"):
        path = os.path.join(asset_dir, sha256 + extension)
        try:
            with open(path, "rb") as handle:
                data = handle.read(MAX_ASSET_BYTES + 1)
        except OSError:
            continue
        if len(data) > MAX_ASSET_BYTES:
            raise _AssetError("asset_too_large")
        if hashlib.sha256(data).hexdigest() != sha256:
            raise _AssetError("asset_hash_mismatch")
        return data
    raise _AssetError("asset_missing")


@lru_cache(maxsize=4)
def _background_image(asset_dir: str, sha256: str, width: int, height: int, bgr: bool):
    """The asset scaled to cover width x height, as an H x W x 3 array in the frame's channel order, or None.

    Cached by (asset, frame size); a failure is cached too, so a missing asset is not re-read for every frame.
    """
    try:
        numpy, Image, _ = _imaging()
        data = _read_asset(asset_dir, sha256)
        image = Image.open(io.BytesIO(data))
        if image.format not in ("PNG", "JPEG"):
            raise _AssetError("asset_format")
        if not 0 < image.width <= MAX_ASSET_SIDE or not 0 < image.height <= MAX_ASSET_SIDE:
            raise _AssetError("asset_size")
        image = image.convert("RGB")
        scale = max(width / image.width, height / image.height)
        scaled_w, scaled_h = max(width, round(image.width * scale)), max(height, round(image.height * scale))
        image = image.resize((scaled_w, scaled_h), Image.Resampling.BILINEAR)
        left, top = (scaled_w - width) // 2, (scaled_h - height) // 2
        array = numpy.asarray(image.crop((left, top, left + width, top + height)), dtype=numpy.uint8)
        array = numpy.ascontiguousarray(array[..., ::-1]) if bgr else array.copy()
        array.setflags(write=False)
        return array
    except _AssetError as error:
        logger.warning("overlay background unavailable: %s", error)
    except Exception as error:  # noqa: BLE001 - any decode failure closes the background layer
        logger.warning("overlay background unavailable: %s", type(error).__name__)
    return None


def _apply_canvas(frame, background, image):
    numpy, Image, _ = _imaging()
    height, width = frame.shape[:2]
    scale = background.avatar_scale_permille / 1000.0
    scaled_w, scaled_h = max(1, round(width * scale)), max(1, round(height * scale))
    scaled = numpy.asarray(Image.fromarray(numpy.ascontiguousarray(frame)).resize((scaled_w, scaled_h), Image.Resampling.BILINEAR))
    left = {"left": 0, "center": (width - scaled_w) // 2, "right": width - scaled_w}[background.avatar_anchor]
    out = numpy.empty_like(frame)
    out[..., :3] = image
    if frame.shape[2] == 4:
        out[..., 3] = 255
    out[height - scaled_h:, left:left + scaled_w] = scaled
    return out


def _apply_chroma_key(frame, background, image, bgr: bool):
    numpy, _, _ = _imaging()
    key = background.key_color[::-1] if bgr else background.key_color
    difference = numpy.abs(frame[..., :3].astype(numpy.int16) - numpy.array(key, dtype=numpy.int16)).max(axis=2)
    mask = difference <= background.tolerance
    out = frame.copy()
    out[..., :3][mask] = image[mask]
    return out


# ─── scene state and composition ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SceneState:
    """A parsed scene plus the caches that depend on it. Replaced as a whole by SessionOverlay.set_scene."""

    scene: Scene
    aigc_config: aigc.LabelConfig
    asset_dir: str
    bgr: bool = True
    _layouts: dict = field(default_factory=dict, compare=False, repr=False)
    _diagnostics: dict = field(default_factory=lambda: {"excluded": (), "background_unavailable": False}, compare=False, repr=False)

    def layout_for(self, width: int, height: int) -> tuple[dict[str, Rect], list[str]]:
        key = (width, height)
        cached = self._layouts.get(key)
        if cached is None:
            box = aigc.label_box(self.aigc_config, width, height)
            cached = layout(self.scene, width, height, box, layout_margin(width, height))
            if len(self._layouts) >= 8:
                self._layouts.clear()
            self._layouts[key] = cached
        self._diagnostics["excluded"] = tuple(cached[1])
        return cached[0], list(cached[1])

    def background_image(self, width: int, height: int):
        background = self.scene.background
        if background is None:
            return None
        image = _background_image(self.asset_dir, background.asset_sha256, width, height, self.bgr)
        self._diagnostics["background_unavailable"] = image is None
        return image

    def price_expired(self, now: datetime) -> bool:
        sticker = self.scene.price_sticker
        return sticker is not None and sticker.valid_until is not None and now > sticker.valid_until

    def reasons(self) -> list[str]:
        reasons = []
        if self._diagnostics["excluded"]:
            reasons.append(LAYER_CONFLICT)
        if self._diagnostics["background_unavailable"]:
            reasons.append(BACKGROUND_UNAVAILABLE)
        return reasons

    @property
    def excluded_layers(self) -> tuple[str, ...]:
        return self._diagnostics["excluded"]

    def font_file(self) -> str:
        return self.aigc_config.font_file or aigc.resolve_font_file(None)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def compose(frame, state: SceneState | None, caption_text: str | None, now: datetime):
    """Draws background, product card, price sticker and caption (in this order) and returns the result.

    The input frame is never modified; with no scene, or nothing to draw, the input itself is returned. The AIGC
    label is not drawn here, the caller applies it to the result.
    """
    if state is None:
        return frame
    numpy, _, _ = _imaging()
    if not isinstance(frame, numpy.ndarray) or frame.dtype != numpy.uint8 or frame.ndim != 3 or frame.shape[2] not in (3, 4) or frame.shape[0] == 0 or frame.shape[1] == 0:
        raise OverlayError("frame_invalid", "frame must be a uint8 array of shape (H, W, 3|4)")
    height, width = frame.shape[:2]
    scene = state.scene
    rects, _ = state.layout_for(width, height)
    out = frame
    background = scene.background
    if background is not None:
        image = state.background_image(width, height)
        if image is not None:
            out = _apply_canvas(frame, background, image) if background.mode == "canvas" else _apply_chroma_key(frame, background, image, state.bgr)
    layers = []
    if "product_card" in rects:
        layers.append(("card", rects["product_card"]))
    if "price_sticker" in rects and not state.price_expired(now):
        layers.append(("price", rects["price_sticker"]))
    if caption_text and scene.caption_enabled and "caption" in rects:
        layers.append(("caption", rects["caption"]))
    if layers:
        if out is frame:
            out = frame.copy()
        font_file = state.font_file()
        for kind, rect in layers:
            if kind == "card":
                bitmap = _card_bitmap(scene.product_card.title, rect.w, rect.h, font_file)
            elif kind == "price":
                bitmap = _price_bitmap(scene.price_sticker.price_text, scene.price_sticker.note or "", rect.w, rect.h, font_file)
            else:
                bitmap = _caption_bitmap(caption_text, rect.w, rect.h, font_file)
            _paste(out, bitmap, rect, state.bgr)
    return out


_SESSIONS: "weakref.WeakSet[SessionOverlay]" = weakref.WeakSet()
_SESSIONS_LOCK = threading.Lock()


class SessionOverlay:
    """Picture layer state of one LiveTalking session.

    The scene is an immutable SceneState replaced atomically by set_scene(); compose() reads it once per frame.
    """

    def __init__(self, aigc_label, *, asset_dir: str | None = None, channel_order: str = "bgr", clock: Callable[[], datetime] = utc_now) -> None:
        if channel_order not in ("bgr", "rgb"):
            raise OverlayError("channel_order_invalid")
        self.aigc_label = aigc_label
        self._asset_dir = asset_dir
        self._bgr = channel_order == "bgr"
        self._clock = clock
        self.captions = CaptionTrack()
        self.scene_state: SceneState | None = None
        self._lock = threading.Lock()
        self.frames_composed = 0
        self.frames_overlay_failed = 0
        self.captions_ignored = 0
        self.last_error: str | None = None
        self._last_error_at = 0.0
        self._compose_ms: deque[float] = deque(maxlen=512)
        with _SESSIONS_LOCK:
            _SESSIONS.add(self)

    def set_scene(self, scene_json: str, scene_sha256: str) -> Scene:
        """Validates and installs a scene; on failure raises OverlayError and keeps the current scene."""
        scene = parse_scene(scene_json, scene_sha256)
        asset_dir = self._asset_dir or os.environ.get(ENV_ASSET_DIR) or DEFAULT_ASSET_DIR
        state = SceneState(scene, self.aigc_label.config, asset_dir, self._bgr)
        _background_image.cache_clear()  # a re-sent scene retries an asset that was missing before
        self.scene_state = state
        with self._lock:
            self.last_error = None
        return scene

    def register_caption(self, raw) -> str | None:
        """Registers the caption field of a /humanaudio request; returns its id, or None (and counts it) when invalid."""
        try:
            caption_id, cues = parse_caption(raw)
        except OverlayError:
            with self._lock:
                self.captions_ignored += 1
            return None
        self.captions.register(caption_id, cues)
        return caption_id

    def compose(self, frame, userdatas):
        started = time.perf_counter()
        caption_text = self.captions.advance(userdatas)  # advance first so the timeline holds even if drawing fails
        state = self.scene_state
        if state is None:
            return frame
        out = compose(frame, state, caption_text, self._clock())  # the module-level function
        reasons = state.reasons()
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        with self._lock:
            self.frames_composed += 1
            self.last_error = reasons[0] if reasons else None
            if reasons:
                self._last_error_at = time.monotonic()
            self._compose_ms.append(elapsed_ms)
        return out

    def record_failure(self, error: BaseException) -> None:
        with self._lock:
            self.frames_overlay_failed += 1
            self.last_error = getattr(error, "reason", type(error).__name__)
            self._last_error_at = time.monotonic()

    def status(self) -> dict:
        state = self.scene_state
        with self._lock:
            samples = sorted(self._compose_ms)
            return {
                "scene_sha256": state.scene.sha256 if state else None,
                "frames_composed": self.frames_composed,
                "frames_overlay_failed": self.frames_overlay_failed,
                "captions_ignored": self.captions_ignored,
                "layer_conflicts": list(state.excluded_layers) if state else [],
                "last_error": self.last_error,
                "compose_ms_p95": _p95(samples),
            }


def _p95(sorted_samples: Sequence[float]) -> float | None:
    if not sorted_samples:
        return None
    return round(sorted_samples[min(len(sorted_samples) - 1, int(len(sorted_samples) * 0.95))], 3)


def register_caption(avatar_session, raw) -> str | None:
    """Route helper: registers the caption on avatar_session.overlay; None when absent, invalid or there is no overlay."""
    overlay = getattr(avatar_session, "overlay", None)
    return overlay.register_caption(raw) if overlay is not None else None


def render_output_frame(overlay, aigc_label, frame, userdatas):
    """The frame LiveTalking pushes and records: picture layers first, the AIGC label last.

    A picture layer failure is recorded and the label is drawn on the frame without the picture layer. An exception
    from aigc_label.apply() propagates, the caller drops the frame (as before this patch).
    """
    try:
        composed = overlay.compose(frame, userdatas)
    except Exception as error:  # noqa: BLE001 - whatever the picture layer raises must not cost the frame
        try:
            overlay.record_failure(error)
        except Exception:  # noqa: BLE001
            pass
        composed = frame
    return aigc_label.apply(composed)


def status() -> dict:
    """Process-wide picture layer state for GET /api/admin/overlay."""
    with _SESSIONS_LOCK:
        sessions = list(_SESSIONS)
    per_session = [(session, session.status()) for session in sessions]
    samples = sorted(sample for session in sessions for sample in list(session._compose_ms))
    latest = max((session for session, info in per_session if info["last_error"]), key=lambda session: session._last_error_at, default=None)
    conflicts = sorted({layer for _, info in per_session for layer in info["layer_conflicts"]})
    return {
        "supported": True,
        "aigc_position": aigc.status().get("position"),
        "active_sessions": len(sessions),
        "frames_composed": sum(info["frames_composed"] for _, info in per_session),
        "frames_overlay_failed": sum(info["frames_overlay_failed"] for _, info in per_session),
        "captions_ignored": sum(info["captions_ignored"] for _, info in per_session),
        "layer_conflicts": conflicts,
        "last_error": latest.last_error if latest is not None else None,
        "compose_ms_p95": _p95(samples),
    }
