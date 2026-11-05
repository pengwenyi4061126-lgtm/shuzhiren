"""Behavior tests for the AIGC explicit label of the LiveTalking image (shuzhiren_aigc_label.py).

Usage: python3 runtime/livetalking/tests/test_aigc_label.py [--livetalking-source DIR] [--require-imaging]

The configuration tests need only the standard library. The drawing tests need
numpy, Pillow and a font with CJK glyphs (AIGC_LABEL_TEST_FONT, the image's
fonts-noto-cjk path, or a common Windows, macOS or Linux CJK font); without them
they print SKIP, or fail with --require-imaging. DIR is a copy of
vendor/LiveTalking with runtime/patches/livetalking.series applied
(scripts/test-deployment-config.mjs creates it). This directory is excluded from
the image build context.
"""

from __future__ import annotations

import argparse
import ast
import importlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MODULE_DIR))

import shuzhiren_aigc_label as label  # noqa: E402

CJK_FONT_CANDIDATES = (
    *label.FONT_CANDIDATES,
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/NotoSansSC-VF.ttf",
    "C:/Windows/Fonts/simhei.ttf",
)
LATIN_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "C:/Windows/Fonts/arial.ttf",
)


def passed(message: str) -> None:
    print(f"PASS  {message}", flush=True)


def skipped(message: str, required: bool) -> None:
    if required:
        raise AssertionError(f"required but unavailable: {message}")
    print(f"SKIP  {message}", flush=True)


def expect_error(reason: str, action) -> None:
    try:
        action()
    except label.AigcLabelError as error:
        assert error.reason == reason, f"expected {reason}, got {error.reason}: {error}"
        return
    raise AssertionError(f"expected AigcLabelError({reason})")


def first_existing(candidates) -> str | None:
    configured = os.environ.get("AIGC_LABEL_TEST_FONT")
    if configured:
        return configured if os.path.isfile(configured) else None
    return next((candidate for candidate in candidates if os.path.isfile(candidate)), None)


def test_configuration(work: Path) -> None:
    font = work / "font.ttf"
    font.write_bytes(b"not a real font")
    env = {label.ENV_FONT_FILE: str(font)}
    for text in (None, "", "   ", "\t"):
        config = label.config_from_env({**env, **({} if text is None else {label.ENV_TEXT: text})})
        assert config.text == label.DEFAULT_TEXT, f"empty text {text!r} must fall back to the default label, got {config.text!r}"
    for position in (None, "", " "):
        config = label.config_from_env({**env, **({} if position is None else {label.ENV_POSITION: position})})
        assert config.position == label.DEFAULT_POSITION
    assert label.config_from_env({**env, label.ENV_TEXT: " AI生成 ", label.ENV_POSITION: "Bottom-Left"}) == label.LabelConfig(text="AI生成", position="bottom-left", font_file=str(font))
    assert label.config_from_env({**env, label.ENV_TEXT: "人工智能生成内容"}).text == "人工智能生成内容"
    assert label.config_from_env({**env, label.ENV_ENABLED: "true"}).text == label.DEFAULT_TEXT
    assert label.config_from_env({**env, label.ENV_ENABLED: " TRUE "}).text == label.DEFAULT_TEXT
    for value in ("false", "0", "no", "", "off", "disabled"):
        expect_error("disabled", lambda value=value: label.config_from_env({**env, label.ENV_ENABLED: value}))
    for text in ("欢迎来到直播间", "x" * 40 + "AI", "AI\n生成", "AI\u200b生成"):
        expect_error("text_invalid", lambda text=text: label.config_from_env({**env, label.ENV_TEXT: text}))
    for position in ("center", "top", "left-top"):
        expect_error("position_invalid", lambda position=position: label.config_from_env({**env, label.ENV_POSITION: position}))
    expect_error("font_missing", lambda: label.config_from_env({label.ENV_FONT_FILE: str(work / "absent.ttc")}))
    passed("label configuration: empty text and position fall back to the defaults, AIGC_LABEL_ENABLED other than true, non-AI text, bad positions and missing fonts are refused")


def run_launcher(command: list[str], env: dict) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(MODULE_DIR / "launcher.py"), *command], capture_output=True, timeout=120, env={**os.environ, **env})


def test_launcher_refuses(work: Path) -> None:
    marker = work / "started"
    app = work / "app.py"
    app.write_text(f"open({str(marker)!r}, 'w').close()\n", encoding="utf-8")
    for env in ({label.ENV_ENABLED: "false"}, {label.ENV_POSITION: "center"}, {label.ENV_FONT_FILE: str(work / "absent.ttc")}):
        result = run_launcher([sys.executable, str(app)], env)
        assert result.returncode == label.AIGC_LABEL_EXIT_CODE, (env, result.returncode, result.stderr)
        assert b"ERROR AIGC label" in result.stderr, result.stderr
        assert not marker.exists(), "LiveTalking must not start without a usable AIGC label"
    other = run_launcher([sys.executable, "-c", "print('other')"], {label.ENV_ENABLED: "false"})
    assert other.returncode == 0 and b"other" in other.stdout, "commands other than app.py are not label-gated"
    passed("launcher exits 78 before starting app.py when the AIGC label is disabled, misconfigured or has no font")


def test_drawing(font: str, work: Path) -> None:
    import numpy as np

    config = label.LabelConfig(font_file=font)
    frame = np.full((720, 1280, 3), 128, dtype=np.uint8)
    original = frame.copy()
    out = label.apply_aigc_label(frame, config)
    assert np.array_equal(frame, original), "apply_aigc_label must not modify its input frame"
    assert out.shape == frame.shape and out.dtype == np.uint8
    x, y, w, h = label.label_box(config, 1280, 720)
    assert w > 0 and h > 0
    region, outside = out[y:y + h, x:x + w], out.copy()
    outside[y:y + h, x:x + w] = 128
    assert np.count_nonzero(region != 128) > 0.9 * region.size, "the label area must change"
    assert np.array_equal(outside, original), "pixels outside the label area must not change"
    assert region.max() >= 200, "the label text must be drawn bright"
    assert abs(int(region[0, 0, 0]) - round(128 * (1 - label.BACKGROUND_ALPHA))) <= 1, "the label box darkens the picture behind the text"
    assert h >= round(720 * label.FONT_FRACTION), "the label is at least 5% of the shorter side tall"
    assert np.array_equal(label.apply_aigc_label(frame, config), out), "drawing is deterministic"
    passed("apply_aigc_label changes the label area of a 1280x720 frame, leaves the rest and its input unchanged and is deterministic")

    for position in label.POSITIONS:
        px, py, pw, ph = label.label_box(label.LabelConfig(position=position, font_file=font), 1280, 720)
        assert (px + pw / 2 < 640) == position.endswith("left") and (py + ph / 2 < 360) == position.startswith("top"), (position, px, py)
    passed("each AIGC_LABEL_POSITION places the label in its corner")

    sizes = [(1, 1), (2, 3), (9, 7), (16, 16), (48, 64), (120, 90), (240, 320), (720, 1280), (1280, 720), (1920, 1080), (1080, 1920), (2160, 3840)]
    for height, width in sizes:
        for channels in (None, 1, 3, 4):
            shape = (height, width) if channels is None else (height, width, channels)
            image = np.full(shape, 90, dtype=np.uint8)
            labelled = label.apply_aigc_label(image, config)
            assert labelled.shape == shape and labelled.dtype == np.uint8, shape
            assert not np.array_equal(labelled, image), f"{shape}: the label must be drawn on every resolution"
            if channels == 4:
                assert np.array_equal(labelled[..., 3], image[..., 3]), "the alpha channel is kept"
        lx, ly, lw, lh = label.label_box(config, width, height)
        assert 0 <= lx and 0 <= ly and lx + lw <= width and ly + lh <= height, (width, height, lx, ly, lw, lh)
    for bad in (np.zeros((10, 10, 3), dtype=np.float32), np.zeros((10, 10, 2), dtype=np.uint8), np.zeros((2, 10, 10, 3), dtype=np.uint8), "frame"):
        expect_error("frame_invalid", lambda bad=bad: label.apply_aigc_label(bad, config))
    assert label.apply_aigc_label(np.zeros((0, 10, 3), dtype=np.uint8), config).shape == (0, 10, 3)
    passed(f"apply_aigc_label draws on {len(sizes)} resolutions from 1x1 to 3840x2160 with 1, 3 and 4 channels without failing and rejects non-uint8 frames")

    empty = label.config_from_env({label.ENV_TEXT: "", label.ENV_POSITION: "", label.ENV_FONT_FILE: font})
    assert empty.text == label.DEFAULT_TEXT
    assert np.array_equal(label.apply_aigc_label(frame, empty), out), "an empty AIGC_LABEL_TEXT draws the default label"
    short = label.apply_aigc_label(frame, label.LabelConfig(text="AI生成", font_file=font))
    assert not np.array_equal(short, out) and not np.array_equal(short, frame), "the configured text is drawn instead of the default"
    passed("an empty AIGC_LABEL_TEXT falls back to the default label instead of drawing nothing")

    assert label.missing_glyphs(label.DEFAULT_TEXT, font) == [], f"{font} must cover the default label"
    renderer = label.AigcLabelRenderer(config)
    renderer.apply(frame)
    renderer.apply(frame)
    status = renderer.status()
    assert status["enabled"] is True and status["frames_labelled"] == 2 and status["text"] == label.DEFAULT_TEXT and status["position"] == label.DEFAULT_POSITION, status
    try:
        renderer.apply(np.zeros((4, 4), dtype=np.float64))
    except label.AigcLabelError:
        pass
    else:
        raise AssertionError("a frame that cannot be labelled must raise")
    status = renderer.status()
    assert status["enabled"] is False and status["last_error"] == "frame_invalid" and status["frames_dropped"] == 1, status
    renderer.apply(frame)
    assert renderer.status()["enabled"] is True
    passed("renderer status reports enabled, text, position and frame counters, and reports disabled after a frame failed")

    latin = next((candidate for candidate in LATIN_FONT_CANDIDATES if os.path.isfile(candidate)), None)
    if latin:
        assert label.missing_glyphs(label.DEFAULT_TEXT, latin), f"{latin} is expected to lack CJK glyphs"
        expect_error("glyph_missing", lambda: label.AigcLabelRenderer(label.LabelConfig(font_file=latin)))
        passed("a font without CJK glyphs is refused instead of drawing empty boxes")
    else:
        print("SKIP  no Latin-only font found; glyph coverage refusal not exercised", flush=True)

    for env, enabled, reason in (({label.ENV_FONT_FILE: font}, True, None), ({label.ENV_FONT_FILE: font, label.ENV_ENABLED: "false"}, False, "disabled"), ({label.ENV_FONT_FILE: str(work / "absent.ttc")}, False, "font_missing")):
        saved = {key: os.environ.get(key) for key in (label.ENV_ENABLED, label.ENV_TEXT, label.ENV_POSITION, label.ENV_FONT_FILE)}
        try:
            for key in saved:
                os.environ.pop(key, None)
            os.environ.update(env)
            module = importlib.reload(label)
            status = module.status()
            assert status["enabled"] is enabled and status["last_error"] == reason, (env, status)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    importlib.reload(label)
    passed("status() reports enabled only for a working process renderer and disabled (fail closed) for a disabled or undrawable label")

    app = work / "app.py"
    app.write_text("print('livetalking started', flush=True)\n", encoding="utf-8")
    result = run_launcher([sys.executable, str(app)], {label.ENV_FONT_FILE: font, label.ENV_TEXT: "AI生成", label.ENV_POSITION: "bottom-left"})
    assert result.returncode == 0, result.stderr
    assert "INFO AIGC label enabled: text='AI生成' position=bottom-left".encode() in result.stdout and b"livetalking started" in result.stdout, result.stdout
    passed("launcher logs the enabled AIGC label and starts app.py with a usable configuration")


def function_source(tree: ast.Module, class_name: str, name: str) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == name:
                    return item
    raise AssertionError(f"{class_name}.{name} not found")


def test_patched_livetalking(source: Path) -> None:
    base_text = (source / "avatars" / "base_avatar.py").read_text(encoding="utf-8")
    tree = ast.parse(base_text)
    process = ast.get_source_segment(base_text, function_source(tree, "BaseAvatar", "process_frames"))
    apply_at = process.index("combine_frame = self.aigc_label.apply(combine_frame)")
    assert apply_at < process.index("self.output.push_video_frame(combine_frame)") < process.index("self.record_video_data(combine_frame)"), "the label is applied before the frame is pushed and recorded"
    assert "continue" in process[apply_at:process.index("self.output.push_video_frame(combine_frame)")], "a frame that cannot be labelled is dropped"
    init = ast.get_source_segment(base_text, function_source(tree, "BaseAvatar", "__init__"))
    assert "self.aigc_label = shuzhiren_aigc_label.process_renderer()" in init, "a session cannot be created without the label renderer"
    routes = (source / "server" / "routes.py").read_text(encoding="utf-8")
    assert 'app.router.add_get("/api/admin/aigc-label", admin_aigc_label)' in routes and '"aigc_label": shuzhiren_aigc_label.status()' in routes
    compile(base_text, "base_avatar.py", "exec")
    compile(routes, "routes.py", "exec")
    passed("patched base_avatar.py labels every frame before push and record, and server/routes.py exposes /api/admin/aigc-label")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--livetalking-source", type=Path)
    parser.add_argument("--require-imaging", action="store_true", help="fail instead of skipping when numpy, Pillow or a CJK font is missing")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="aigc-label-") as directory:
        work = Path(directory)
        test_configuration(work)
        test_launcher_refuses(work)
        try:
            import numpy  # noqa: F401
            import PIL  # noqa: F401
        except ImportError as error:
            skipped(f"{error.name} is not installed; AIGC label drawing tests not run", args.require_imaging)
        else:
            font = first_existing(CJK_FONT_CANDIDATES)
            if font is None:
                skipped("no CJK font found (set AIGC_LABEL_TEST_FONT); AIGC label drawing tests not run", args.require_imaging)
            else:
                print(f"INFO  CJK font {font}", flush=True)
                test_drawing(font, work)
        if args.livetalking_source:
            test_patched_livetalking(args.livetalking_source.resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
