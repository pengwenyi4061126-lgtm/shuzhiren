"""Behavior tests for the LiveTalking stream-key protection (audit H2, design Requirement 14).

Usage: python3 runtime/livetalking/tests/test_stream_secret.py [--livetalking-source DIR]

DIR is a copy of vendor/LiveTalking with runtime/patches/livetalking.series
applied (scripts/test-deployment-config.mjs creates it). Standard library only;
the HTTP checks additionally need aiohttp and are skipped without it. This
directory is excluded from the image build context.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib
import io
import json
import logging
import os
import py_compile
import random
import secrets
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import types
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MODULE_DIR))

import shuzhiren_secrets as ss  # noqa: E402

SENTINEL = "ci-sentinel-" + secrets.token_hex(16)
BASE = "rtmp://rtmp.invalid/live"
FULL = f"{BASE}/{SENTINEL}"
REDACTED_BASE = "rtmp://rtmp.invalid/<redacted>"


def passed(message: str) -> None:
    print(f"PASS  {message}", flush=True)


def write(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path


def expect_reason(path: Path | str, reason: str) -> None:
    try:
        ss.load_stream_key(str(path))
    except ss.StreamKeyFileError as error:
        assert error.reason == reason, f"{path}: expected {reason}, got {error.reason}"
        assert str(error) == f"LiveTalking stream key file {path} is {reason}", str(error)
        return
    raise AssertionError(f"{path}: expected StreamKeyFileError({reason})")


def test_load_stream_key(work: Path) -> None:
    expect_reason(work / "absent", "missing")
    expect_reason(work, "unreadable")
    for name, data in {"empty": b"", "newline": b"\n", "crlf": b"\r\n", "blank": b"  \t \n"}.items():
        expect_reason(write(work / f"key-{name}", data), "empty")
    for name, data in {"space": b"a b", "tab": b"a\tb", "quote": b'a"b', "backslash": b"a\\b", "utf8": "k\u00e9y".encode(), "control": b"a\x01b", "long": b"k" * 1025, "two-lines": b"a\nb"}.items():
        expect_reason(write(work / f"key-{name}", data), "invalid")
    assert ss.load_stream_key(str(write(work / "key-lf", f"{SENTINEL}\n".encode()))) == SENTINEL
    assert ss.load_stream_key(str(write(work / "key-crlf2", f"{SENTINEL}\r\n".encode()))) == SENTINEL
    assert ss.load_stream_key(str(write(work / "key-max", b"k" * 1024 + b"\n"))) == "k" * 1024
    passed("load_stream_key classifies missing, unreadable, empty and invalid key files by path and category only")


def test_redact_push_url() -> None:
    rng = random.Random(20261105)
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    for _ in range(2000):
        key = "".join(rng.choice(alphabet + "-_.~!$&'()*+,;=:@") for _ in range(rng.randint(1, 40)))
        kind = rng.choice(["dns", "ipv4", "ipv6"])
        if kind == "dns":
            host = ".".join("".join(rng.choice(alphabet) for _ in range(rng.randint(1, 10))) for _ in range(rng.randint(1, 3)))
            shown = host
        elif kind == "ipv4":
            host = ".".join(str(rng.randint(0, 255)) for _ in range(4))
            shown = host
        else:
            host = ":".join(format(rng.randint(0, 0xFFFF), "x") for _ in range(8))
            shown = f"[{host}]"
        port = rng.choice([None, rng.randint(1, 65535)])
        userinfo = rng.choice(["", "user@", "user:pass@"])
        query = rng.choice(["", f"?token={key}"])
        fragment = rng.choice(["", f"#{key}"])
        scheme = rng.choice(["rtmp", "rtmps"])
        netloc = shown + (f":{port}" if port is not None else "")
        url = f"{scheme}://{userinfo}{netloc}/live/{key}{query}{fragment}"
        expected = f"{scheme}://{netloc}/<redacted>"
        assert ss.redact_push_url(url) == expected, (url, ss.redact_push_url(url))
    for url in ["", "live/key", "rtmp:///live/key", "rtmp://[::1/live/key", "rtmp://host:99999/live/key", "//host/live/key"]:
        assert ss.redact_push_url(url) == ss.REDACTED_URL_SUFFIX, (url, ss.redact_push_url(url))
    passed("redact_push_url keeps only scheme, host and port for 2000 generated URLs and hides unparsable ones")


def test_stream_redactor() -> None:
    variants = ss.secret_variants(SENTINEL, FULL)
    rng = random.Random(7)
    lines = [f"push {FULL} now", f"key={SENTINEL}", "no secret here", f"{SENTINEL}{SENTINEL}", "x" * 300 + SENTINEL]
    text = ("\n".join(rng.choice(lines) for _ in range(200)) + "\r\n" + SENTINEL).encode()
    expected = ss.redact_text(text.decode(), variants).encode()
    for max_buffer in (65536, 64):
        for _ in range(300):
            redactor = ss.StreamRedactor(variants, max_buffer=max_buffer)
            output = bytearray()
            position = 0
            while position < len(text):
                step = rng.randint(1, 97)
                output += redactor.feed(text[position:position + step])
                position += step
            output += redactor.flush()
            assert SENTINEL.encode() not in output
            assert bytes(output) == expected
    unbroken = ss.StreamRedactor(variants, max_buffer=64)
    released = unbroken.feed(b"y" * 1000)
    assert len(released) > 0 and len(released) + len(unbroken.flush()) == 1000, "output without line breaks must not grow without bound"
    passed("StreamRedactor removes the key and push URL for any chunking, with and without line breaks")


def test_options_and_logging() -> None:
    ss.register_secret(SENTINEL, FULL)
    opt = argparse.Namespace(push_url=FULL, stream_key_file="/run/secrets/stream-key", note=f"x {SENTINEL} y", nested=[{"url": FULL}], fps=25)
    options = ss.redacted_options_dict(opt)
    assert options["push_url"] == REDACTED_BASE, options["push_url"]
    assert options["fps"] == 25 and options["stream_key_file"] == "/run/secrets/stream-key"
    assert SENTINEL not in json.dumps(options) and SENTINEL not in repr(ss.redacted_options(opt))
    assert opt.push_url == FULL, "redaction must not modify the live options"
    logger = logging.getLogger(f"stream-secret-test-{secrets.token_hex(4)}")
    logger.propagate = False
    sink = io.StringIO()
    handler = logging.StreamHandler(sink)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    logger.addHandler(handler)
    ss.install_log_redaction([logger])
    logger.info("options %s", opt)
    try:
        raise RuntimeError(f"connect {FULL} failed")
    except RuntimeError:
        logger.exception("stream failed for %s", SENTINEL)
    logged = sink.getvalue()
    assert SENTINEL not in logged, logged
    assert "<redacted>" in logged and "Traceback" in logged
    passed("redacted options and RedactingFormatter hide the key in option dumps, messages and tracebacks")


def test_apply_stream_key(work: Path) -> None:
    key_file = write(work / "apply-key", f"{SENTINEL}\n".encode())
    for namespace, message in [
        (argparse.Namespace(transport="rtmp", push_url=BASE, stream_key_file=""), "requires --stream_key_file"),
        (argparse.Namespace(transport="rtmp", push_url=BASE, stream_key_file=str(work / "absent")), "is missing"),
    ]:
        stream = io.StringIO()
        try:
            ss.apply_stream_key(namespace, stream)
        except SystemExit as error:
            assert error.code == ss.STREAM_KEY_FILE_EXIT_CODE == 78
            assert message in stream.getvalue(), stream.getvalue()
        else:
            raise AssertionError("RTMP output without a usable key file must exit 78")
    opt = ss.apply_stream_key(argparse.Namespace(transport="rtmp", push_url=BASE, stream_key_file=str(key_file)))
    assert opt.push_url == FULL
    untouched = ss.apply_stream_key(argparse.Namespace(transport="webrtc", push_url="http://localhost/whip", stream_key_file=""))
    assert untouched.push_url == "http://localhost/whip"
    passed("apply_stream_key appends the key in memory and exits 78 for RTMP without a usable key file")


def run_launcher(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(MODULE_DIR / "launcher.py"), *command], capture_output=True, timeout=60, **kwargs)


def test_launcher(work: Path) -> None:
    key_file = write(work / "launcher-key", f"{SENTINEL}\n".encode())
    probe = work / "child-view.json"
    child = (
        "import json, os, sys, time\n"
        f"json.dump({{'argv': sys.argv, 'env': dict(os.environ)}}, open({str(probe)!r}, 'w'))\n"
        f"full = {FULL!r}\n"
        "sys.stdout.write('stdout ' + full[:20]); sys.stdout.flush(); time.sleep(0.05)\n"
        "sys.stdout.write(full[20:] + '\\n'); sys.stdout.flush()\n"
        "os.write(2, ('native ' + full.rsplit('/', 1)[1] + '\\n').encode())\n"
        "raise RuntimeError('cannot connect ' + full)\n"
    )
    result = run_launcher([sys.executable, "-c", child, "--push_url", BASE, "--stream_key_file", str(key_file)])
    output = result.stdout + result.stderr
    assert result.returncode == 1, (result.returncode, output)
    assert SENTINEL.encode() not in output, output
    assert output.count(b"<redacted>") >= 3 and b"Traceback" in result.stderr, output
    view = probe.read_text()
    assert SENTINEL not in view, "the launcher must not put the key in the child's argv or environment"
    assert json.loads(view)["argv"][-1] == str(key_file)
    exited = run_launcher([sys.executable, "-c", "import sys; sys.exit(7)", "--stream_key_file=" + str(key_file)])
    assert exited.returncode == 7, exited
    marker = work / "child-started"
    missing = run_launcher([sys.executable, "-c", f"open({str(marker)!r}, 'w')", "--stream_key_file", str(work / "absent")])
    assert missing.returncode == 78, missing
    assert f"LiveTalking stream key file {work / 'absent'} is missing".encode() in missing.stderr, missing.stderr
    assert not marker.exists(), "LiveTalking must not start when the key file is unusable"
    if os.name == "posix":
        process = subprocess.Popen([sys.executable, str(MODULE_DIR / "launcher.py"), sys.executable, "-c", "import time; print('ready', flush=True); time.sleep(60)"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert process.stdout.readline().strip() == b"ready"
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=20) == 128 + signal.SIGTERM, process.returncode
        process.stdout.close()
        process.stderr.close()
    passed("launcher validates the key file, redacts child stdout/stderr and keeps the key out of argv and env")


def stub_module(name: str, **attributes) -> None:
    module = types.ModuleType(name)
    module.__dict__.update(attributes)
    sys.modules[name] = module


class FakeStreamerConfig:
    pass


class FakeStreamer:
    fail = False

    def init(self, config) -> None:
        if FakeStreamer.fail:
            raise OSError(f"Failed to open {config.stream_server}: Connection refused")


def test_patched_livetalking(source: Path, work: Path) -> None:
    os.chdir(work)
    (work / "web").mkdir(exist_ok=True)
    sys.path.insert(0, str(source))
    try:
        importlib.import_module("numpy")
    except ImportError:
        stub_module("numpy", ndarray=type("ndarray", (), {}), int16="int16", float32="float32")

    class BaseOutput:
        def __init__(self, opt=None, parent=None) -> None:
            self.opt = opt
            self.parent = parent

    stub_module("streamout.base_output", BaseOutput=BaseOutput)
    stub_module("server.session_manager", session_manager=types.SimpleNamespace(sessions={}, get_session=lambda sessionid: None))
    stub_module("server.avatar_routes", setup_avatar_routes=lambda app: None)
    stub_module("rtmp_streaming", StreamerConfig=FakeStreamerConfig, Streamer=FakeStreamer)
    py_compile.compile(str(source / "app.py"), doraise=True)

    import config  # patched vendor/LiveTalking/config.py

    key_file = write(work / "patched-key", f"{SENTINEL}\n".encode())
    argv = sys.argv
    try:
        sys.argv = ["app.py", "--config", "", "--transport", "rtmp", "--model", "musetalk", "--push_url", BASE, "--stream_key_file", str(work / "absent")]
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            try:
                config.parse_args()
            except SystemExit as error:
                assert error.code == 78, error.code
            else:
                raise AssertionError("patched parse_args must exit 78 without the key file")
        assert "is missing" in stderr.getvalue()
        sys.argv = ["app.py", "--config", "", "--transport", "rtmp", "--model", "musetalk", "--push_url", BASE, "--stream_key_file", str(key_file)]
        opt = config.parse_args()
    finally:
        sys.argv = argv
    assert opt.push_url == FULL, "the push URL must keep the former ${STREAM_RTMP_URL}/${STREAM_KEY} form"

    from utils.logger import logger
    from streamout.rtmp import RTMPOutput

    output = RTMPOutput(opt=opt)
    output._init_streamer(480, 640)
    FakeStreamer.fail = True
    try:
        RTMPOutput(opt=opt)._init_streamer(480, 640)
    except RuntimeError as error:
        rendered = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        assert SENTINEL not in rendered and "OSError" in rendered, rendered
    else:
        raise AssertionError("a failing streamer must raise")
    ss.install_log_redaction([logger])
    logger.info(ss.redacted_options(opt))
    logger.info("raw value %s", FULL)
    for handler in logger.handlers:
        handler.flush()
    log_text = (work / "livetalking.log").read_text(encoding="utf-8")
    assert f"RTMP output started via python_rtmpstream: {REDACTED_BASE}" in log_text, log_text
    assert SENTINEL not in log_text, log_text
    passed("patched config.py, app.py and streamout/rtmp.py keep the key out of options, the RTMP log and init errors")

    try:
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
    except ImportError:
        print("SKIP  aiohttp is not installed; patched HTTP routes not exercised", flush=True)
        return
    from server.routes import setup_routes

    async def leak_text(request):
        return web.Response(text=f"echo {FULL}")

    async def leak_error(request):
        raise RuntimeError(f"cannot reach {FULL}")

    async def exercise() -> None:
        app = web.Application(middlewares=[ss.secret_redaction_middleware()])
        app["opt"] = opt
        app.router.add_get("/test/leak-text", leak_text)
        app.router.add_get("/test/leak-error", leak_error)
        setup_routes(app)
        async with TestClient(TestServer(app, host="127.0.0.1")) as client:
            response = await client.get("/api/admin/config")
            body = await response.text()
            assert response.status == 200 and SENTINEL not in body, body
            assert json.loads(body)["data"]["config"]["push_url"] == REDACTED_BASE, body
            for method, path, kwargs in [("GET", "/api/admin/sessions", {}), ("POST", "/human", {"data": "{not json"}), ("POST", "/human", {"json": {"sessionid": SENTINEL, "type": "echo", "text": FULL}}), ("POST", "/humanaudio", {"data": {"sessionid": "0"}}), ("GET", "/nonexistent", {}), ("GET", "/test/leak-text", {})]:
                response = await client.request(method, path, **kwargs)
                body = await response.text()
                assert SENTINEL not in body, (path, body)
            response = await client.get("/test/leak-error")
            assert response.status == 500 and await response.json() == {"code": -1, "msg": "internal error"}

    asyncio.run(exercise())
    passed("patched /api/admin/config and error responses never contain the key")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--livetalking-source", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="stream-secret-") as directory:
        work = Path(directory)
        test_load_stream_key(work)
        test_redact_push_url()
        test_stream_redactor()
        test_options_and_logging()
        test_apply_stream_key(work)
        test_launcher(work)
        if args.livetalking_source:
            cwd = os.getcwd()
            try:
                test_patched_livetalking(args.livetalking_source.resolve(), work)
            finally:
                logging.shutdown()
                os.chdir(cwd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
