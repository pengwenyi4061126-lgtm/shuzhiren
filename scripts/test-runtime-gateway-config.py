import asyncio
import pathlib
import sys
import tempfile

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


async def main() -> None:
    await reject("")
    await reject("short")
    await reject("this token contains whitespace and is invalid")

    gateway.RUNTIME_TOKEN = "g" * 32
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = False
    async with gateway.lifespan(gateway.app):
        pass

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

print("PASS  Runtime Gateway rejects weak shared tokens before startup")
