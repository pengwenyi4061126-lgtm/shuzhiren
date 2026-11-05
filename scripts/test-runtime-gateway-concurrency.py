import asyncio
import hashlib
import pathlib
import sqlite3
import sys
import tempfile
from pydantic import ValidationError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
import app as gateway


async def main() -> None:
    gateway.RUNTIME_TOKEN = "test-runtime-token"
    gateway.runtime_command_cache.clear()
    gateway.runtime_command_locks.clear()
    journal_dir = tempfile.TemporaryDirectory()
    gateway.RUNTIME_COMMAND_JOURNAL_PATH = str(pathlib.Path(journal_dir.name) / "commands.sqlite3")
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = True
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

    gateway.runtime_command_cache.clear()
    after_restart = await gateway.media(gateway.MediaRequest(command_id="command_same", session_id="session_1", action="start_program"), authorization)
    assert after_restart["duplicate"] is True
    assert len(calls) == 2, "a completed command must survive an in-memory cache loss without replaying downstream actions"
    stored = await gateway.reserve_runtime_command("command_same", "media", {"session_id": "session_1", "action": "start_program", "program_segment_id": None, "script_sha256": None})
    assert stored is not None and stored["duplicate"] is True and stored["receipt"] == first["receipt"], "reserving a completed command id must return its stored result instead of allowing a second execution"

    def journal_rows() -> list[tuple]:
        connection = sqlite3.connect(gateway.RUNTIME_COMMAND_JOURNAL_PATH)
        try:
            return connection.execute("select * from runtime_command_journal order by command_id").fetchall()
        finally:
            connection.close()

    synthesis_calls: list[tuple[str, str]] = []
    audio_calls: list[tuple[str, bytes]] = []

    async def cosyvoice_synthesize(text: str, speaker: str) -> bytes:
        synthesis_calls.append((text, speaker))
        return b"speech-audio"

    async def livetalking_audio(session_id: str, audio: bytes) -> None:
        audio_calls.append((session_id, audio))

    gateway.cosyvoice_synthesize = cosyvoice_synthesize
    gateway.livetalking_audio = livetalking_audio
    rows_before_rejections = journal_rows()
    calls_before_rejections = len(calls)
    for invalid_voice in (None, ""):
        try:
            await gateway.speak(gateway.SpeakRequest(command_id="speech_after_rejection", session_id="session_1", text="Welcome to the show.", voice=invalid_voice, provider="cosyvoice"), authorization)
        except gateway.HTTPException as error:
            assert error.status_code == 400
        else:
            raise AssertionError("a CosyVoice speech command without a speaker id must be rejected")
    try:
        await gateway.speak(gateway.SpeakRequest(command_id="speech_after_rejection", session_id="session_1", text="Welcome to the show.", voice="speaker_1", provider="cosyvoice"), "Bearer wrong-token")
    except gateway.HTTPException as error:
        assert error.status_code == 401
    else:
        raise AssertionError("a speech command with the wrong token must be rejected")
    assert journal_rows() == rows_before_rejections, "rejected speech requests must not reserve their command id"
    accepted_speech = await gateway.speak(gateway.SpeakRequest(command_id="speech_after_rejection", session_id="session_1", text="Welcome to the show.", voice="speaker_1", provider="cosyvoice"), authorization)
    assert accepted_speech["duplicate"] is False, "a valid command must run after an invalid request with the same command id"
    assert synthesis_calls == [("Welcome to the show.", "speaker_1")]
    assert audio_calls == [("session_1", b"speech-audio")]
    repeated_speech = await gateway.speak(gateway.SpeakRequest(command_id="speech_after_rejection", session_id="session_1", text="Welcome to the show.", voice="speaker_1", provider="cosyvoice"), authorization)
    assert repeated_speech["duplicate"] is True
    assert len(synthesis_calls) == 1 and len(audio_calls) == 1 and len(calls) == calls_before_rejections, "a completed speech retry must not call downstream services"
    try:
        await gateway.speak(gateway.SpeakRequest(command_id="speech_after_rejection", session_id="session_1", text="A different line.", voice="speaker_1", provider="cosyvoice"), authorization)
    except gateway.HTTPException as error:
        assert error.status_code == 409
        assert "different payload" in error.detail
    else:
        raise AssertionError("a completed command id reused for a different payload must be rejected")

    frozen_script = "This is an approved frozen program script."
    approved_segment_id = "10000000-0000-4000-8000-000000000001"
    started = await gateway.media(gateway.MediaRequest(command_id="command_start_frozen", session_id="session_1", action="start_program", program_segment_id=approved_segment_id, program_script=frozen_script, script_sha256=hashlib.sha256(frozen_script.encode("utf-8")).hexdigest()), authorization)
    assert started["receipt"]["program_segment_id"] == approved_segment_id
    assert any(path == "/human" and payload["text"] == frozen_script for path, payload in calls), "a governed start must deliver the frozen baseline script to LiveTalking"
    inserted = await gateway.media(gateway.MediaRequest(command_id="command_insert", session_id="session_1", action="insert_program", program_segment_id=approved_segment_id, program_script=frozen_script, script_sha256=hashlib.sha256(frozen_script.encode("utf-8")).hexdigest()), authorization)
    assert inserted["accepted"] is True
    assert inserted["receipt"]["program_segment_id"] == approved_segment_id
    assert any(path == "/human" and payload["text"] == frozen_script for path, payload in calls), "a governed insertion must deliver the frozen script to LiveTalking"
    rows_before_rejection = journal_rows()
    try:
        await gateway.media(gateway.MediaRequest(command_id="command_bad_script", session_id="session_1", action="insert_program", program_segment_id=approved_segment_id, program_script=frozen_script, script_sha256="0" * 64), authorization)
    except gateway.HTTPException as error:
        assert error.status_code == 400
    else:
        raise AssertionError("a mismatched frozen script hash must be rejected")
    assert journal_rows() == rows_before_rejection, "a rejected media request must not reserve its command id"
    calls_before_valid_insert = len(calls)
    corrected = await gateway.media(gateway.MediaRequest(command_id="command_bad_script", session_id="session_1", action="insert_program", program_segment_id=approved_segment_id, program_script=frozen_script, script_sha256=hashlib.sha256(frozen_script.encode("utf-8")).hexdigest()), authorization)
    assert corrected["duplicate"] is False, "a valid media command must run after an invalid request with the same command id"
    assert [path for path, _payload in calls[calls_before_valid_insert:]] == ["/interrupt_talk", "/set_audiotype", "/human"]
    try:
        gateway.MediaRequest(command_id="command_bad_segment", session_id="session_1", action="insert_program", program_segment_id="not-a-uuid", program_script=frozen_script, script_sha256=hashlib.sha256(frozen_script.encode("utf-8")).hexdigest())
    except ValidationError:
        pass
    else:
        raise AssertionError("a governed program transition must require a UUID segment identifier")

    async def unknown_outcome(path: str, payload: dict) -> dict:
        calls.append((path, payload))
        raise gateway.HTTPException(status_code=502, detail="downstream outcome unknown")

    gateway.livetalking_post = unknown_outcome
    try:
        await gateway.media(gateway.MediaRequest(command_id="command_uncertain", session_id="session_1", action="switch_to_fallback"), authorization)
    except gateway.HTTPException as error:
        assert error.status_code == 502
    else:
        raise AssertionError("an uncertain downstream result must surface to the caller")
    calls_before_uncertain_retry = len(calls)
    gateway.livetalking_post = livetalking_post
    try:
        await gateway.media(gateway.MediaRequest(command_id="command_uncertain", session_id="session_1", action="switch_to_fallback"), authorization)
    except gateway.HTTPException as error:
        assert error.status_code == 409
    else:
        raise AssertionError("an uncertain command must not be automatically replayed")
    assert len(calls) == calls_before_uncertain_retry, "an uncertain command retry must not call the downstream runtime again"

    await asyncio.gather(
        gateway.media(gateway.MediaRequest(command_id="command_alpha", session_id="session_1", action="switch_to_fallback"), authorization),
        gateway.media(gateway.MediaRequest(command_id="command_beta", session_id="session_2", action="switch_to_human"), authorization),
    )
    assert max_active_calls > 1, "different command IDs must not be serialized by a global lock"
    assert gateway.runtime_command_locks == {}, "completed commands must release their per-command locks"
    journal_dir.cleanup()


asyncio.run(main())
print("PASS  Runtime Gateway preserves completed commands across restarts and blocks uncertain replays")
