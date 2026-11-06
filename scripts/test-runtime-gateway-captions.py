"""Runtime Gateway caption cues and the /humanaudio caption field (live-commerce-p1-features, Requirement 6.10, 7.7).
Usage: python3 scripts/test-runtime-gateway-captions.py (needs runtime/gateway/requirements.lock).
CosyVoice and LiveTalking are one httpx MockTransport; the LiveTalking side records the multipart form of /humanaudio.
"""
import asyncio
import hashlib
import json
import pathlib
import re
import sys
import tempfile

import httpx
from urllib.parse import parse_qs

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
import app as gateway  # noqa: E402
import captions  # noqa: E402

RealAsyncClient = httpx.AsyncClient
SAMPLE_RATE = 24000


def strip_space(text: str) -> str:
    return re.sub(r"\s+", "", text)


def check_cue_timeline() -> None:
    # design.md "Example Usage": two chunks of 2.0 s and 2.667 s at 24 kHz.
    cues = captions.build_caption_cues(["欢迎来到直播间。", "今天讲解洁面慕斯。"], [48000, 64000], SAMPLE_RATE)
    assert cues == [
        {"text": "欢迎来到直播间。", "start_ms": 0, "end_ms": 2000},
        {"text": "今天讲解洁面慕斯。", "start_ms": 2000, "end_ms": 4667},
    ], cues
    print("PASS  two chunks become two cues timed by their sample counts")

    # A chunk longer than one line is split at sentence ends; the lines share the chunk's time by character count.
    text = "欢迎来到直播间。今天讲解洁面慕斯，适合油性肌肤使用。"
    cues = captions.build_caption_cues([text], [SAMPLE_RATE * 6], SAMPLE_RATE, 12)
    assert len(cues) > 1 and cues[0]["start_ms"] == 0 and cues[-1]["end_ms"] == 6000, cues
    assert all(0 < len(cue["text"]) <= 12 for cue in cues), cues
    assert all(left["end_ms"] == right["start_ms"] for left, right in zip(cues, cues[1:])), cues
    assert strip_space("".join(cue["text"] for cue in cues)) == strip_space(text)
    print("PASS  a long chunk is split into lines of at most line_max_chars that touch and cover the chunk")

    # Rounding is half up on absolute positions: 1 sample at 2 kHz is 0.5 ms.
    assert captions.build_caption_cues(["你好"], [1], 2000)[0]["end_ms"] == 1
    assert captions.build_caption_cues(["你好", "再见"], [1, 1], 2000) == [
        {"text": "你好", "start_ms": 0, "end_ms": 1},
        {"text": "再见", "start_ms": 1, "end_ms": 1},
    ]
    print("PASS  cue times round half up and neighbouring cues share their boundary")

    for bad in (
        lambda: captions.build_caption_cues(["a"], [], SAMPLE_RATE),
        lambda: captions.build_caption_cues(["a"], [-1], SAMPLE_RATE),
        lambda: captions.build_caption_cues(["a"], [1], 0),
        lambda: captions.build_caption_cues(["a"], [1], SAMPLE_RATE, 7),
        lambda: captions.build_caption_cues(["a"], [1], SAMPLE_RATE, 41),
    ):
        try:
            bad()
        except ValueError:
            continue
        raise AssertionError("a violated precondition must raise ValueError")
    print("PASS  preconditions are enforced")


def check_unpronounceable_chunks() -> None:
    # A whitespace-only chunk has no cue of its own; its time goes to the previous cue.
    cues = captions.build_caption_cues(["第一句。", "  \n ", "第二句。"], [24000, 24000, 24000], SAMPLE_RATE)
    assert cues == [{"text": "第一句。", "start_ms": 0, "end_ms": 2000}, {"text": "第二句。", "start_ms": 2000, "end_ms": 3000}], cues
    # Leading blank chunks give their time to the first cue, so the timeline still starts at 0.
    cues = captions.build_caption_cues([" ", "开始。"], [12000, 12000], SAMPLE_RATE)
    assert cues == [{"text": "开始。", "start_ms": 0, "end_ms": 1000}], cues
    # Punctuation-only chunks have no cue either, but their characters stay in the text.
    cues = captions.build_caption_cues(["好的", "。。", "谢谢"], [24000, 12000, 24000], SAMPLE_RATE)
    assert strip_space("".join(cue["text"] for cue in cues)) == "好的。。谢谢", cues
    assert cues[0]["start_ms"] == 0 and cues[-1]["end_ms"] == 2500
    assert captions.build_caption_cues([], [], SAMPLE_RATE) == []
    assert captions.build_caption_cues([" \n", "\t"], [100, 200], SAMPLE_RATE) == []
    print("PASS  chunks without pronounceable text produce no cue of their own")


def check_cue_limit() -> None:
    chunk_texts = [f"第{index}句。" for index in range(250)]
    cues = captions.build_caption_cues(chunk_texts, [SAMPLE_RATE] * 250, SAMPLE_RATE, 8)
    assert len(cues) == captions.MAX_CUES == 200, len(cues)
    assert cues[0]["start_ms"] == 0 and cues[-1]["end_ms"] == 250_000, cues[-1]
    assert cues[-1]["start_ms"] == 199_000 and 0 < len(cues[-1]["text"]) <= 8, cues[-1]
    assert all(left["end_ms"] == right["start_ms"] for left, right in zip(cues, cues[1:]))
    print("PASS  more than 200 lines are merged into the last cue, which runs to the end of the audio")


def check_form_value() -> None:
    cues = captions.build_caption_cues(["欢迎来到直播间。", "今天讲解洁面慕斯。"], [48000, 64000], SAMPLE_RATE)
    value = captions.caption_form_value("cmd_1", cues)
    assert json.loads(value) == {"id": "cmd_1", "cues": cues}
    assert len(value.encode("utf-8")) <= 16 * 1024
    assert captions.caption_form_value("cmd_1", []) is None

    # Cues that do not fit are cut from the end instead of sending an oversized field.
    many = [{"text": "测" * 40, "start_ms": index * 10, "end_ms": index * 10 + 10} for index in range(200)]
    value = captions.caption_form_value("cmd_1", many)
    kept = json.loads(value)["cues"]
    assert 0 < len(kept) < 200 and kept == many[:len(kept)], len(kept)
    assert len(value.encode("utf-8")) <= 16 * 1024
    # The next cue would not have fitted.
    assert len(json.dumps({"id": "cmd_1", "cues": many[:len(kept) + 1]}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 16 * 1024

    for bad_id in ("", "a b", "x" * 65, "中文"):
        try:
            captions.caption_form_value(bad_id, cues)
        except ValueError:
            continue
        raise AssertionError(f"caption id {bad_id!r} must be rejected")
    assert captions.caption_id_for("cmd_1") == "cmd_1"
    long_id = "c" * 100
    assert re.fullmatch(r"[a-f0-9]{64}", captions.caption_id_for(long_id)) and captions.caption_id_for(long_id) == captions.caption_id_for(long_id)
    print("PASS  the caption field is compact JSON {id, cues} of at most 16 KiB")


class Upstreams:
    def __init__(self) -> None:
        self.humanaudio: list[dict] = []
        self.paths: list[str] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.paths.append(request.url.path)
        if request.url.host == "cosyvoice":
            text = parse_form(request)["tts_text"].decode("utf-8")
            # 0.5 s of audio per character: 12000 samples at 24 kHz.
            return httpx.Response(200, content=b"\x01\x00" * (12000 * len(text)))
        if request.url.path == "/humanaudio":
            self.humanaudio.append(parse_form(request))
            return httpx.Response(200, json={"code": 0})
        return httpx.Response(200, json={"code": 0, "data": {"sessions": []}})


def parse_form(request: httpx.Request) -> dict:
    content_type = request.headers.get("content-type", "")
    assert content_type.startswith("multipart/form-data") or "tts_text" in request.content.decode("utf-8", "replace"), content_type
    if not content_type.startswith("multipart/form-data"):
        return {key: values[0].encode("utf-8") for key, values in parse_qs(request.content.decode("utf-8"), keep_blank_values=True).items()}
    boundary = content_type.split("boundary=", 1)[1].encode("latin-1")
    fields = {}
    for part in request.content.split(b"--" + boundary)[1:-1]:
        head, _, value = part[2:].partition(b"\r\n\r\n")
        fields[re.search(rb'name="([^"]+)"', head).group(1).decode("utf-8")] = value[:-2]
    return fields


async def check_humanaudio_caption_field() -> None:
    upstreams = Upstreams()
    journal_dir = tempfile.TemporaryDirectory()
    gateway.httpx.AsyncClient = lambda **kwargs: RealAsyncClient(transport=httpx.MockTransport(upstreams.handler), **kwargs)
    gateway.RUNTIME_TOKEN = "test-runtime-token"
    gateway.RUNTIME_COMMAND_JOURNAL_PATH = str(pathlib.Path(journal_dir.name) / "commands.sqlite3")
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = True
    gateway.COSYVOICE_MODEL_KIND = "sft"
    gateway.COSYVOICE_SAMPLE_RATE = SAMPLE_RATE
    gateway.COSYVOICE_CHUNK_MAX_CHARS = 20
    gateway.CAPTION_LINE_MAX_CHARS = 18
    authorization = "Bearer test-runtime-token"
    try:
        text = "欢迎来到直播间。今天给大家讲解一款洁面慕斯，它适合油性肌肤。"
        result = await gateway.speak(gateway.SpeakRequest(command_id="speech_caption_1", session_id="session_1", text=text, voice="speaker_1", provider="cosyvoice"), authorization)
        assert result["accepted"] is True and result["duplicate"] is False, result
        assert len(upstreams.humanaudio) == 1
        form = upstreams.humanaudio[0]
        assert form["sessionid"] == b"session_1" and "file" in form
        assert len(form["shuzhiren_caption"]) <= 16 * 1024
        caption = json.loads(form["shuzhiren_caption"].decode("utf-8"))
        assert caption["id"] == "speech_caption_1", caption
        cues = caption["cues"]
        chunk_texts = gateway.split_script(text, gateway.COSYVOICE_CHUNK_MAX_CHARS)
        assert len(chunk_texts) > 1
        assert strip_space("".join(cue["text"] for cue in cues)) == strip_space(text)
        assert all(0 < len(cue["text"]) <= 18 for cue in cues)
        assert cues[0]["start_ms"] == 0 and all(left["end_ms"] == right["start_ms"] for left, right in zip(cues, cues[1:]))
        # 0.5 s per character from the stand-in CosyVoice, so the audio ends at len(text) * 500 ms.
        assert cues[-1]["end_ms"] == len(text) * 500, (cues[-1], len(text))
        print("PASS  /v1/speak sends shuzhiren_caption with cues timed by the synthesized chunk samples")

        segment_id = "10000000-0000-4000-8000-000000000001"
        script = "大家好，欢迎来到直播间。"
        media = gateway.MediaRequest(command_id="media_caption_1", session_id="session_1", action="start_program", program_segment_id=segment_id, program_script=script, script_sha256=hashlib.sha256(script.encode("utf-8")).hexdigest(), runtime_voice_id="speaker_1")
        await gateway.media(media, authorization)
        assert len(upstreams.humanaudio) == 2
        media_caption = json.loads(upstreams.humanaudio[1]["shuzhiren_caption"].decode("utf-8"))
        assert media_caption["id"] == "media_caption_1" and media_caption["cues"][-1]["end_ms"] == len(script) * 500, media_caption
        print("PASS  /v1/media start_program sends shuzhiren_caption with the program script cues")

        # A command with a long id still gets an id that LiveTalking accepts.
        long_id = "a" * 100
        await gateway.speak(gateway.SpeakRequest(command_id=long_id, session_id="session_1", text="你好。", voice="speaker_1", provider="cosyvoice"), authorization)
        assert re.fullmatch(r"[A-Za-z0-9_.:\-]{1,64}", json.loads(upstreams.humanaudio[2]["shuzhiren_caption"])["id"])
        print("PASS  a command id longer than 64 characters is replaced by a digest as caption id")

        # No chunk information (an older synthesis result) sends no caption field and keeps the audio.
        async def synthesize_without_chunks(text: str, voice, deadline: float):
            return gateway.SynthesisResult(pcm=b"\x01\x00\x02\x00", chunks=1, synth_ms=0)
        original = gateway.cosyvoice_synthesize
        gateway.cosyvoice_synthesize = synthesize_without_chunks
        try:
            await gateway.speak(gateway.SpeakRequest(command_id="speech_caption_none", session_id="session_1", text="你好。", voice="speaker_1", provider="cosyvoice"), authorization)
        finally:
            gateway.cosyvoice_synthesize = original
        assert "shuzhiren_caption" not in upstreams.humanaudio[3] and "file" in upstreams.humanaudio[3]
        print("PASS  without chunk information no caption field is sent and the audio still plays")
    finally:
        gateway.httpx.AsyncClient = RealAsyncClient
        journal_dir.cleanup()


async def check_line_max_chars_configuration() -> None:
    saved = (gateway.RUNTIME_TOKEN, gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED, gateway.RUNTIME_COMMAND_JOURNAL_PATH, gateway.COSYVOICE_MODEL_KIND, gateway.CAPTION_LINE_MAX_CHARS)
    assert saved[4] == 18, "the default caption line length is 18"
    gateway.RUNTIME_TOKEN = "g" * 32
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = False
    gateway.RUNTIME_COMMAND_JOURNAL_PATH = ""
    gateway.COSYVOICE_MODEL_KIND = "sft"
    try:
        for value, valid in ((7, False), (8, True), (18, True), (40, True), (41, False)):
            gateway.CAPTION_LINE_MAX_CHARS = value
            try:
                async with gateway.lifespan(gateway.app):
                    accepted = True
            except RuntimeError as error:
                assert "CAPTION_LINE_MAX_CHARS" in str(error), str(error)
                accepted = False
            assert accepted is valid, value
    finally:
        gateway.RUNTIME_TOKEN, gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED, gateway.RUNTIME_COMMAND_JOURNAL_PATH, gateway.COSYVOICE_MODEL_KIND, gateway.CAPTION_LINE_MAX_CHARS = saved
    print("PASS  CAPTION_LINE_MAX_CHARS defaults to 18 and startup accepts only 8 to 40")

async def main() -> None:
    check_cue_timeline()
    check_unpronounceable_chunks()
    check_cue_limit()
    check_form_value()
    await check_line_max_chars_configuration()
    await check_humanaudio_caption_field()


asyncio.run(main())
