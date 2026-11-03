import asyncio
import math
import pathlib
import sys
import tempfile

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


async def main() -> None:
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
