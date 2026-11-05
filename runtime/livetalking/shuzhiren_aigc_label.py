"""AIGC explicit label for the Shuzhiren LiveTalking image.

The 人工智能生成合成内容标识办法 (in force since 2025-09-01) requires a visible
label on AI generated video. LiveTalking draws this label on every frame it
pushes or records (runtime/patches/livetalking-aigc-label.patch); there is no
switch that turns it off.

Configuration (environment of the LiveTalking container):
  AIGC_LABEL_ENABLED   must be absent or "true"; any other value refuses to start.
  AIGC_LABEL_TEXT      label text; empty or absent falls back to DEFAULT_TEXT.
                       At most MAX_TEXT_LENGTH characters, no control
                       characters, and it must contain "AI" or "人工智能".
  AIGC_LABEL_POSITION  one of POSITIONS; empty or absent falls back to
                       DEFAULT_POSITION.
  AIGC_LABEL_FONT_FILE optional font file; otherwise the first existing file of
                       FONT_CANDIDATES (fonts-noto-cjk in the image).

apply_aigc_label(frame, config) is the pure drawing function: it returns a new
frame and never modifies its input. The text is rendered with Pillow (OpenCV's
Hershey fonts have no CJK glyphs); every character must have a real glyph in the
font, otherwise the label is refused instead of drawn as empty boxes.

This module imports numpy and Pillow lazily, so importing it (for status()) only
needs the standard library.
"""

from __future__ import annotations

import os
import threading
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Mapping

ENV_ENABLED = "AIGC_LABEL_ENABLED"
ENV_TEXT = "AIGC_LABEL_TEXT"
ENV_POSITION = "AIGC_LABEL_POSITION"
ENV_FONT_FILE = "AIGC_LABEL_FONT_FILE"
DEFAULT_TEXT = "本直播由AI数字人生成"
POSITIONS = ("top-left", "top-right", "bottom-left", "bottom-right")
DEFAULT_POSITION = "top-right"
MAX_TEXT_LENGTH = 32
FONT_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
)
AIGC_LABEL_EXIT_CODE = 78  # EX_CONFIG, the same code as an unusable stream key file

# Text height is 5% of the shorter frame side (at least MIN_FONT_PX); the box
# padding and the distance from the frame edge scale with it.
FONT_FRACTION = 0.05
MIN_FONT_PX = 12
SMALLEST_FONT_PX = 6
PADDING_FRACTION = 0.3
MARGIN_FRACTION = 0.02
BACKGROUND_ALPHA = 0.6
TEXT_VALUE = 255
BACKGROUND_VALUE = 0


class AigcLabelError(Exception):
    """The label cannot be drawn. `reason` is a short machine-readable category."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(f"AIGC label {reason}: {detail}")
        self.reason = reason


@dataclass(frozen=True)
class LabelConfig:
    text: str = DEFAULT_TEXT
    position: str = DEFAULT_POSITION
    font_file: str | None = None


def normalize_text(value: str | None) -> str:
    """Empty or absent text falls back to DEFAULT_TEXT; anything else is validated."""
    text = (value or "").strip()
    if not text:
        return DEFAULT_TEXT
    if len(text) > MAX_TEXT_LENGTH:
        raise AigcLabelError("text_invalid", f"{ENV_TEXT} is longer than {MAX_TEXT_LENGTH} characters")
    if any(unicodedata.category(character).startswith("C") for character in text):
        raise AigcLabelError("text_invalid", f"{ENV_TEXT} contains control or unassigned characters")
    if "AI" not in text.upper() and "人工智能" not in text:
        raise AigcLabelError("text_invalid", f"{ENV_TEXT} must state the content is AI generated (contain \"AI\" or \"人工智能\")")
    return text


def normalize_position(value: str | None) -> str:
    position = (value or "").strip().lower()
    if not position:
        return DEFAULT_POSITION
    if position not in POSITIONS:
        raise AigcLabelError("position_invalid", f"{ENV_POSITION} must be one of {', '.join(POSITIONS)}")
    return position


def resolve_font_file(configured: str | None) -> str:
    if configured:
        if not os.path.isfile(configured):
            raise AigcLabelError("font_missing", f"{ENV_FONT_FILE} {configured} does not exist")
        return configured
    for candidate in FONT_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    raise AigcLabelError("font_missing", f"no CJK font found (install fonts-noto-cjk or set {ENV_FONT_FILE})")


def config_from_env(environ: Mapping[str, str] | None = None) -> LabelConfig:
    """Reads and validates the label configuration; raises AigcLabelError (fail closed)."""
    environ = os.environ if environ is None else environ
    enabled = environ.get(ENV_ENABLED)
    if enabled is not None and enabled.strip().lower() != "true":
        raise AigcLabelError("disabled", f"{ENV_ENABLED} must be true; the AIGC label cannot be turned off")
    return LabelConfig(
        text=normalize_text(environ.get(ENV_TEXT)),
        position=normalize_position(environ.get(ENV_POSITION)),
        font_file=resolve_font_file(environ.get(ENV_FONT_FILE) or None),
    )


def _imaging():
    try:
        import numpy
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise AigcLabelError("dependency_missing", f"numpy and Pillow are required ({error.name or 'import failed'})") from None
    return numpy, Image, ImageDraw, ImageFont


def _face_index(font_file: str) -> int:
    """Simplified Chinese face of a CJK font collection (.ttc); 0 for a single font."""
    if not font_file.lower().endswith((".ttc", ".otc")):
        return 0
    _, _, _, ImageFont = _imaging()
    for index in range(16):
        try:
            family = ImageFont.truetype(font_file, 16, index=index).getname()[0]
        except OSError:
            break
        if family.rstrip().endswith("SC"):
            return index
    return 0


@lru_cache(maxsize=64)
def _font(font_file: str, size: int):
    _, _, _, ImageFont = _imaging()
    try:
        return ImageFont.truetype(font_file, size, index=_face_index(font_file))
    except OSError as error:
        raise AigcLabelError("font_unreadable", f"{font_file} cannot be loaded ({type(error).__name__})") from None


def _glyph_mask(font, text: str):
    numpy, Image, ImageDraw, _ = _imaging()
    left, top, right, bottom = font.getbbox(text)
    width, height = max(1, right - left), max(1, bottom - top)
    image = Image.new("L", (width, height), 0)
    ImageDraw.Draw(image).text((-left, -top), text, font=font, fill=255)
    return numpy.asarray(image)


def missing_glyphs(text: str, font_file: str) -> list[str]:
    """Characters the font draws as its .notdef box (or not at all)."""
    numpy, _, _, _ = _imaging()
    font = _font(font_file, 32)
    notdef = _glyph_mask(font, "\U0010FFFD")
    missing = []
    for character in dict.fromkeys(text):
        if character.isspace():
            continue
        mask = _glyph_mask(font, character)
        if not mask.any() or (mask.shape == notdef.shape and numpy.array_equal(mask, notdef)):
            missing.append(character)
    return missing


@lru_cache(maxsize=32)
def _overlay(config: LabelConfig, width: int, height: int):
    """(x, y, alpha, value) of the label for a width x height frame; alpha and value are float32 arrays."""
    numpy, _, _, _ = _imaging()
    font_file = config.font_file or resolve_font_file(None)
    shorter = min(width, height)
    size = max(MIN_FONT_PX, round(shorter * FONT_FRACTION))
    margin = max(1, round(shorter * MARGIN_FRACTION))
    while True:
        font = _font(font_file, size)
        mask = _glyph_mask(font, config.text)
        padding = max(1, round(size * PADDING_FRACTION))
        box_height, box_width = mask.shape[0] + 2 * padding, mask.shape[1] + 2 * padding
        # Shrink the font until the label fits the frame; below SMALLEST_FONT_PX the label is cropped instead.
        if (box_width + 2 * margin <= width and box_height + 2 * margin <= height) or size <= SMALLEST_FONT_PX:
            break
        size = max(SMALLEST_FONT_PX, int(size * 0.85))
    text_alpha = numpy.zeros((box_height, box_width), dtype=numpy.float32)
    text_alpha[padding:padding + mask.shape[0], padding:padding + mask.shape[1]] = mask.astype(numpy.float32) / 255.0
    # Text over a translucent dark box: alpha = a_b + a_t (1 - a_b), premultiplied value = 255 a_t.
    alpha = BACKGROUND_ALPHA + text_alpha * (1.0 - BACKGROUND_ALPHA)
    value = (TEXT_VALUE * text_alpha + BACKGROUND_VALUE * BACKGROUND_ALPHA * (1.0 - text_alpha)).astype(numpy.float32)
    box_width, box_height = min(box_width, width), min(box_height, height)
    alpha, value = alpha[:box_height, :box_width], value[:box_height, :box_width]
    margin_x = margin if box_width + 2 * margin <= width else max(0, (width - box_width) // 2)
    margin_y = margin if box_height + 2 * margin <= height else max(0, (height - box_height) // 2)
    x = margin_x if config.position.endswith("left") else width - box_width - margin_x
    y = margin_y if config.position.startswith("top") else height - box_height - margin_y
    alpha.setflags(write=False)
    value.setflags(write=False)
    return x, y, alpha, value


def label_box(config: LabelConfig, width: int, height: int) -> tuple[int, int, int, int]:
    """(x, y, width, height) of the label area in a width x height frame."""
    x, y, alpha, _ = _overlay(config, width, height)
    return x, y, alpha.shape[1], alpha.shape[0]


def apply_aigc_label(frame, config: LabelConfig = LabelConfig()):
    """Returns a copy of `frame` (uint8, H x W, H x W x 1, 3 or 4) with the AIGC label drawn on it.

    The label is white text on a translucent dark box, so it stays readable on
    any picture. The input frame is not modified.
    """
    numpy, _, _, _ = _imaging()
    if not isinstance(frame, numpy.ndarray) or frame.dtype != numpy.uint8 or frame.ndim not in (2, 3) or (frame.ndim == 3 and frame.shape[2] not in (1, 3, 4)):
        raise AigcLabelError("frame_invalid", "frame must be a uint8 array of shape (H, W) or (H, W, 1|3|4)")
    height, width = frame.shape[:2]
    result = frame.copy()
    if width == 0 or height == 0:
        return result
    x, y, alpha, value = _overlay(config, width, height)
    h, w = alpha.shape
    region = result[y:y + h, x:x + w]
    color = region if region.ndim == 2 else region[..., :3]
    a = alpha if color.ndim == 2 else alpha[..., None]
    v = value if color.ndim == 2 else value[..., None]
    color[...] = numpy.clip(color.astype(numpy.float32) * (1.0 - a) + v + 0.5, 0, 255).astype(numpy.uint8)
    return result


class AigcLabelRenderer:
    """Process-wide label state: validated configuration, frame counters, last error."""

    def __init__(self, config: LabelConfig) -> None:
        numpy, _, _, _ = _imaging()
        missing = missing_glyphs(config.text, config.font_file or resolve_font_file(None))
        if missing:
            raise AigcLabelError("glyph_missing", f"font {os.path.basename(config.font_file or '')} has no glyph for {''.join(missing)!r}")
        probe = numpy.zeros((720, 1280, 3), dtype=numpy.uint8)
        if numpy.array_equal(apply_aigc_label(probe, config), probe):
            raise AigcLabelError("render_failed", "the label left a test frame unchanged")
        self.config = config
        self._lock = threading.Lock()
        self.frames_labelled = 0
        self.frames_dropped = 0
        self.last_error: str | None = None

    def apply(self, frame):
        try:
            labelled = apply_aigc_label(frame, self.config)
        except Exception as error:
            with self._lock:
                self.frames_dropped += 1
                self.last_error = getattr(error, "reason", type(error).__name__)
            raise
        with self._lock:
            self.frames_labelled += 1
            self.last_error = None
        return labelled

    def status(self) -> dict:
        with self._lock:
            return {
                "enabled": self.last_error is None,
                "text": self.config.text,
                "position": self.config.position,
                "font": os.path.basename(self.config.font_file or ""),
                "frames_labelled": self.frames_labelled,
                "frames_dropped": self.frames_dropped,
                "last_error": self.last_error,
            }


_renderer: AigcLabelRenderer | None = None
_renderer_error: AigcLabelError | None = None
_renderer_lock = threading.Lock()


def process_renderer() -> AigcLabelRenderer:
    """The renderer of this process, built once from the environment; raises AigcLabelError when it cannot be built."""
    global _renderer, _renderer_error
    with _renderer_lock:
        if _renderer is None and _renderer_error is None:
            try:
                _renderer = AigcLabelRenderer(config_from_env())
            except AigcLabelError as error:
                _renderer_error = error
        if _renderer_error is not None:
            raise _renderer_error
        return _renderer


def status() -> dict:
    """Label state for the runtime metrics and health endpoints. Anything but a working renderer reports enabled false."""
    try:
        return process_renderer().status()
    except AigcLabelError as error:
        return {"enabled": False, "text": None, "position": None, "font": None, "frames_labelled": 0, "frames_dropped": 0, "last_error": error.reason}
