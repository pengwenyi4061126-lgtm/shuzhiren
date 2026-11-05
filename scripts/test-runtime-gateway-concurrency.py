import asyncio
import hashlib
import json
import pathlib
import random
import re
import sqlite3
import sys
import tempfile
import threading
import time
import types
import wave
from io import BytesIO
from urllib.parse import parse_qs

import httpx
from pydantic import ValidationError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
import app as gateway

RealAsyncClient = httpx.AsyncClient
SEGMENT_ID = "20000000-0000-4000-8000-000000000002"


def form_fields(request: httpx.Request) -> dict:
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        boundary = content_type.split("boundary=", 1)[1].encode("latin-1")
        fields = {}
        for part in request.content.split(b"--" + boundary)[1:-1]:
            head, _, value = part[2:].partition(b"\r\n\r\n")
            fields[re.search(rb'name="([^"]+)"', head).group(1).decode("utf-8")] = value[:-2]
        return fields
    return {key: values[0].encode("utf-8") for key, values in parse_qs(request.content.decode("utf-8"), keep_blank_values=True).items()}


def chunk_pcm(index: int, text: str) -> bytes:
    return bytes([index % 251 + 1, 0]) * max(1, len(text))


class InterruptedStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b"\x01\x00"
        raise httpx.ReadError("connection reset while streaming")


class Upstreams:
    """CosyVoice and LiveTalking behind one httpx MockTransport; records every request in order."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict]] = []
        self.cosyvoice = None
        self.humanaudio_code = 0
        self.openapi_status = 200

    def paths(self, host: str) -> list[str]:
        return [path for request_host, path, _fields in self.requests if request_host == host]

    def inference_count(self) -> int:
        return sum(1 for path in self.paths("cosyvoice") if path.startswith("/inference_"))

    async def handler(self, request: httpx.Request) -> httpx.Response:
        host, path = request.url.host, request.url.path
        fields = form_fields(request) if request.method == "POST" else {}
        self.requests.append((host, path, fields))
        if host == "cosyvoice":
            if path == "/openapi.json":
                if self.openapi_status is None:
                    raise httpx.ConnectError("cosyvoice is not listening", request=request)
                return httpx.Response(self.openapi_status, json={})
            index = self.inference_count() - 1
            if self.cosyvoice is not None:
                return await self.cosyvoice(request, index, fields)
            return httpx.Response(200, content=chunk_pcm(index, fields["tts_text"].decode("utf-8")))
        if path == "/humanaudio":
            return httpx.Response(200, json={"code": self.humanaudio_code})
        return httpx.Response(200, json={"code": 0, "data": {"sessions": []}})


def journal_ids() -> set[str]:
    connection = sqlite3.connect(gateway.RUNTIME_COMMAND_JOURNAL_PATH)
    try:
        return {row[0] for row in connection.execute("select command_id from runtime_command_journal")}
    finally:
        connection.close()


def check_split_script() -> None:
    generator = random.Random(15)
    alphabet = list("直播间欢迎大家今天介绍这款产品价格优惠abcXYZ0123456789 ，,、：:。！？!?；;…\n”’」』）)】》\"'-")
    for _case in range(2000):
        max_chars = generator.randint(20, 800)
        text = "".join(generator.choice(alphabet) for _ in range(generator.randint(1, 800)))
        if generator.random() < 0.1:
            text = "长" * generator.randint(1, 800)
        segments = gateway.split_script(text, max_chars)
        assert "".join(segments) == text, "splitting must not change the script"
        assert all(segments), "every CosyVoice request must carry text"
        if gateway.pronounceable(text):
            assert all(gateway.pronounceable(segment) for segment in segments), "a segment without pronounceable characters would yield no audio"
        for segment in segments:
            core = segment
            while core and not gateway.pronounceable(core[0]):
                core = core[1:]
            while core and not gateway.pronounceable(core[-1]):
                core = core[:-1]
            assert len(core) <= max_chars, (max_chars, segment)


async def expect_failure(operation, status: int, source: str | None = None, reason: str | None = None):
    try:
        await operation
    except gateway.HTTPException as error:
        assert error.status_code == status, (error.status_code, error.detail)
        if source is not None:
            assert isinstance(error, gateway.CommandFailure), error.detail
            body = error.body()
            assert body["failure_source"] == source and body["failure_reason"] == reason and body["code"] == "command_failed_definite", body
            assert "private" not in error.detail
        return error
    raise AssertionError(f"expected HTTP {status}")


async def check_cosyvoice_audio_path() -> None:
    """D2: program scripts and speech are synthesized by CosyVoice and injected through /humanaudio."""
    check_split_script()
    upstreams = Upstreams()
    original_client = gateway.httpx.AsyncClient
    gateway.httpx.AsyncClient = lambda **kwargs: RealAsyncClient(transport=httpx.MockTransport(upstreams.handler), **kwargs)
    journal_dir = tempfile.TemporaryDirectory()
    voice_dir = tempfile.TemporaryDirectory()
    gateway.RUNTIME_TOKEN = "test-runtime-token"
    gateway.RUNTIME_COMMAND_JOURNAL_PATH = str(pathlib.Path(journal_dir.name) / "commands.sqlite3")
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = True
    gateway.COSYVOICE_CHUNK_MAX_CHARS = 40
    gateway.COSYVOICE_VOICE_LIBRARY_DIR = voice_dir.name
    authorization = "Bearer test-runtime-token"
    prompt_wav = gateway.pcm_s16le_to_wav(b"\x05\x00" * 1600, 16000)
    prompt_text = "You are a helpful assistant.<|endofprompt|>欢迎来到直播间。"
    (pathlib.Path(voice_dir.name) / "approved_voice").mkdir()
    (pathlib.Path(voice_dir.name) / "approved_voice" / "prompt.wav").write_bytes(prompt_wav)
    (pathlib.Path(voice_dir.name) / "approved_voice" / "prompt.txt").write_text(prompt_text + "\n", encoding="utf-8")
    checksum = "sha256:" + hashlib.sha256(prompt_wav).hexdigest().upper()
    script = "欢迎来到直播间！今天给大家介绍一款新品，它的价格非常实惠。\n\n" + "This approved frozen script is long enough to need several CosyVoice requests, " * 3 + "谢谢大家！"

    def program(command_id: str, action: str = "insert_program", **overrides):
        fields = {"program_segment_id": SEGMENT_ID, "program_script": script, "script_sha256": hashlib.sha256(script.encode("utf-8")).hexdigest(), "runtime_voice_id": "approved_voice", "voice_checksum": checksum, **overrides}
        return gateway.MediaRequest(command_id=command_id, session_id="session_1", action=action, **fields)

    def assert_program_audio(first_request: int, expected_text: str) -> None:
        requests = upstreams.requests[first_request:]
        cosy = [(path, fields) for host, path, fields in requests if host == "cosyvoice"]
        livetalking = [(path, fields) for host, path, fields in requests if host == "livetalking"]
        assert len(cosy) > 1, "a long script must be synthesized in several segments"
        assert "".join(fields["tts_text"].decode("utf-8") for _path, fields in cosy) == expected_text, "the segments must add up to the frozen text"
        assert all(path == "/inference_zero_shot" and fields["prompt_wav"] == prompt_wav and fields["prompt_text"].decode("utf-8") == prompt_text for path, fields in cosy), "zero-shot requests must upload the approved reference audio and transcript"
        hosts = [host for host, _path, _fields in requests]
        assert hosts.index("livetalking") > max(index for index, host in enumerate(hosts) if host == "cosyvoice"), "every CosyVoice request must finish before LiveTalking is driven"
        audio = [fields for path, fields in livetalking if path == "/humanaudio"]
        assert len(audio) == 1 and audio[0]["sessionid"] == b"session_1", "the synthesized speech must be injected once through /humanaudio"
        with wave.open(BytesIO(audio[0]["file"]), "rb") as reader:
            assert reader.getframerate() == gateway.COSYVOICE_SAMPLE_RATE and reader.getnchannels() == 1 and reader.getsampwidth() == 2
            frames = reader.readframes(reader.getnframes())
        assert frames == b"".join(chunk_pcm(index, fields["tts_text"].decode("utf-8")) for index, (_path, fields) in enumerate(cosy, start=upstreams.inference_count() - len(cosy))), "the WAV must hold every segment's PCM in order"

    try:
        gateway.COSYVOICE_MODEL_KIND = "zero_shot"
        first = len(upstreams.requests)
        started = await gateway.media(program("cv_start", "start_program"), authorization)
        assert_program_audio(first, script)
        assert [path for host, path, _ in upstreams.requests[first:] if host == "livetalking"] == ["/interrupt_talk", "/set_audiotype", "/record", "/humanaudio"]
        assert started["downstream_actions"] == ["interrupt_talk", "set_program_audiotype", "start_record", "play_frozen_program_script"]
        assert started["synthesis"]["model_kind"] == "zero_shot" and started["synthesis"]["chunks"] > 1
        for action in ("insert_program", "resume_program"):
            first = len(upstreams.requests)
            result = await gateway.media(program(f"cv_{action}", action), authorization)
            assert_program_audio(first, script)
            assert [path for host, path, _ in upstreams.requests[first:] if host == "livetalking"] == ["/interrupt_talk", "/set_audiotype", "/humanaudio"]
            assert result["downstream_actions"] == ["interrupt_talk", "set_program_audiotype", "play_frozen_program_script"]
        for provider in ("cosyvoice", "livetalking"):
            first = len(upstreams.requests)
            spoken = await gateway.speak(gateway.SpeakRequest(command_id=f"cv_speech_{provider}", session_id="session_1", text=script, interrupt=True, voice="approved_voice", voice_checksum=checksum, provider=provider), authorization)
            assert_program_audio(first, script)
            assert [path for host, path, _ in upstreams.requests[first:] if host == "livetalking"] == ["/interrupt_talk", "/humanaudio"]
            assert spoken["provider"] == "cosyvoice_to_livetalking" and spoken["requested_provider"] == provider
        unscripted_first = len(upstreams.requests)
        await gateway.media(gateway.MediaRequest(command_id="cv_start_unscripted", session_id="session_1", action="start_program"), authorization)
        assert [path for _host, path, _ in upstreams.requests[unscripted_first:]] == ["/set_audiotype", "/record"], "a start without a script must not synthesize anything"

        gateway.COSYVOICE_MODEL_KIND = "sft"
        first = len(upstreams.requests)
        await gateway.speak(gateway.SpeakRequest(command_id="cv_speech_sft", session_id="session_1", text="欢迎来到直播间。", voice="sft_speaker"), authorization)
        cosy = [(path, fields) for host, path, fields in upstreams.requests[first:] if host == "cosyvoice"]
        assert cosy == [("/inference_sft", {"tts_text": "欢迎来到直播间。".encode("utf-8"), "spk_id": b"sft_speaker"})], cosy
        gateway.COSYVOICE_MODEL_KIND = "zero_shot"
        assert "/human" not in upstreams.paths("livetalking"), "the Gateway must never send text to LiveTalking's own TTS"

        before = len(upstreams.requests)
        try:
            await gateway.livetalking_post("/human", {"sessionid": "session_1", "text": script})
        except RuntimeError:
            pass
        else:
            raise AssertionError("livetalking_post must refuse /human")
        assert len(upstreams.requests) == before

        for index, (field, value) in enumerate([("runtime_voice_id", None), ("runtime_voice_id", ""), ("runtime_voice_id", "-a"), ("runtime_voice_id", "a/b"), ("runtime_voice_id", "a.b"), ("runtime_voice_id", "a" * 129), ("runtime_voice_id", "声线"), ("runtime_voice_id", "voice\n"), ("voice_checksum", None), ("voice_checksum", "sha256:" + "0" * 63), ("voice_checksum", hashlib.sha256(prompt_wav).hexdigest())]):
            command_id = f"cv_invalid_voice_{index}"
            await expect_failure(gateway.media(program(command_id, **{field: value}), authorization), 400)
            assert len(upstreams.requests) == before and command_id not in journal_ids(), "an invalid voice binding must be rejected before any upstream call or reservation"
        await expect_failure(gateway.media(gateway.MediaRequest(command_id="cv_voice_without_script", session_id="session_1", action="stop_program", runtime_voice_id="approved_voice"), authorization), 400)
        await expect_failure(gateway.speak(gateway.SpeakRequest(command_id="cv_speech_no_checksum", session_id="session_1", text="hello", voice="approved_voice"), authorization), 400)
        await expect_failure(gateway.speak(gateway.SpeakRequest(command_id="cv_speech_punctuation", session_id="session_1", text="。！…", voice="approved_voice", voice_checksum=checksum), authorization), 400)
        recovered = await gateway.media(program("cv_invalid_voice_0"), authorization)
        assert recovered["duplicate"] is False, "the corrected command must run under the id of the rejected one"

        (pathlib.Path(voice_dir.name) / "approved_voice" / "prompt.wav").write_bytes(prompt_wav[:-1] + b"\x06")
        before = len(upstreams.requests)
        await expect_failure(gateway.media(program("cv_tampered_voice"), authorization), 503, "voice_library", "voice_material_checksum_mismatch")
        await expect_failure(gateway.media(program("cv_missing_voice", runtime_voice_id="unknown_voice"), authorization), 503, "voice_library", "voice_material_missing")
        assert len(upstreams.requests) == before and not {"cv_tampered_voice", "cv_missing_voice"} & journal_ids(), "voice material problems must not reach upstreams or the journal"
        (pathlib.Path(voice_dir.name) / "approved_voice" / "prompt.wav").write_bytes(prompt_wav)

        async def refuse(request, _index, _fields):
            raise httpx.ConnectError("cosyvoice private address unreachable", request=request)

        async def server_error(_request, _index, _fields):
            return httpx.Response(500, content=b"private traceback")

        async def interrupted(_request, _index, _fields):
            return httpx.Response(200, stream=InterruptedStream())

        async def empty(_request, _index, _fields):
            return httpx.Response(200, content=b"")

        async def odd(_request, _index, _fields):
            return httpx.Response(200, content=b"\x01\x00\x02")

        async def slow(_request, _index, _fields):
            await asyncio.sleep(2)
            return httpx.Response(200, content=b"\x01\x00")

        async def too_long(_request, _index, _fields):
            return httpx.Response(200, content=b"\x01\x00" * 1000)

        def on_later_chunk(failure):
            async def respond(request, index, fields):
                if index >= failure_chunk[0]:
                    return await failure(request, index, fields)
                return httpx.Response(200, content=chunk_pcm(index, fields["tts_text"].decode("utf-8")))
            return respond

        failure_chunk = [0]
        scenarios = [(refuse, 502, "cosyvoice_unreachable"), (server_error, 502, "cosyvoice_http_status"), (interrupted, 502, "cosyvoice_stream_interrupted"), (empty, 502, "cosyvoice_empty_audio"), (odd, 502, "cosyvoice_odd_audio_length"), (too_long, 502, "cosyvoice_audio_too_long"), (slow, 504, "cosyvoice_deadline_exceeded")]
        original_deadline, original_audio_seconds = gateway.RUNTIME_COMMAND_DEADLINE_SECONDS, gateway.COSYVOICE_MAX_AUDIO_SECONDS
        for scenario_index, (failure, status, reason) in enumerate(scenarios):
            for later in (False, True):
                command_id = f"cv_failure_{scenario_index}_{int(later)}"
                cosy_before = upstreams.inference_count()
                failure_chunk[0] = cosy_before + 2 if later else cosy_before
                upstreams.cosyvoice = on_later_chunk(failure)
                gateway.RUNTIME_COMMAND_DEADLINE_SECONDS = 1 if failure is slow else original_deadline
                # 480 bytes: more than two 40-character segments, less than one oversized response.
                gateway.COSYVOICE_MAX_AUDIO_SECONDS = 0.01 if failure is too_long else original_audio_seconds
                livetalking_before = len(upstreams.paths("livetalking"))
                error = await expect_failure(gateway.media(program(command_id), authorization), status, "cosyvoice", reason)
                assert error.chunk_index == (2 if later else 0), (reason, error.chunk_index)
                if failure is server_error:
                    assert error.upstream_status == 500
                assert len(upstreams.paths("livetalking")) == livetalking_before, f"{reason}: a CosyVoice failure must not reach LiveTalking"
                upstreams.cosyvoice = None
                gateway.RUNTIME_COMMAND_DEADLINE_SECONDS, gateway.COSYVOICE_MAX_AUDIO_SECONDS = original_deadline, original_audio_seconds
                retried = await gateway.media(program(command_id), authorization)
                assert retried["duplicate"] is False, f"{reason}: a command that never reached LiveTalking must be retryable under its id"

        upstreams.humanaudio_code = 1
        await expect_failure(gateway.media(program("cv_humanaudio_rejected"), authorization), 502)
        upstreams.humanaudio_code = 0

        gateway.COSYVOICE_REQUIRED = True
        for status, healthy in ((200, True), (204, False), (301, False), (500, False), (None, False)):
            upstreams.openapi_status = status
            health = await gateway.healthz()
            body = json.loads(health.body)
            assert (health.status_code == 200) is healthy and body["dependencies"]["cosyvoice"]["available"] is healthy, (status, health.status_code, body)
            assert body["dependencies"]["cosyvoice"]["model_kind"] == "zero_shot"
        upstreams.openapi_status = 200
    finally:
        gateway.COSYVOICE_REQUIRED = False
        gateway.httpx.AsyncClient = original_client
        gateway.runtime_command_cache.clear()
        journal_dir.cleanup()
        voice_dir.cleanup()


async def main() -> None:
    await check_cosyvoice_audio_path()
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
    speech_pcm = b"\x01\x00\x02\x00"

    async def cosyvoice_synthesize(text: str, voice, deadline: float):
        synthesis_calls.append((text, voice.runtime_voice_id))
        return gateway.SynthesisResult(pcm=speech_pcm, chunks=1, synth_ms=0)

    async def livetalking_audio(session_id: str, audio: bytes) -> None:
        audio_calls.append((session_id, audio))

    speech_wav = gateway.pcm_s16le_to_wav(speech_pcm, gateway.COSYVOICE_SAMPLE_RATE)
    gateway.COSYVOICE_MODEL_KIND = "sft"
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
    assert audio_calls == [("session_1", speech_wav)]
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
    voice = {"runtime_voice_id": "speaker_1"}
    calls_before_start = len(calls)
    started = await gateway.media(gateway.MediaRequest(command_id="command_start_frozen", session_id="session_1", action="start_program", program_segment_id=approved_segment_id, program_script=frozen_script, script_sha256=hashlib.sha256(frozen_script.encode("utf-8")).hexdigest(), **voice), authorization)
    assert started["receipt"]["program_segment_id"] == approved_segment_id
    assert synthesis_calls[-1] == (frozen_script, "speaker_1") and audio_calls[-1] == ("session_1", speech_wav), "a governed start must play the frozen baseline script as CosyVoice audio"
    assert [path for path, _payload in calls[calls_before_start:]] == ["/interrupt_talk", "/set_audiotype", "/record"]
    assert started["downstream_actions"] == ["interrupt_talk", "set_program_audiotype", "start_record", "play_frozen_program_script"]
    inserted = await gateway.media(gateway.MediaRequest(command_id="command_insert", session_id="session_1", action="insert_program", program_segment_id=approved_segment_id, program_script=frozen_script, script_sha256=hashlib.sha256(frozen_script.encode("utf-8")).hexdigest(), **voice), authorization)
    assert inserted["accepted"] is True
    assert inserted["receipt"]["program_segment_id"] == approved_segment_id
    assert len(audio_calls) == 3, "a governed insertion must play the frozen script as CosyVoice audio"
    assert all(path != "/human" for path, _payload in calls), "the Gateway must never ask LiveTalking to synthesize text"
    rows_before_rejection = journal_rows()
    try:
        await gateway.media(gateway.MediaRequest(command_id="command_bad_script", session_id="session_1", action="insert_program", program_segment_id=approved_segment_id, program_script=frozen_script, script_sha256="0" * 64, **voice), authorization)
    except gateway.HTTPException as error:
        assert error.status_code == 400
    else:
        raise AssertionError("a mismatched frozen script hash must be rejected")
    assert journal_rows() == rows_before_rejection, "a rejected media request must not reserve its command id"
    calls_before_valid_insert = len(calls)
    corrected = await gateway.media(gateway.MediaRequest(command_id="command_bad_script", session_id="session_1", action="insert_program", program_segment_id=approved_segment_id, program_script=frozen_script, script_sha256=hashlib.sha256(frozen_script.encode("utf-8")).hexdigest(), **voice), authorization)
    assert corrected["duplicate"] is False, "a valid media command must run after an invalid request with the same command id"
    assert [path for path, _payload in calls[calls_before_valid_insert:]] == ["/interrupt_talk", "/set_audiotype"]
    assert len(audio_calls) == 4
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

    await check_event_loop_stays_responsive(authorization, calls, journal_rows)
    journal_dir.cleanup()


def hold_journal_write_lock(path: str, seconds: float, ready: threading.Event) -> None:
    connection = sqlite3.connect(path, isolation_level=None)
    try:
        connection.execute("begin immediate")
        ready.set()
        time.sleep(seconds)
        connection.execute("rollback")
    finally:
        connection.close()


async def healthz_latency_during(operation) -> tuple[float, object]:
    """Start operation, ask /healthz 100 ms later, and return how late /healthz answered."""
    task = asyncio.create_task(operation)
    due = time.monotonic() + 0.1
    await asyncio.sleep(0.1)
    health = await gateway.healthz()
    latency = time.monotonic() - due
    assert health.status_code == 200, health.body
    return latency, await task


async def check_event_loop_stays_responsive(authorization: str, calls: list, journal_rows) -> None:
    async def available(_url: str, _path: str, expected_code: int | None = None) -> dict:
        return {"available": True}

    gateway.service_health = available

    ready = threading.Event()
    holder = threading.Thread(target=hold_journal_write_lock, args=(gateway.RUNTIME_COMMAND_JOURNAL_PATH, 1.5, ready))
    holder.start()
    ready.wait()
    try:
        latency, result = await healthz_latency_during(gateway.media(gateway.MediaRequest(command_id="command_while_journal_locked", session_id="session_1", action="stop_program"), authorization))
    finally:
        holder.join()
    assert latency < 1.0, f"/healthz must answer while a command waits for the journal write lock (answered {latency:.2f}s late)"
    assert result["duplicate"] is False, "a command must proceed once the journal write lock is released"

    original_busy_timeout = getattr(gateway, "JOURNAL_BUSY_TIMEOUT_SECONDS", None)
    gateway.JOURNAL_BUSY_TIMEOUT_SECONDS = 0.2
    ready = threading.Event()
    holder = threading.Thread(target=hold_journal_write_lock, args=(gateway.RUNTIME_COMMAND_JOURNAL_PATH, 1.0, ready))
    holder.start()
    ready.wait()
    calls_before_busy = len(calls)
    try:
        await gateway.media(gateway.MediaRequest(command_id="command_journal_busy", session_id="session_1", action="stop_program"), authorization)
    except gateway.HTTPException as error:
        assert error.status_code == 503, error.status_code
        assert error.detail == "Runtime command journal is unavailable"
    else:
        raise AssertionError("a command must be refused while the journal stays locked past the busy timeout")
    finally:
        holder.join()
        gateway.JOURNAL_BUSY_TIMEOUT_SECONDS = original_busy_timeout
    assert len(calls) == calls_before_busy, "a command that could not be reserved must not reach LiveTalking"
    assert all(row[0] != "command_journal_busy" for row in journal_rows()), "a refused command must not leave a journal row"
    retried = await gateway.media(gateway.MediaRequest(command_id="command_journal_busy", session_id="session_1", action="stop_program"), authorization)
    assert retried["duplicate"] is False, "a command refused for a busy journal must run when retried"

    slow_nvml = types.ModuleType("pynvml")
    slow_nvml.nvmlInit = lambda: time.sleep(1.5)
    slow_nvml.nvmlShutdown = lambda: None
    slow_nvml.nvmlDeviceGetHandleByIndex = lambda _index: "device"
    slow_nvml.nvmlDeviceGetMemoryInfo = lambda _handle: types.SimpleNamespace(used=0, total=1024 * 1024 * 1024)
    slow_nvml.nvmlDeviceGetUtilizationRates = lambda _handle: types.SimpleNamespace(gpu=5)

    async def runtime_metrics(_path: str) -> dict:
        return {"code": 0, "data": {"sessions": [{"sessionid": "session_1", "metrics": {}}]}}

    original_nvml = sys.modules.get("pynvml")
    sys.modules["pynvml"] = slow_nvml
    gateway.livetalking_get = runtime_metrics
    try:
        latency, observed = await healthz_latency_during(gateway.observation("session_1", authorization))
    finally:
        if original_nvml is None:
            sys.modules.pop("pynvml", None)
        else:
            sys.modules["pynvml"] = original_nvml
    assert latency < 1.0, f"/healthz must answer while NVML is slow to initialize (answered {latency:.2f}s late)"
    assert observed["gpu"]["available"] is True and observed["gpu"]["utilization_percent"] == 5


asyncio.run(main())
print("PASS  Runtime Gateway preserves completed commands across restarts and blocks uncertain replays")
