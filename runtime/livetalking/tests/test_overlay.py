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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-imaging", action="store_true", help="fail instead of skipping when numpy, Pillow or a CJK font is missing")
    args = parser.parse_args()
    required = args.require_imaging or os.environ.get("AIGC_LABEL_REQUIRE_IMAGING") == "true"
    test_parse_scene()
    test_caption_track()
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
