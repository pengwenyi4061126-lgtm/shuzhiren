"""Behavior tests for the picture layer of the LiveTalking image (shuzhiren_overlay.py).

Usage: python3 runtime/livetalking/tests/test_overlay.py [--require-imaging]

Scene and caption parsing, layout, CaptionTrack and render_output_frame need only the standard library. The drawing
tests need numpy, Pillow and a font with CJK glyphs (AIGC_LABEL_TEST_FONT, the image's fonts-noto-cjk path, or a
common Windows, macOS or Linux CJK font); without them they print SKIP. --require-imaging, or the environment
variable AIGC_LABEL_REQUIRE_IMAGING=true, turns that SKIP into a failure. This directory is excluded from the image
build context.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MODULE_DIR))

import shuzhiren_aigc_label as aigc  # noqa: E402
import shuzhiren_overlay as overlay  # noqa: E402

CJK_FONT_CANDIDATES = (
    *aigc.FONT_CANDIDATES,
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/NotoSansSC-VF.ttf",
    "C:/Windows/Fonts/simhei.ttf",
)

PRICE_VALID_UNTIL = "2026-11-30T16:00:00.000Z"
BEFORE_EXPIRY = datetime(2026, 11, 30, 15, 0, tzinfo=timezone.utc)
AFTER_EXPIRY = datetime(2026, 11, 30, 17, 0, tzinfo=timezone.utc)
SHA_A = "a" * 64


def passed(message: str) -> None:
    print(f"PASS  {message}", flush=True)


def skipped(message: str, required: bool) -> None:
    if required:
        raise AssertionError(f"required but unavailable: {message}")
    print(f"SKIP  {message}", flush=True)


def first_existing(candidates) -> str | None:
    configured = os.environ.get("AIGC_LABEL_TEST_FONT")
    if configured:
        return configured if os.path.isfile(configured) else None
    return next((candidate for candidate in candidates if os.path.isfile(candidate)), None)


def expect_error(reason: str, action) -> None:
    try:
        action()
    except overlay.OverlayError as error:
        assert error.reason == reason, f"expected {reason}, got {error.reason}: {error}"
        return
    raise AssertionError(f"expected OverlayError({reason})")


def scene_doc(**changes) -> dict:
    document = {
        "version": 1,
        "revisionId": "rev-1",
        "caption": {"enabled": True, "position": "bottom_band"},
        "productCard": {"anchor": "middle-right", "title": "洁面慕斯 120ml"},
        "priceSticker": {"priceText": "¥99.00", "note": "价格以下单页为准", "validUntil": PRICE_VALID_UNTIL},
        "background": {"mode": "none"},
        "product": {"productVersionId": "pv-1", "revision": 3},
    }
    document.update(changes)
    return document


def encode(document) -> tuple[str, str]:
    text = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return text, hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse(document) -> overlay.Scene:
    return overlay.parse_scene(*encode(document))


class FakeLabel:
    """Stands in for the AIGC renderer where no drawing is needed."""

    config = aigc.LabelConfig()

    def __init__(self) -> None:
        self.applied: list = []

    def apply(self, frame):
        self.applied.append(frame)
        return ("labelled", frame)


def test_parse_scene() -> None:
    scene = parse(scene_doc(background={"mode": "canvas", "assetSha256": SHA_A, "avatarAnchor": "left", "avatarScalePermille": 800}))
    assert scene.version == 1 and scene.revision_id == "rev-1" and scene.caption_enabled and scene.caption_position == "bottom_band"
    assert scene.product_card == overlay.ProductCard("middle-right", "洁面慕斯 120ml")
    assert scene.price_sticker.price_text == "¥99.00" and scene.price_sticker.valid_until == datetime(2026, 11, 30, 16, 0, tzinfo=timezone.utc)
    assert scene.background == overlay.Background("canvas", SHA_A, avatar_anchor="left", avatar_scale_permille=800)
    chroma = parse(scene_doc(background={"mode": "chroma_key", "assetSha256": SHA_A, "keyColor": "#00FF00", "tolerance": 40}))
    assert chroma.background.key_color == (0, 255, 0) and chroma.background.tolerance == 40
    minimal = parse({"version": 1, "caption": {"enabled": False, "position": "top_band"}, "productCard": None, "priceSticker": None, "background": None})
    assert minimal.product_card is None and minimal.price_sticker is None and minimal.background is None and not minimal.caption_enabled
    assert parse(scene_doc(background={"mode": "none"})).background is None
    assert parse(scene_doc(priceSticker={"priceText": "¥1.00", "note": None, "validUntil": None})).price_sticker.valid_until is None

    text, digest = encode(scene_doc())
    expect_error("scene_hash_mismatch", lambda: overlay.parse_scene(text, "0" * 64))
    expect_error("scene_hash_mismatch", lambda: overlay.parse_scene(text + " ", digest))
    expect_error("scene_hash_invalid", lambda: overlay.parse_scene(text, digest.upper()))
    expect_error("scene_hash_invalid", lambda: overlay.parse_scene(text, digest[:-1]))
    expect_error("scene_json_invalid", lambda: overlay.parse_scene(None, digest))
    not_json = "not json"
    expect_error("scene_json_invalid", lambda: overlay.parse_scene(not_json, hashlib.sha256(not_json.encode()).hexdigest()))
    array = "[1]"
    expect_error("scene_not_object", lambda: overlay.parse_scene(array, hashlib.sha256(array.encode()).hexdigest()))
    for version in (2, 0, "1", True, None):
        expect_error("scene_version_unsupported", lambda version=version: parse(scene_doc(version=version)))
    expect_error("scene_too_long", lambda: parse(scene_doc(revisionId="r" * overlay.MAX_SCENE_CHARS)))
    bad_caption = [{"enabled": True, "position": "middle"}, {"enabled": "yes", "position": "top_band"}, []]
    for caption in bad_caption:
        expect_error("caption_invalid", lambda caption=caption: parse(scene_doc(caption=caption)))
    for card in ({"anchor": "center", "title": "x"}, {"anchor": "top-left", "title": ""}, {"anchor": "top-left", "title": "x" * 61}, {"anchor": "top-left", "title": "a\nb"}, {"anchor": "top-left"}, "card"):
        expect_error("product_card_invalid", lambda card=card: parse(scene_doc(productCard=card)))
    for sticker in ({"priceText": "", "note": None, "validUntil": None}, {"priceText": "x" * 17, "note": None, "validUntil": None}, {"priceText": "¥1", "note": "n" * 41, "validUntil": None},
                    {"priceText": "¥1", "note": None, "validUntil": "tomorrow"}, {"priceText": "¥1", "note": None, "validUntil": "2026-11-30T16:00:00"}):
        expect_error("price_sticker_invalid", lambda sticker=sticker: parse(scene_doc(priceSticker=sticker)))
    expect_error("price_sticker_requires_product_card", lambda: parse(scene_doc(productCard=None)))
    asset = {"assetSha256": SHA_A}
    for background in ({"mode": "video", **asset}, {"mode": "canvas", **asset, "avatarAnchor": "up", "avatarScalePermille": 800}, {"mode": "canvas", **asset, "avatarAnchor": "left", "avatarScalePermille": 499},
                       {"mode": "canvas", **asset, "avatarAnchor": "left", "avatarScalePermille": 1001}, {"mode": "canvas", **asset, "avatarAnchor": "left", "avatarScalePermille": 800.5},
                       {"mode": "canvas", "assetSha256": "xyz", "avatarAnchor": "left", "avatarScalePermille": 800}, {"mode": "chroma_key", **asset, "keyColor": "00ff00", "tolerance": 10},
                       {"mode": "chroma_key", **asset, "keyColor": "#00ff00", "tolerance": 256}, {"mode": "chroma_key", **asset, "keyColor": "#00ff00", "tolerance": -1}, "canvas"):
        expect_error("background_invalid", lambda background=background: parse(scene_doc(background=background)))
    passed("parse_scene accepts version 1 scenes and refuses wrong hashes, versions, enums, ranges and over-long texts")


def test_caption_track() -> None:
    track = overlay.CaptionTrack()
    track.register("a", [overlay.Cue("你好", 0, 100), overlay.Cue("世界", 100, 200)])
    point = {"shuzhiren_caption_id": "a"}
    assert track.advance([]) is None and track.advance([None, {}]) is None
    assert track.advance([point, point]) == "你好", "two audio frames are 40 ms"
    assert track.advance([point, point]) == "你好" and track.advance([point]) == "世界", "100 ms reaches the second cue"
    assert track.advance([{"shuzhiren_caption_id": "unregistered"}]) == "世界", "an unknown id counts as silence, not as progress"
    for _ in range(13):
        assert track.advance([None]) == "世界", "less than 300 ms of silence keeps the caption"
    assert track.advance([None]) is None, "300 ms without a frame of the caption clears it"
    assert track.advance([point]) == "世界" and track.advance([{**point, "status": "end"}]) == "世界"
    assert track.registered_ids() == [], "an end event point removes the id"
    assert track.advance([point]) == "世界" and track.advance([point] * 14) is None, "frames of an ended id count as silence and clear the caption after 300 ms"

    gaps = overlay.CaptionTrack()
    gaps.register("g", [overlay.Cue("甲", 0, 60), overlay.Cue("乙", 60, 120)])
    gaps.advance([{"shuzhiren_caption_id": "g"}] * 2)
    shown = [gaps.advance([None]) for _ in range(10)]
    assert shown == ["甲"] * 10, "frames without the id never move the time line"
    assert gaps.advance([{"shuzhiren_caption_id": "g"}]) == "乙"

    full = overlay.CaptionTrack()
    for index in range(overlay.MAX_CAPTION_IDS + 1):
        full.register(f"id{index}", [overlay.Cue("字", 0, 100)])
    assert full.registered_ids() == [f"id{index}" for index in range(1, overlay.MAX_CAPTION_IDS + 1)], "the oldest id is evicted first"
    passed("CaptionTrack advances 20 ms per frame of its own id, clears after 300 ms of silence, drops ended ids and keeps 16 ids")


def test_parse_caption_and_register() -> None:
    field = json.dumps({"id": "cmd-1", "cues": [{"text": "欢迎来到直播间", "start_ms": 0, "end_ms": 2000}]}, ensure_ascii=False)
    assert overlay.parse_caption(field) == ("cmd-1", (overlay.Cue("欢迎来到直播间", 0, 2000),))
    assert overlay.parse_caption(field.encode("utf-8"))[0] == "cmd-1"
    assert overlay.parse_caption(json.dumps({"id": "x", "cues": []}))[1] == ()
    huge = json.dumps({"id": "x", "cues": [{"text": "字" * 80, "start_ms": 0, "end_ms": 1}] * 200}, ensure_ascii=False)
    assert len(huge.encode("utf-8")) > overlay.MAX_CAPTION_FORM_BYTES
    expect_error("caption_too_large", lambda: overlay.parse_caption(huge))
    for raw in (None, 5, "nope", "[]", json.dumps({"cues": []}), json.dumps({"id": "bad id", "cues": []}), json.dumps({"id": "x"}),
                json.dumps({"id": "x", "cues": [{"text": "", "start_ms": 0, "end_ms": 1}]}), json.dumps({"id": "x", "cues": [{"text": "a", "start_ms": 5, "end_ms": 1}]}),
                json.dumps({"id": "x", "cues": [{"text": "a", "start_ms": "0", "end_ms": 1}]}), json.dumps({"id": "x", "cues": [{"text": "a" * 81, "start_ms": 0, "end_ms": 1}]}),
                json.dumps({"id": "x", "cues": [{"text": "a", "start_ms": 0, "end_ms": 1}] * 201})):
        expect_error("caption_invalid", lambda raw=raw: overlay.parse_caption(raw))

    session = overlay.SessionOverlay(FakeLabel())
    assert session.register_caption(field) == "cmd-1" and session.captions.registered_ids() == ["cmd-1"]
    assert session.register_caption("garbage") is None and session.captions_ignored == 1 and session.captions.registered_ids() == ["cmd-1"]
    assert session.captions.advance([{"shuzhiren_caption_id": "cmd-1"}]) == "欢迎来到直播间"
    holder = type("Holder", (), {"overlay": session})()
    assert overlay.register_caption(holder, field) == "cmd-1"
    assert overlay.register_caption(object(), field) is None, "a session without a picture layer ignores the field"
    passed("parse_caption validates the form field; register_caption ignores invalid fields and counts them")


def test_set_scene_keeps_old_scene_on_failure() -> None:
    session = overlay.SessionOverlay(FakeLabel())
    text, digest = encode(scene_doc())
    assert session.set_scene(text, digest).sha256 == digest and session.scene_state.scene.sha256 == digest
    expect_error("scene_hash_mismatch", lambda: session.set_scene(text, "0" * 64))
    assert session.scene_state.scene.sha256 == digest, "a refused scene leaves the active scene unchanged"
    assert session.status()["scene_sha256"] == digest
    passed("SessionOverlay.set_scene installs a valid scene and keeps the active one when a new scene is refused")


def test_layout() -> None:
    scene = parse(scene_doc())
    width, height = 1280, 720
    box = (886, 14, 380, 54)  # top-right label
    rects, excluded = overlay.layout(scene, width, height, box, 7)
    assert excluded == [] and set(rects) == set(overlay.LAYERS), (rects, excluded)
    forbidden = overlay.Rect(box[0] - 7, box[1] - 7, box[2] + 14, box[3] + 14)
    for name, rect in rects.items():
        assert rect.x >= 0 and rect.y >= 0 and rect.x + rect.w <= width and rect.y + rect.h <= height, (name, rect)
        assert not overlay._intersects(rect, forbidden), (name, rect)
    assert rects["price_sticker"].y >= rects["product_card"].y + rects["product_card"].h, "middle anchors put the sticker below the card"
    assert rects["caption"].y > height // 2, "bottom_band is in the lower half"
    assert overlay.layout(scene, width, height, box, 7) == (rects, excluded), "layout is deterministic"

    top_right = parse(scene_doc(productCard={"anchor": "top-right", "title": "洁面慕斯"}))
    rects, excluded = overlay.layout(top_right, width, height, box, 7)
    assert excluded == ["product_card"] and "product_card" not in rects and "price_sticker" in rects, (rects, excluded)
    top_band = parse(scene_doc(caption={"enabled": True, "position": "top_band"}))
    assert "caption" in overlay.layout(top_band, width, height, (14, 650, 300, 54), 7)[0]
    assert overlay.layout(top_band, width, height, box, 7)[1] == ["caption"], "a top band meets a top-right label"
    bottom_card = parse(scene_doc(productCard={"anchor": "bottom-left", "title": "洁面慕斯"}))
    rects, _ = overlay.layout(bottom_card, width, height, box, 7)
    assert rects["price_sticker"].y + rects["price_sticker"].h <= rects["product_card"].y, "bottom anchors put the sticker above the card"
    disabled = parse({"version": 1, "caption": {"enabled": False, "position": "top_band"}, "productCard": None, "priceSticker": None})
    assert overlay.layout(disabled, width, height, box, 7) == ({}, [])
    for tiny in ((1, 1), (3, 2), (64, 64)):
        rects, _ = overlay.layout(scene, *tiny, (0, 0, 1, 1), 1)
        for rect in rects.values():
            assert rect.w >= 1 and rect.h >= 1 and rect.x + rect.w <= tiny[0] and rect.y + rect.h <= tiny[1], (tiny, rect)
    expect_error("frame_invalid", lambda: overlay.layout(scene, 0, 10, box, 1))
    passed("layout keeps layers inside the frame and away from the grown AIGC label box, and reports the excluded ones")


def test_render_output_frame_fallback() -> None:
    class BrokenOverlay:
        def __init__(self) -> None:
            self.failures: list = []

        def compose(self, frame, userdatas):
            raise RuntimeError("compose broke")

        def record_failure(self, error) -> None:
            self.failures.append(error)

    class GoodOverlay:
        def compose(self, frame, userdatas):
            return ("composed", frame)

    frame = object()
    label, broken = FakeLabel(), BrokenOverlay()
    result = overlay.render_output_frame(broken, label, frame, [])
    assert result == ("labelled", frame) and label.applied == [frame], "the label is drawn on the frame without picture layers"
    assert len(broken.failures) == 1 and isinstance(broken.failures[0], RuntimeError)
    label = FakeLabel()
    assert overlay.render_output_frame(GoodOverlay(), label, frame, []) == ("labelled", ("composed", frame)) and label.applied == [("composed", frame)], "the label is drawn on the composed frame"

    class FailingLabel(FakeLabel):
        def apply(self, frame):
            raise ValueError("label broke")

    try:
        overlay.render_output_frame(GoodOverlay(), FailingLabel(), frame, [])
    except ValueError:
        pass
    else:
        raise AssertionError("an AIGC label failure must propagate so the caller drops the frame")
    passed("render_output_frame draws the label after the picture layer, survives a failing picture layer and lets a label failure propagate")


def region(frame, rect):
    return frame[rect.y:rect.y + rect.h, rect.x:rect.x + rect.w]


def write_png(directory: Path, color, size=(64, 48), name: str | None = None, fmt="PNG", extension=".png") -> str:
    from PIL import Image

    path = directory / "tmp-asset"
    Image.new("RGB", size, color).save(path, format=fmt)
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    (directory / ((name or digest) + extension)).write_bytes(data)
    path.unlink()
    return digest


def test_drawing(font: str, work: Path) -> None:
    import numpy as np

    renderer = aigc.AigcLabelRenderer(aigc.LabelConfig(font_file=font))
    assets = work / "assets"
    assets.mkdir()
    width, height = 1280, 720
    frame = np.full((height, width, 3), 100, dtype=np.uint8)
    original = frame.copy()
    label_rect = overlay.Rect(*aigc.label_box(renderer.config, width, height))

    def session_with(document, **options) -> overlay.SessionOverlay:
        session = overlay.SessionOverlay(renderer, asset_dir=str(assets), **options)
        session.set_scene(*encode(document))
        return session

    cue = json.dumps({"id": "c1", "cues": [{"text": "欢迎来到直播间，今天讲解洁面慕斯", "start_ms": 0, "end_ms": 1000}]}, ensure_ascii=False)
    points = [{"shuzhiren_caption_id": "c1"}] * 2

    session = session_with(scene_doc(), clock=lambda: BEFORE_EXPIRY)
    assert session.register_caption(cue) == "c1"
    out = session.compose(frame, points)
    assert np.array_equal(frame, original), "compose must not modify its input frame"
    assert out is not frame and out.shape == frame.shape and out.dtype == np.uint8
    rects, excluded = session.scene_state.layout_for(width, height)
    assert excluded == [] and set(rects) == set(overlay.LAYERS)
    for name, rect in rects.items():
        assert np.count_nonzero(region(out, rect) != 100) > 0.5 * region(out, rect).size, f"{name} must change its area"
    drawn = out.copy()
    for rect in rects.values():
        region(drawn, rect)[...] = 100
    assert np.array_equal(drawn, original), "pixels outside the layer rectangles must not change"
    assert np.array_equal(region(out, label_rect), region(original, label_rect)), "the layers leave the AIGC label area alone"
    assert session.status()["frames_composed"] == 1 and session.last_error is None
    labelled = renderer.apply(out)
    assert np.count_nonzero(region(labelled, label_rect) != region(out, label_rect)) > 0, "the label is drawn on top afterwards"
    passed("compose draws the product card, price sticker and caption inside their rectangles only, keeps the AIGC label area and its input intact")

    no_caption = overlay.SessionOverlay(renderer, asset_dir=str(assets), clock=lambda: BEFORE_EXPIRY)
    no_caption.set_scene(*encode(scene_doc()))
    quiet = no_caption.compose(frame, [None, None])
    assert np.array_equal(region(quiet, rects["caption"]), region(original, rects["caption"])), "no caption text, no caption drawn"
    assert np.count_nonzero(region(quiet, rects["product_card"]) != 100) > 0

    nothing = overlay.SessionOverlay(renderer, asset_dir=str(assets))
    assert nothing.compose(frame, points) is frame, "without a scene compose returns the frame as it is"
    assert overlay.compose(frame, None, "字幕", BEFORE_EXPIRY) is frame
    passed("compose without a scene returns the input frame; without caption text no caption is drawn")

    expired = session_with(scene_doc(), clock=lambda: AFTER_EXPIRY)
    out_expired = expired.compose(frame, points)
    assert np.array_equal(region(out_expired, rects["price_sticker"]), region(original, rects["price_sticker"])), "the price sticker is hidden after validUntil"
    assert np.count_nonzero(region(out_expired, rects["product_card"]) != 100) > 0, "the product card stays"
    assert np.count_nonzero(region(out, rects["price_sticker"]) != 100) > 0, "the price sticker shows before validUntil"
    forever = session_with(scene_doc(priceSticker={"priceText": "¥99.00", "note": None, "validUntil": None}), clock=lambda: AFTER_EXPIRY + timedelta(days=3650))
    assert np.count_nonzero(region(forever.compose(frame, points), rects["price_sticker"]) != 100) > 0, "a sticker without validUntil never expires"
    passed("the price sticker is hidden once validUntil has passed")

    conflict = session_with(scene_doc(productCard={"anchor": "top-right", "title": "洁面慕斯 120ml"}), clock=lambda: BEFORE_EXPIRY)
    out_conflict = conflict.compose(frame, points)
    conflict_rects, conflict_excluded = conflict.scene_state.layout_for(width, height)
    assert conflict_excluded == ["product_card"]
    assert np.array_equal(region(out_conflict, label_rect), region(original, label_rect))
    assert conflict.status()["layer_conflicts"] == ["product_card"] and conflict.status()["last_error"] == overlay.LAYER_CONFLICT
    assert overlay.status()["supported"] is True and overlay.status()["active_sessions"] >= 1
    passed("a layer that meets the AIGC label is not drawn and is reported as layer_conflicts_aigc_label")

    bgr_color = (200, 100, 50)  # RGB
    canvas_sha = write_png(assets, bgr_color)
    canvas = session_with(scene_doc(background={"mode": "canvas", "assetSha256": canvas_sha, "avatarAnchor": "left", "avatarScalePermille": 500}, caption={"enabled": False, "position": "bottom_band"}),
                          clock=lambda: BEFORE_EXPIRY)
    out_canvas = canvas.compose(frame, [None])
    assert np.array_equal(out_canvas[5, width - 5], np.array([50, 100, 200], dtype=np.uint8)), "the asset fills the canvas (frames are BGR)"
    assert np.array_equal(out_canvas[height - 5, 5], np.array([100, 100, 100], dtype=np.uint8)), "the avatar is scaled into the lower left"
    assert canvas.last_error is None and np.array_equal(frame, original)
    rgb_canvas = session_with(scene_doc(background={"mode": "canvas", "assetSha256": canvas_sha, "avatarAnchor": "right", "avatarScalePermille": 500}), channel_order="rgb")
    assert np.array_equal(rgb_canvas.compose(frame, [None])[5, 5], np.array(bgr_color, dtype=np.uint8)), "channel_order rgb keeps RGB frames"
    four = np.full((height, width, 4), 100, dtype=np.uint8)
    assert canvas.compose(four, [None]).shape == four.shape
    jpeg_sha = write_png(assets, (10, 200, 10), fmt="JPEG", extension=".jpg")
    jpeg = session_with(scene_doc(background={"mode": "canvas", "assetSha256": jpeg_sha, "avatarAnchor": "center", "avatarScalePermille": 500}, productCard=None, priceSticker=None, caption={"enabled": False, "position": "top_band"}))
    assert abs(int(jpeg.compose(frame, [None])[5, 5, 1]) - 200) <= 6, "jpg assets are read too"

    green = np.zeros((height, width, 3), dtype=np.uint8)
    green[...] = (0, 255, 0)
    green[200:300, 200:300] = 90
    chroma_sha = write_png(assets, bgr_color, size=(32, 32))
    chroma = session_with(scene_doc(background={"mode": "chroma_key", "assetSha256": chroma_sha, "keyColor": "#00ff00", "tolerance": 10}, caption={"enabled": False, "position": "bottom_band"}), clock=lambda: BEFORE_EXPIRY)
    out_chroma = chroma.compose(green, [None])
    assert np.array_equal(out_chroma[5, width // 2], np.array([50, 100, 200], dtype=np.uint8)) and np.array_equal(out_chroma[250, 250], np.array([90, 90, 90], dtype=np.uint8)), "key colour pixels are replaced, the avatar stays"
    passed("canvas and chroma_key backgrounds read hash-named assets and respect the frame channel order")

    wrong_hash_sha = "b" * 64
    (assets / f"{wrong_hash_sha}.png").write_bytes((assets / f"{canvas_sha}.png").read_bytes())
    huge_sha = write_png(assets, (1, 2, 3), size=(overlay.MAX_ASSET_SIDE + 1, 1))
    for case, sha in (("missing", "c" * 64), ("hash mismatch", wrong_hash_sha), ("oversized", huge_sha)):
        broken = session_with(scene_doc(background={"mode": "canvas", "assetSha256": sha, "avatarAnchor": "left", "avatarScalePermille": 800}), clock=lambda: BEFORE_EXPIRY)
        broken.register_caption(cue)
        out_broken = broken.compose(frame, points)
        assert np.array_equal(out_broken[5, width - 5], np.array([100, 100, 100], dtype=np.uint8)), f"{case}: the background layer is off"
        assert np.count_nonzero(region(out_broken, rects["product_card"]) != 100) > 0 and np.count_nonzero(region(out_broken, rects["caption"]) != 100) > 0, f"{case}: other layers still draw"
        assert broken.last_error == overlay.BACKGROUND_UNAVAILABLE, (case, broken.last_error)
    passed("a missing, mismatching or oversized background asset closes only the background layer (background_asset_unavailable)")

    invalid = np.zeros((10, 10, 2), dtype=np.uint8)
    failing = session_with(scene_doc(), clock=lambda: BEFORE_EXPIRY)
    label = FakeLabel()
    assert overlay.render_output_frame(failing, label, invalid, []) == ("labelled", invalid) and label.applied[0] is invalid
    assert failing.status()["frames_overlay_failed"] == 1 and failing.last_error == "frame_invalid"
    good = overlay.render_output_frame(failing, renderer, frame, points)
    assert np.count_nonzero(region(good, label_rect) != region(original, label_rect)) > 0, "the real label is applied after composing"
    passed("render_output_frame counts a failing compose and still hands the frame to the AIGC label")


LAYOUT_SEED = 20240620
LAYOUT_CASES = 300


def random_layout_scene(rng: random.Random) -> overlay.Scene:
    """A random valid scene: any layer switches, card anchor and caption position. The price sticker needs the card."""
    document = {
        "version": 1,
        "caption": {"enabled": rng.random() < 0.7, "position": rng.choice(overlay.CAPTION_POSITIONS)},
        "productCard": None,
        "priceSticker": None,
        "background": None,
    }
    if rng.random() < 0.8:
        document["productCard"] = {"anchor": rng.choice(overlay.CARD_ANCHORS), "title": "洁面慕斯 120ml"}
        if rng.random() < 0.8:
            document["priceSticker"] = {"priceText": "¥99.00", "note": "价格以下单页为准" if rng.random() < 0.5 else None, "validUntil": None}
    return parse(document)


def test_layout_avoids_aigc_label(font: str) -> None:
    """Feature: live-commerce-p1-features, Property 20: 图层不与 AIGC 角标相交

    Validates: Requirements 6.14
    """
    seed = int(os.environ.get("OVERLAY_PROPERTY_SEED", LAYOUT_SEED))
    rng = random.Random(seed)
    kept_total = excluded_total = 0
    seen_positions: set[str] = set()
    for case in range(LAYOUT_CASES):
        scene = random_layout_scene(rng)
        width, height = rng.randint(64, 3840), rng.randint(64, 3840)
        position = aigc.POSITIONS[case % len(aigc.POSITIONS)] if case < 2 * len(aigc.POSITIONS) else rng.choice(aigc.POSITIONS)
        seen_positions.add(position)
        margin = overlay.layout_margin(width, height) if rng.random() < 0.5 else rng.randint(0, 40)
        context = f"seed={seed} case={case} scene={scene} frame={width}x{height} position={position} margin={margin}"
        try:
            box = aigc.label_box(aigc.LabelConfig(font_file=font, position=position), width, height)
            rects, excluded = overlay.layout(scene, width, height, box, margin)

            forbidden = overlay.Rect(box[0] - margin, box[1] - margin, box[2] + 2 * margin, box[3] + 2 * margin)
            for name, rect in rects.items():
                assert name in overlay.LAYERS, f"unexpected layer {name}"
                assert rect.w >= 1 and rect.h >= 1 and rect.x >= 0 and rect.y >= 0, f"{name} {rect} is empty or outside the frame"
                assert rect.x + rect.w <= width and rect.y + rect.h <= height, f"{name} {rect} leaves the frame"
                assert not overlay._intersects(rect, forbidden), f"{name} {rect} meets the grown label box {forbidden}"

            # Which layers does the scene ask for, and where would they sit without any label?
            wanted = [name for name, enabled in (("product_card", scene.product_card is not None),
                                                 ("price_sticker", scene.price_sticker is not None and scene.product_card is not None),
                                                 ("caption", scene.caption_enabled)) if enabled]
            free, free_excluded = overlay.layout(scene, width, height, (-10 * width, -10 * height, 1, 1), 0)
            assert free_excluded == [] and sorted(free) == sorted(wanted), f"label-free layout {sorted(free)} != wanted {wanted}"
            assert len(set(excluded)) == len(excluded) and not set(excluded) & set(rects), "a layer is both kept and excluded"
            assert sorted([*rects, *excluded]) == sorted(wanted), f"kept {sorted(rects)} + excluded {excluded} != wanted {wanted}"
            for name in wanted:
                if name in rects:
                    assert rects[name] == free[name], f"{name} moved when the label was added"
                else:
                    assert name in excluded and overlay._intersects(free[name], forbidden), f"{name} was dropped without meeting the label"

            # Same input, same result; the conflict is reported with its reason.
            assert overlay.layout(scene, width, height, box, margin) == (rects, excluded), "layout is not deterministic"
            state = overlay.SceneState(scene, aigc.LabelConfig(font_file=font, position=position), "/nonexistent", True)
            state_rects, state_excluded = state.layout_for(width, height)
            assert state.layout_for(width, height) == (state_rects, state_excluded)
            assert (overlay.LAYER_CONFLICT in state.reasons()) == bool(state_excluded) and state.excluded_layers == tuple(state_excluded)
            assert overlay.LAYER_CONFLICT == "layer_conflicts_aigc_label"
        except AssertionError as error:
            raise AssertionError(f"Property 20 failed: {error}; {context}; rerun with OVERLAY_PROPERTY_SEED={seed}") from None
        kept_total += len(rects)
        excluded_total += len(excluded)
    assert seen_positions == set(aigc.POSITIONS), seen_positions
    assert kept_total > 0 and excluded_total > 0, f"generator never produced both outcomes (kept {kept_total}, excluded {excluded_total})"
    passed(f"Property 20: {LAYOUT_CASES} random scenes, frames and label positions keep layers inside the frame and clear of the label (kept {kept_total}, excluded {excluded_total})")


COMPOSE_SEED = 20240621
COMPOSE_CASES = 200


class LabelConfigHolder:
    """The part of the AIGC renderer a SessionOverlay reads: its LabelConfig (compose never draws the label)."""

    def __init__(self, config) -> None:
        self.config = config


def random_compose_scene(rng: random.Random, asset_digests: list[str]) -> dict:
    """A random valid scene document with random layer switches, anchors, caption position and background."""
    document = {
        "version": 1,
        "caption": {"enabled": rng.random() < 0.7, "position": rng.choice(overlay.CAPTION_POSITIONS)},
        "productCard": None,
        "priceSticker": None,
        "background": None,
    }
    if rng.random() < 0.8:
        document["productCard"] = {"anchor": rng.choice(overlay.CARD_ANCHORS), "title": "洁面慕斯 120ml"}
        if rng.random() < 0.8:
            document["priceSticker"] = {"priceText": "¥99.00", "note": "价格以下单页为准" if rng.random() < 0.5 else None,
                                        "validUntil": rng.choice([None, PRICE_VALID_UNTIL])}
    mode = rng.choice(["none", "canvas", "chroma_key"])
    if mode == "canvas":
        document["background"] = {"mode": "canvas", "assetSha256": rng.choice(asset_digests), "avatarAnchor": rng.choice(["left", "center", "right"]),
                                  "avatarScalePermille": rng.randint(500, 1000)}
    elif mode == "chroma_key":
        document["background"] = {"mode": "chroma_key", "assetSha256": rng.choice(asset_digests),
                                  "keyColor": "#" + "".join(f"{rng.randint(0, 255):02x}" for _ in range(3)), "tolerance": rng.randint(0, 255)}
    return document


def random_compose_frame(rng: random.Random, width: int, height: int, channels: int, background: dict | None, bgr: bool):
    """Random noise; for chroma_key scenes part (or all) of the frame is painted in the key colour so the keyer has work to do."""
    import numpy as np

    frame = np.frombuffer(rng.randbytes(width * height * channels), dtype=np.uint8).reshape(height, width, channels).copy()
    if background is not None and background["mode"] == "chroma_key" and rng.random() < 0.8:
        key = [int(background["keyColor"][index:index + 2], 16) for index in (1, 3, 5)]
        paint = key[::-1] if bgr else key
        if rng.random() < 0.5:
            frame[..., :3] = paint
        else:
            x0, y0 = rng.randint(0, width - 1), rng.randint(0, height - 1)
            frame[y0:rng.randint(y0 + 1, height), x0:rng.randint(x0 + 1, width), :3] = paint
    return frame


def test_compose_keeps_input_and_label_area(font: str, work: Path) -> None:
    """Feature: live-commerce-p1-features, Property 21: 合成不改输入且不写角标区域

    Validates: Requirements 6.13, 6.14
    """
    import numpy as np

    assets = work / "property-assets"
    assets.mkdir()
    asset_digests = [write_png(assets, color, size=size) for color, size in (((200, 100, 50), (64, 48)), ((10, 220, 40), (17, 33)), ((250, 250, 20), (8, 8)))]
    seed = int(os.environ.get("OVERLAY_PROPERTY_SEED", COMPOSE_SEED))
    rng = random.Random(seed)
    drawn_cases = background_cases = conflict_cases = captioned_cases = 0
    cue = json.dumps({"id": "p21", "cues": [{"text": "欢迎来到直播间，今天讲解洁面慕斯", "start_ms": 0, "end_ms": 1000}]}, ensure_ascii=False)
    points = [{"shuzhiren_caption_id": "p21"}] * 2
    for case in range(COMPOSE_CASES):
        document = random_compose_scene(rng, asset_digests)
        width, height, channels = rng.randint(64, 480), rng.randint(64, 480), rng.choice([3, 4])
        position = aigc.POSITIONS[case % len(aigc.POSITIONS)] if case < 2 * len(aigc.POSITIONS) else rng.choice(aigc.POSITIONS)
        order = rng.choice(["bgr", "rgb"])
        now = rng.choice([BEFORE_EXPIRY, AFTER_EXPIRY])
        with_caption = rng.random() < 0.8
        read_only = rng.random() < 0.5
        context = f"seed={seed} case={case} scene={document} frame={width}x{height}x{channels} position={position} order={order} read_only={read_only}"
        try:
            holder = LabelConfigHolder(aigc.LabelConfig(font_file=font, position=position))
            frame = random_compose_frame(rng, width, height, channels, document["background"], order == "bgr")
            original = frame.copy()
            if read_only:
                frame.setflags(write=False)  # a write into the input would raise instead of silently passing
            box = aigc.label_box(holder.config, width, height)
            label_rect = overlay.Rect(*box)

            def session_for(scene_document) -> overlay.SessionOverlay:
                session = overlay.SessionOverlay(holder, asset_dir=str(assets), channel_order=order, clock=lambda: now)
                session.set_scene(*encode(scene_document))
                return session

            full = session_for(document)
            if with_caption:
                assert full.register_caption(cue) == "p21"
            out = full.compose(frame, points if with_caption else [None, None])
            assert np.array_equal(frame, original), "compose changed its input frame"

            # Reference: the same scene with only the background layer enabled.
            only_background = {**document, "caption": {"enabled": False, "position": "bottom_band"}, "productCard": None, "priceSticker": None}
            reference = session_for(only_background).compose(frame, [None, None])
            assert np.array_equal(frame, original), "the background-only compose changed its input frame"
            assert out.shape == frame.shape and out.dtype == np.uint8 and reference.shape == frame.shape

            assert np.array_equal(region(out, label_rect), region(reference, label_rect)), "pixels in the AIGC label rectangle differ from the background-only output"
            assert region(out, label_rect).size > 0, "the AIGC label rectangle is empty inside the frame"

            # Non-vacuity bookkeeping: did a foreground layer draw, and did one get excluded by the label?
            if not np.array_equal(out, reference):
                drawn_cases += 1
            if document["background"] is not None:
                background_cases += 1
            if with_caption and document["caption"]["enabled"]:
                captioned_cases += 1
            if full.scene_state.excluded_layers:
                conflict_cases += 1
        except AssertionError as error:
            raise AssertionError(f"Property 21 failed: {error}; {context}; rerun with OVERLAY_PROPERTY_SEED={seed}") from None
    assert drawn_cases > 0 and conflict_cases > 0 and background_cases > 0 and captioned_cases > 0, (
        f"generator did not cover the property: drawn {drawn_cases}, conflicts {conflict_cases}, backgrounds {background_cases}, captions {captioned_cases}")
    passed(f"Property 21: {COMPOSE_CASES} random frames and scenes leave the input intact and the AIGC label area equal to the background-only output "
           f"(foreground drawn in {drawn_cases}, layers excluded in {conflict_cases}, backgrounds in {background_cases}, captions in {captioned_cases})")


CAPTION_SEED = 20240624
CAPTION_CASES = 300
CLEAR_FRAMES = overlay.CLEAR_AFTER_MS // overlay.FRAME_MS  # 15 consecutive frames without the id clear the caption


def random_cues(rng: random.Random, prefix: str) -> list[overlay.Cue]:
    """Sorted, non-overlapping cues with unique text, so the text shown identifies the position on the time line."""
    cues, position = [], rng.choice([0, 0, 0, 20, 100])
    for index in range(rng.randint(0, 6)):
        start = position + rng.choice([0, 0, 0, 20, 40, 120])
        end = start + rng.choice([20, 40, 60, 100, 200, 400])
        cues.append(overlay.Cue(f"{prefix}-{index}", start, end))
        position = end
    return cues


def cue_text_at(cues: list[overlay.Cue], elapsed_ms: int) -> str | None:
    for cue in cues:
        if cue.start_ms <= elapsed_ms < cue.end_ms:
            return cue.text
    return None


class CaptionModel:
    """Reference model of the CaptionTrack.advance contract in design.md, written independently of the implementation."""

    def __init__(self) -> None:
        self.cues: dict[str, list[overlay.Cue]] = {}
        self.order: list[str] = []
        self.elapsed: dict[str, int] = {}
        self.current: str | None = None
        self.silence = 0

    def register(self, caption_id: str, cues: list[overlay.Cue]) -> None:
        assert caption_id not in self.cues
        self.cues[caption_id], self.elapsed[caption_id] = cues, 0
        self.order.append(caption_id)
        if len(self.order) > 16:
            oldest = self.order.pop(0)
            del self.cues[oldest], self.elapsed[oldest]

    def advance(self, userdatas: list) -> str | None:
        for userdata in userdatas:
            caption_id = userdata.get("shuzhiren_caption_id") if isinstance(userdata, dict) else None
            if caption_id in self.cues:
                self.elapsed[caption_id] += 20
                self.current = cue_text_at(self.cues[caption_id], self.elapsed[caption_id])
                self.silence = 0
                if userdata.get("status") == "end":
                    self.order.remove(caption_id)
                    del self.cues[caption_id], self.elapsed[caption_id]
            else:
                self.silence += 20
                if self.silence >= 300:
                    self.current = None
        return self.current


def test_caption_track_follows_only_its_audio() -> None:
    """Feature: live-commerce-p1-features, Property 24: 字幕只随对应音频推进

    Validates: Requirements 6.12
    """
    seed = int(os.environ.get("OVERLAY_PROPERTY_SEED", CAPTION_SEED))
    rng = random.Random(seed)
    own_frames = silent_frames = cleared_cases = ended_ids = evicted_ids = shown_frames = 0
    for case in range(CAPTION_CASES):
        context = f"seed={seed} case={case}"
        try:
            # (1) Random event point sequences (with and without ids, with `end`, with registration and eviction mid-stream)
            #     agree frame by frame with the reference model.
            track, model = overlay.CaptionTrack(), CaptionModel()
            known: list[str] = []
            history: list[str] = []
            for step in range(rng.randint(5, 120)):
                if rng.random() < (0.5 if step == 0 else 0.06) or (case % 10 == 0 and len(known) < 20 and step < 20):
                    caption_id = f"c{case}-{len(known)}"
                    cues = random_cues(rng, caption_id)
                    track.register(caption_id, cues)
                    model.register(caption_id, cues)
                    known.append(caption_id)
                    assert track.registered_ids() == model.order, "registration order or eviction differs from first-in-first-out with 16 ids"
                batch = []
                for _ in range(rng.choice([0, 1, 2, 2, 2, 3])):
                    kind = rng.random()
                    if kind < 0.12:
                        batch.append(rng.choice([None, {}, "audio", 3, {"status": "end"}, {"shuzhiren_caption_id": None}, {"shuzhiren_caption_id": 7}]))
                    elif kind < 0.2:
                        batch.append({"shuzhiren_caption_id": f"unregistered-{rng.randint(0, 3)}", **({"status": "end"} if rng.random() < 0.3 else {})})
                    elif known and kind < 0.9:
                        batch.append({"shuzhiren_caption_id": rng.choice(known[-18:]), **({"status": "end"} if rng.random() < 0.04 else {})})
                    elif known:
                        batch.append({"shuzhiren_caption_id": rng.choice(known), "status": rng.choice(["start", "running", "end"])})
                    else:
                        batch.append({})
                before = dict(model.elapsed)
                expected = model.advance(batch)
                actual = track.advance(batch)
                assert actual == expected, f"step {step}: shown {actual!r}, model expects {expected!r}, batch {batch}"
                assert track.registered_ids() == model.order, f"step {step}: registered ids differ after {batch}"
                # Only own-ID frames moved a time line, by exactly 20 ms each.
                for caption_id, elapsed in before.items():
                    own = sum(1 for item in batch if isinstance(item, dict) and item.get("shuzhiren_caption_id") == caption_id)
                    assert model.elapsed.get(caption_id, elapsed + 20 * own) == elapsed + 20 * own
                for item in batch:
                    registered = isinstance(item, dict) and item.get("shuzhiren_caption_id") in before
                    own_frames += registered
                    silent_frames += not registered
                shown_frames += actual is not None
                ended_ids += sum(1 for item in batch if isinstance(item, dict) and item.get("status") == "end" and item.get("shuzhiren_caption_id") in before)
            evicted_ids += max(0, len(known) - 16)

            # (2) Frames without a registered id between two frames of an id never change the position shown afterwards;
            #     they can only clear the caption, after 300 ms in a row.
            cues = random_cues(rng, "g") or [overlay.Cue("g-0", 0, 400)]
            ids = [f"g{case}-{index}" for index in range(rng.randint(1, 3))]
            plain, gapped = overlay.CaptionTrack(), overlay.CaptionTrack()
            for caption_id in ids:
                plain.register(caption_id, cues)
                gapped.register(caption_id, cues)
            live = list(ids)
            for _ in range(rng.randint(2, 40)):
                if not live:
                    break
                caption_id = rng.choice(live)
                frame = {"shuzhiren_caption_id": caption_id}
                if rng.random() < 0.05:
                    frame["status"] = "end"
                    live.remove(caption_id)
                last_shown = gapped.advance([])  # the text on screen before the gap
                gap = rng.choice([0, 0, 1, 2, 5, CLEAR_FRAMES - 1, CLEAR_FRAMES, CLEAR_FRAMES + 3, rng.randint(0, 60)])
                for length in range(1, gap + 1):
                    silent = rng.choice([None, {}, {"shuzhiren_caption_id": f"never-{rng.randint(0, 5)}"}, {"status": "end"}, {"other": 1}])
                    got = gapped.advance([silent])
                    silent_frames += 1
                    expected_gap = last_shown if length < CLEAR_FRAMES else None
                    assert got == expected_gap, f"after {length} frames without an id the track shows {got!r}, expected {expected_gap!r}"
                cleared_cases += gap >= CLEAR_FRAMES and last_shown is not None
                with_gap = gapped.advance([frame])
                without_gap = plain.advance([frame])
                own_frames += 1
                assert with_gap == without_gap, f"gap of {gap} frames moved the caption: {with_gap!r} != {without_gap!r}"
        except AssertionError as error:
            raise AssertionError(f"Property 24 failed: {error}; {context}; rerun with OVERLAY_PROPERTY_SEED={seed}") from None
    assert own_frames > 0 and silent_frames > 0 and cleared_cases > 0 and ended_ids > 0 and evicted_ids > 0 and shown_frames > 0, (
        f"generator did not cover the property: own {own_frames}, silent {silent_frames}, cleared {cleared_cases}, ended {ended_ids}, evicted {evicted_ids}, shown {shown_frames}")
    passed(f"Property 24: {CAPTION_CASES} random event point sequences advance a caption only on frames of its own id "
           f"(own frames {own_frames}, other frames {silent_frames}, cleared after 300 ms in {cleared_cases}, ended ids {ended_ids}, evicted ids {evicted_ids})")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-imaging", action="store_true", help="fail instead of skipping when numpy, Pillow or a CJK font is missing")
    args = parser.parse_args()
    required = args.require_imaging or os.environ.get("AIGC_LABEL_REQUIRE_IMAGING") == "true"
    test_parse_scene()
    test_caption_track()
    test_caption_track_follows_only_its_audio()
    test_parse_caption_and_register()
    test_set_scene_keeps_old_scene_on_failure()
    test_layout()
    test_render_output_frame_fallback()
    with tempfile.TemporaryDirectory(prefix="overlay-") as directory:
        try:
            import numpy  # noqa: F401
            import PIL  # noqa: F401
        except ImportError as error:
            skipped(f"{error.name} is not installed; overlay drawing tests not run", required)
        else:
            font = first_existing(CJK_FONT_CANDIDATES)
            if font is None:
                skipped("no CJK font found (set AIGC_LABEL_TEST_FONT); overlay drawing tests not run", required)
            else:
                print(f"INFO  CJK font {font}", flush=True)
                test_drawing(font, Path(directory))
                test_layout_avoids_aigc_label(font)
                test_compose_keeps_input_and_label_area(font, Path(directory))
    return 0


if __name__ == "__main__":
    sys.exit(main())
