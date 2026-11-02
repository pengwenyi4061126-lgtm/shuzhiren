import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
import app as gateway


async def main() -> None:
    gateway.RUNTIME_TOKEN = "test-runtime-token"
    gateway.runtime_command_cache.clear()
    gateway.runtime_command_locks.clear()
    calls: list[tuple[str, dict]] = []
    active_calls = 0
    max_active_calls = 0

    async def livetalking_post(path: str, payload: dict) -> dict:
        nonlocal active_calls, max_active_calls
        calls.append((path, payload))
        active_calls += 1
        max_active_calls = max(max_active_calls, active_calls)
        await asyncio.sleep(0.02)
        active_calls -= 1
        return {"code": 0}

    gateway.livetalking_post = livetalking_post
    authorization = "Bearer test-runtime-token"

    first, retry = await asyncio.gather(
        gateway.media(gateway.MediaRequest(command_id="command_same", session_id="session_1", action="start_program"), authorization),
        gateway.media(gateway.MediaRequest(command_id="command_same", session_id="session_1", action="start_program"), authorization),
    )
    assert first["duplicate"] is False
    assert retry["duplicate"] is True
    assert len(calls) == 2, "a retried media command must not replay downstream actions"

    await asyncio.gather(
        gateway.media(gateway.MediaRequest(command_id="command_alpha", session_id="session_1", action="switch_to_fallback"), authorization),
        gateway.media(gateway.MediaRequest(command_id="command_beta", session_id="session_2", action="switch_to_human"), authorization),
    )
    assert max_active_calls > 1, "different command IDs must not be serialized by a global lock"
    assert gateway.runtime_command_locks == {}, "completed commands must release their per-command locks"


asyncio.run(main())
print("PASS  Runtime Gateway deduplicates retries without serializing independent commands")
