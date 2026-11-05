import asyncio
import math
import os
import pathlib
import sys
import tempfile
import types
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import HTTPException

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
import app as gateway


async def reject(token: str) -> None:
    gateway.RUNTIME_TOKEN = token
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = False
    try:
        async with gateway.lifespan(gateway.app):
            raise AssertionError("Runtime Gateway must reject weak shared tokens before startup")
    except RuntimeError as error:
        assert "RUNTIME_SHARED_TOKEN" in str(error)

async def reject_configuration(name: str, value: object, expected: str) -> None:
    original = getattr(gateway, name)
    gateway.RUNTIME_TOKEN = "g" * 32
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = False
    setattr(gateway, name, value)
    try:
        async with gateway.lifespan(gateway.app):
            raise AssertionError(f"Runtime Gateway must reject invalid {name} before startup")
    except RuntimeError as error:
        assert expected in str(error), str(error)
    finally:
        setattr(gateway, name, original)


async def check_unauthenticated_surfaces() -> None:
    gateway.RUNTIME_TOKEN = "g" * 32
    valid = {"authorization": f"Bearer {'g' * 32}"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=gateway.app), base_url="http://gateway") as client:
        for path in ("/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"):
            for headers in ({}, valid):
                response = await client.get(path, headers=headers)
                assert response.status_code == 404, f"{path} must not be served by Runtime Gateway (got {response.status_code})"
        non_ascii = {"authorization": b"Bearer \xc3\xa9" + b"g" * 31}
        wrong = {"authorization": f"Bearer {'h' * 32}"}
        speak_body = {"command_id": "c1", "session_id": "s1", "text": "hello", "voice": "v", "provider": "cosyvoice"}
        media_body = {"command_id": "c1", "session_id": "s1", "action": "stop_program"}
        for method, path, body in (("GET", "/v1/observations/s1", None), ("GET", "/v1/previews/s1", None), ("POST", "/v1/speak", speak_body), ("POST", "/v1/media", media_body)):
            rejected = await client.request(method, path, headers=non_ascii, json=body)
            mismatched = await client.request(method, path, headers=wrong, json=body)
            assert rejected.status_code == 401, f"a non-ASCII bearer token on {path} must be rejected as unauthorized (got {rejected.status_code})"
            assert rejected.json() == mismatched.json() == {"detail": "Invalid runtime gateway token"}
    for header in ("Bearer é", "Bearer \u4e2d\u6587", f"Bearer {'g' * 31}\u00e9"):
        try:
            gateway.authorize(header)
        except HTTPException as error:
            assert error.status_code == 401
        else:
            raise AssertionError("a non-ASCII bearer token must be rejected")


def check_gpu_index() -> None:
    class NVMLError(Exception):
        pass

    def handle_by_index(index: int) -> str:
        if index != 0:
            raise NVMLError(f"device {index} is not visible in this container")
        return "visible-device"

    fake = types.ModuleType("pynvml")
    fake.nvmlInit = lambda: None
    fake.nvmlShutdown = lambda: None
    fake.nvmlDeviceGetHandleByIndex = handle_by_index
    fake.nvmlDeviceGetMemoryInfo = lambda _handle: types.SimpleNamespace(used=3 * 1024 * 1024 * 1024, total=24 * 1024 * 1024 * 1024)
    fake.nvmlDeviceGetUtilizationRates = lambda _handle: types.SimpleNamespace(gpu=41)
    original_module = sys.modules.get("pynvml")
    original_visible = os.environ.get("NVIDIA_VISIBLE_DEVICES")
    sys.modules["pynvml"] = fake
    try:
        for visible in ("1", "GPU-8f2c6f5e-0d6a-4f7e-9b1d-2a3c4e5f6a7b", "2,3", "all"):
            os.environ["NVIDIA_VISIBLE_DEVICES"] = visible
            observed = gateway.gpu_observation()
            assert observed == {"available": True, "utilization_percent": 41, "memory_used_mib": 3072, "memory_total_mib": 24576}, f"NVIDIA_VISIBLE_DEVICES={visible} must read the first device visible in the container: {observed}"
    finally:
        if original_module is None:
            sys.modules.pop("pynvml", None)
        else:
            sys.modules["pynvml"] = original_module
        if original_visible is None:
            os.environ.pop("NVIDIA_VISIBLE_DEVICES", None)
        else:
            os.environ["NVIDIA_VISIBLE_DEVICES"] = original_visible


async def main() -> None:
    gateway.COSYVOICE_MODEL_KIND = "zero_shot"
    gateway.COSYVOICE_VOICE_LIBRARY_DIR = str(pathlib.Path(tempfile.gettempdir()).resolve() / "shuzhiren-voices-not-required-at-startup")
    await check_unauthenticated_surfaces()
    check_gpu_index()
    await reject("")
    await reject("short")
    await reject("this token contains whitespace and is invalid")

    gateway.RUNTIME_TOKEN = "g" * 32
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = False
    async with gateway.lifespan(gateway.app):
        pass
    gateway.authorize(f"Bearer {'g' * 32}")
    try:
        gateway.authorize(f"Bearer {'g' * 31}x")
    except HTTPException as error:
        assert error.status_code == 401
    else:
        raise AssertionError("Runtime Gateway must reject a mismatched shared token")

    await reject_configuration("COSYVOICE_SAMPLE_RATE", 7_999, "COSYVOICE_SAMPLE_RATE")
    await reject_configuration("REQUEST_TIMEOUT_SECONDS", math.inf, "RUNTIME_REQUEST_TIMEOUT_SECONDS")
    await reject_configuration("MEDIA_COMMAND_CACHE_TTL_SECONDS", 0, "MEDIA_COMMAND_CACHE_TTL_SECONDS")
    await reject_configuration("MEDIA_COMMAND_CACHE_MAX_ENTRIES", 0, "MEDIA_COMMAND_CACHE_MAX_ENTRIES")
    await reject_configuration("LIVE_TALKING_URL", "ftp://untrusted.example", "LIVETALKING_BASE_URL")
    await reject_configuration("FALLBACK_AUDIOTYPE", gateway.PROGRAM_AUDIOTYPE, "must be distinct")
    for kind in ("", "SFT", "zeroshot", "livetalking"):
        await reject_configuration("COSYVOICE_MODEL_KIND", kind, "COSYVOICE_MODEL_KIND must be sft or zero_shot")
    await reject_configuration("COSYVOICE_VOICE_LIBRARY_DIR", "", "COSYVOICE_VOICE_LIBRARY_DIR")
    await reject_configuration("COSYVOICE_CHUNK_MAX_CHARS", 19, "COSYVOICE_CHUNK_MAX_CHARS")
    await reject_configuration("COSYVOICE_CHUNK_MAX_CHARS", 801, "COSYVOICE_CHUNK_MAX_CHARS")
    await reject_configuration("RUNTIME_COMMAND_DEADLINE_SECONDS", 60, "RUNTIME_COMMAND_DEADLINE_SECONDS")
    gateway.COSYVOICE_MODEL_KIND = "sft"
    gateway.COSYVOICE_VOICE_LIBRARY_DIR = ""
    async with gateway.lifespan(gateway.app):
        pass
    gateway.COSYVOICE_MODEL_KIND = "zero_shot"
    gateway.COSYVOICE_VOICE_LIBRARY_DIR = str(pathlib.Path(tempfile.gettempdir()).resolve() / "shuzhiren-voices-not-required-at-startup")

    gateway.PREVIEW_BROKER_URL = "https://preview-broker.example"
    gateway.PREVIEW_BROKER_TOKEN = ""
    try:
        async with gateway.lifespan(gateway.app):
            raise AssertionError("Runtime Gateway must reject a preview broker without its dedicated token")
    except RuntimeError as error:
        assert "PREVIEW_BROKER_URL and PREVIEW_BROKER_TOKEN" in str(error)
    finally:
        gateway.PREVIEW_BROKER_URL = ""

    gateway.PREVIEW_BROKER_URL = "ftp://untrusted.example"
    gateway.PREVIEW_BROKER_TOKEN = "p" * 32
    try:
        async with gateway.lifespan(gateway.app):
            raise AssertionError("Runtime Gateway must reject an unsafe preview broker URL")
    except RuntimeError as error:
        assert "PREVIEW_BROKER_URL" in str(error)
    finally:
        gateway.PREVIEW_BROKER_URL = ""
        gateway.PREVIEW_BROKER_TOKEN = ""

    valid_preview = gateway.validate_preview_grant({
        "url": "https://preview-broker.example/embed/session",
        "mode": "webrtc",
        "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(),
    })
    assert valid_preview["mode"] == "webrtc"
    try:
        gateway.validate_preview_grant({
            "url": "rtmp://preview-broker.example/embed/session",
            "mode": "webrtc",
            "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(),
        })
    except HTTPException as error:
        assert error.status_code == 502
    else:
        raise AssertionError("Runtime Gateway must reject non-HTTPS preview grants")

    with tempfile.TemporaryDirectory() as directory:
        blocked_parent = pathlib.Path(directory) / "not-a-directory"
        blocked_parent.write_text("blocked", encoding="utf-8")
        gateway.RUNTIME_COMMAND_JOURNAL_PATH = str(blocked_parent / "commands.sqlite3")
        gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = True
        try:
            async with gateway.lifespan(gateway.app):
                raise AssertionError("Runtime Gateway must reject an unavailable required command journal before startup")
        except RuntimeError as error:
            assert "command journal" in str(error).lower()


asyncio.run(main())

print("PASS  Runtime Gateway rejects unsafe startup configuration")
