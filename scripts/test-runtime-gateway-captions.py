"""Runtime Gateway caption cues and the /humanaudio caption field (live-commerce-p1-features, Requirement 6.10, 7.7).
Usage: python3 scripts/test-runtime-gateway-captions.py (needs runtime/gateway/requirements.lock).
CosyVoice and LiveTalking are one httpx MockTransport; the LiveTalking side records the multipart form of /humanaudio.
"""
import asyncio
import hashlib
import json
import math
import pathlib
import random
import re
import sqlite3
import sys
import tempfile

import httpx
from fractions import Fraction
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


# Feature: live-commerce-p1-features, Property 23: 字幕时间轴
# Validates: Requirements 6.10, 6.11
PROPERTY_SEED = 230610
PROPERTY_CASES = 400
CHUNK_ALPHABET = {
    "cjk": "欢迎来到直播间今天讲解洁面慕斯适合油性肌肤使用大家好谢谢请看这里价格优惠库存有限",
    "latin": "abcdefghijklmnopqrstuvwxyzABCXYZ",
    "digit": "0123456789０１２",
    "space": " \t\n\r\u3000",
    "punct": "，。！？,.;；:：、…!?\"'“”‘’（）()「」【】《》-—~·",
    "odd": "\u200b\u200d\ufeff😀★",
}
def random_chunk(rng: random.Random) -> str:
    kind = rng.choice(["empty", "space", "punct", "odd", "normal", "normal", "normal", "long", "long_unbroken", "mixed_script"])
    def draw(pools: list[str], count: int) -> str:
        return "".join(rng.choice(rng.choice(pools)) for _ in range(count))
    if kind == "empty":
        return ""
    if kind == "space":
        return draw([CHUNK_ALPHABET["space"]], rng.randint(1, 6))
    if kind == "punct":
        return draw([CHUNK_ALPHABET["punct"], CHUNK_ALPHABET["space"]], rng.randint(1, 8))
    if kind == "odd":
        return draw([CHUNK_ALPHABET["odd"], CHUNK_ALPHABET["space"]], rng.randint(1, 5))
    if kind == "normal":
        return draw([CHUNK_ALPHABET["cjk"], CHUNK_ALPHABET["cjk"], CHUNK_ALPHABET["punct"], CHUNK_ALPHABET["space"]], rng.randint(1, 40))
    if kind == "long":
        return draw([CHUNK_ALPHABET["cjk"], CHUNK_ALPHABET["cjk"], CHUNK_ALPHABET["punct"], CHUNK_ALPHABET["space"], CHUNK_ALPHABET["digit"]], rng.randint(40, 200))
    if kind == "long_unbroken":
        return draw([CHUNK_ALPHABET["cjk"], CHUNK_ALPHABET["latin"]], rng.randint(41, 200))
    return draw(list(CHUNK_ALPHABET.values()), rng.randint(1, 80))
def expected_total_ms(total_samples: int, sample_rate: int) -> int:
    # round(1000 * samples / rate), halves rounded up, computed with exact fractions.
    return math.floor(Fraction(1000 * total_samples, sample_rate) + Fraction(1, 2))
def assert_caption_timeline(chunk_texts: list[str], chunk_samples: list[int], sample_rate: int, line_max_chars: int) -> list[dict]:
    cues = captions.build_caption_cues(chunk_texts, chunk_samples, sample_rate, line_max_chars)
    original = strip_space("".join(chunk_texts))
    assert len(cues) <= captions.MAX_CUES, len(cues)
    if not original:
        assert cues == [], cues
        return cues
    assert cues, "text with visible characters must produce at least one cue"
    for cue in cues:
        assert set(cue) == {"text", "start_ms", "end_ms"}, cue
        assert isinstance(cue["start_ms"], int) and isinstance(cue["end_ms"], int), cue
        assert cue["text"] and cue["text"].strip() == cue["text"], cue
        assert len(cue["text"]) <= line_max_chars, cue
        assert 0 <= cue["start_ms"] <= cue["end_ms"], cue
    # Sorted, touching and therefore not overlapping.
    for left, right in zip(cues, cues[1:]):
        assert left["end_ms"] == right["start_ms"], (left, right)
    assert cues[0]["start_ms"] == 0, cues[0]
    assert cues[-1]["end_ms"] == expected_total_ms(sum(chunk_samples), sample_rate), (cues[-1], sum(chunk_samples), sample_rate)
    joined = strip_space("".join(cue["text"] for cue in cues))
    if len(cues) < captions.MAX_CUES:
        assert joined == original, (joined, original)
    else:
        # At 200 cues the last one may be the merged, shortened tail; the cues before it still match in order.
        assert original.startswith(joined), (joined, original)
    return cues
def check_property_caption_timeline() -> None:
    rng = random.Random(PROPERTY_SEED)
    produced = empty = 0
    for case in range(PROPERTY_CASES):
        count = rng.randint(0, 8)
        chunk_texts = [random_chunk(rng) for _ in range(count)]
        sample_rate = rng.choice([8000, 16000, 22050, 24000, 44100, 48000, rng.randint(1, 96000)])
        chunk_samples = [rng.choice([0, 0, rng.randint(0, 5), rng.randint(0, sample_rate), rng.randint(0, sample_rate * 20)]) for _ in range(count)]
        line_max_chars = rng.randint(captions.MIN_LINE_MAX_CHARS, captions.MAX_LINE_MAX_CHARS)
        try:
            cues = assert_caption_timeline(chunk_texts, chunk_samples, sample_rate, line_max_chars)
            # The same input gives the same cues.
            assert cues == captions.build_caption_cues(chunk_texts, chunk_samples, sample_rate, line_max_chars)
        except AssertionError:
            print(f"FAIL  Property 23 seed={PROPERTY_SEED} case={case} sample_rate={sample_rate} line_max_chars={line_max_chars} chunk_texts={chunk_texts!r} chunk_samples={chunk_samples!r}")
            raise
        produced += bool(cues)
        empty += not cues
    assert produced > PROPERTY_CASES // 2 and empty > 0, (produced, empty)
    # Many chunks: the 200 cue limit holds and the last cue still ends at the total duration.
    for case in range(20):
        count = rng.randint(150, 400)
        chunk_texts = [f"第{index}句，" + random_chunk(rng) + "。" for index in range(count)]
        sample_rate = rng.choice([16000, 24000, 48000])
        chunk_samples = [rng.randint(0, sample_rate * 3) for _ in range(count)]
        line_max_chars = rng.randint(captions.MIN_LINE_MAX_CHARS, 20)
        try:
            assert_caption_timeline(chunk_texts, chunk_samples, sample_rate, line_max_chars)
        except AssertionError:
            print(f"FAIL  Property 23 (many chunks) seed={PROPERTY_SEED} case={case} sample_rate={sample_rate} line_max_chars={line_max_chars} chunks={count}")
            raise
    print(f"PASS  Property 23: {PROPERTY_CASES} random cue timelines (seed {PROPERTY_SEED}) are sorted, touching, within line_max_chars, complete and end at the total duration")
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

SCENE_SEGMENT_ID = "10000000-0000-4000-8000-000000000001"
SCENE_JSON = json.dumps({"version": 1, "background": {"mode": "none"}, "productCard": None, "priceSticker": None}, separators=(",", ":"))
SCENE_SHA256 = hashlib.sha256(SCENE_JSON.encode("utf-8")).hexdigest()


class SceneUpstreams:
    """LiveTalking stand-in that records every request in order with its JSON body or form."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, object]] = []
        self.scene_status = 200
        self.scene_code = 0
        self.echo: str | None = SCENE_SHA256
        self.overlay_status = 200
        self.overlay_body: object = {"code": 0, "data": {"supported": True, "aigc_position": "bottom_right", "active_sessions": 2, "frames_composed": 120, "frames_overlay_failed": 3, "captions_ignored": 0, "layer_conflicts": [], "last_error": "caption_layer_conflict", "compose_ms_p95": 4}}

    def paths(self) -> list[str]:
        return [path for _method, path, _body in self.requests]

    async def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.url.host == "cosyvoice":
            if path == "/openapi.json":
                return httpx.Response(200, json={})
            text = parse_form(request)["tts_text"].decode("utf-8")
            return httpx.Response(200, content=b"\x01\x00" * (12000 * len(text)))
        body: object = None
        if request.method == "POST":
            body = parse_form(request) if path == "/humanaudio" else json.loads(request.content)
        self.requests.append((request.method, path, body))
        if path == "/api/admin/overlay/scene":
            if self.scene_status != 200:
                return httpx.Response(self.scene_status, json={"detail": "not found"})
            return httpx.Response(200, json={"code": self.scene_code, "data": {"scene_sha256": self.echo} if self.scene_code == 0 else {}})
        if path == "/api/admin/overlay":
            return httpx.Response(self.overlay_status, json=self.overlay_body)
        if path == "/humanaudio":
            return httpx.Response(200, json={"code": 0})
        return httpx.Response(200, json={"code": 0, "data": {"sessions": []}})


def journal_state(command_id: str) -> tuple | None:
    connection = sqlite3.connect(gateway.RUNTIME_COMMAND_JOURNAL_PATH)
    try:
        return connection.execute("select state, http_status, error_code, failure_reason from runtime_command_journal where command_id = ?", (command_id,)).fetchone()
    except sqlite3.OperationalError:
        return None  # the journal table is created by the first reservation
    finally:
        connection.close()


def scene_media(command_id: str, *, with_script: bool = False, scene_json: str | None = SCENE_JSON, scene_sha256: str | None = SCENE_SHA256, action: str = "start_program") -> "gateway.MediaRequest":
    fields: dict = {}
    if with_script:
        script = "大家好，欢迎来到直播间。"
        fields = {"program_segment_id": SCENE_SEGMENT_ID, "program_script": script, "script_sha256": hashlib.sha256(script.encode("utf-8")).hexdigest(), "runtime_voice_id": "speaker_1"}
    return gateway.MediaRequest(command_id=command_id, session_id="session_1", action=action, overlay_scene_json=scene_json, overlay_scene_sha256=scene_sha256, **fields)


def scene_gateway_setup(upstreams: SceneUpstreams) -> tuple[tempfile.TemporaryDirectory, tuple]:
    journal_dir = tempfile.TemporaryDirectory()
    saved = (gateway.RUNTIME_TOKEN, gateway.RUNTIME_COMMAND_JOURNAL_PATH, gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED, gateway.COSYVOICE_MODEL_KIND, gateway.COSYVOICE_SAMPLE_RATE)
    gateway.httpx.AsyncClient = lambda **kwargs: RealAsyncClient(transport=httpx.MockTransport(upstreams.handler), **kwargs)
    gateway.RUNTIME_TOKEN = "test-runtime-token"
    gateway.RUNTIME_COMMAND_JOURNAL_PATH = str(pathlib.Path(journal_dir.name) / "commands.sqlite3")
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = True
    gateway.COSYVOICE_MODEL_KIND = "sft"
    gateway.COSYVOICE_SAMPLE_RATE = SAMPLE_RATE
    gateway.runtime_command_cache.clear()
    return journal_dir, saved


def scene_gateway_restore(journal_dir: tempfile.TemporaryDirectory, saved: tuple) -> None:
    gateway.httpx.AsyncClient = RealAsyncClient
    gateway.RUNTIME_TOKEN, gateway.RUNTIME_COMMAND_JOURNAL_PATH, gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED, gateway.COSYVOICE_MODEL_KIND, gateway.COSYVOICE_SAMPLE_RATE = saved
    journal_dir.cleanup()


async def check_overlay_scene_steps_and_receipt() -> None:
    upstreams = SceneUpstreams()
    journal_dir, saved = scene_gateway_setup(upstreams)
    authorization = "Bearer test-runtime-token"
    try:
        # A scene-carrying start_program installs the scene first, then the existing steps follow.
        result = await gateway.media(scene_media("scene_start_1"), authorization)
        assert upstreams.paths() == ["/api/admin/overlay/scene", "/set_audiotype", "/record"], upstreams.paths()
        assert upstreams.requests[0][2] == {"sessionid": "session_1", "scene_json": SCENE_JSON, "scene_sha256": SCENE_SHA256}, upstreams.requests[0]
        assert result["downstream_actions"] == ["set_overlay_scene", "set_program_audiotype", "start_record"], result["downstream_actions"]
        assert result["receipt"]["overlay_scene_sha256"] == SCENE_SHA256 and result["duplicate"] is False
        print("PASS  start_program with a scene sets it first, then audiotype and record, and the receipt echoes the scene hash")

        upstreams.requests.clear()
        result = await gateway.media(scene_media("scene_start_2", with_script=True), authorization)
        assert upstreams.paths() == ["/api/admin/overlay/scene", "/interrupt_talk", "/set_audiotype", "/record", "/humanaudio"], upstreams.paths()
        assert result["downstream_actions"][0] == "set_overlay_scene" and result["receipt"]["overlay_scene_sha256"] == SCENE_SHA256
        print("PASS  with a program script set_overlay_scene still comes before interrupt, audiotype, record and play")

        # A start_program without a scene keeps its steps and receipt unchanged.
        upstreams.requests.clear()
        plain = await gateway.media(scene_media("scene_start_none", scene_json=None, scene_sha256=None), authorization)
        assert upstreams.paths() == ["/set_audiotype", "/record"] and "overlay_scene_sha256" not in plain["receipt"], (upstreams.paths(), plain["receipt"])
        print("PASS  start_program without a scene has no set_overlay_scene step and no receipt hash")

        # The same command id is a duplicate for the same scene and an idempotency conflict for another one.
        upstreams.requests.clear()
        again = await gateway.media(scene_media("scene_start_1"), authorization)
        assert again["duplicate"] is True and again["receipt"]["overlay_scene_sha256"] == SCENE_SHA256 and upstreams.requests == []
        other_json = json.dumps({"version": 1, "background": {"mode": "chroma_key"}}, separators=(",", ":"))
        try:
            await gateway.media(scene_media("scene_start_1", scene_json=other_json, scene_sha256=hashlib.sha256(other_json.encode("utf-8")).hexdigest()), authorization)
        except gateway.HTTPException as error:
            assert error.status_code == 409, error.status_code
        else:
            raise AssertionError("the same command id with a different scene must conflict")
        assert upstreams.requests == []
        print("PASS  a retry with the same scene replays and another scene on the same command id conflicts")
    finally:
        scene_gateway_restore(journal_dir, saved)


async def check_overlay_scene_failures() -> None:
    upstreams = SceneUpstreams()
    journal_dir, saved = scene_gateway_setup(upstreams)
    authorization = "Bearer test-runtime-token"
    try:
        cases = [
            ("scene_echo_mismatch", {"echo": "f" * 64}, "overlay_scene_hash_mismatch"),
            ("scene_echo_missing", {"echo": None}, "overlay_scene_hash_mismatch"),
            ("scene_unpatched", {"scene_status": 404}, "livetalking_client_error"),
            ("scene_refused", {"scene_code": 1}, "livetalking_business_rejected"),
        ]
        for command_id, settings, reason in cases:
            upstreams.scene_status, upstreams.scene_code, upstreams.echo = 200, 0, SCENE_SHA256
            for key, value in settings.items():
                setattr(upstreams, key, value)
            upstreams.requests.clear()
            try:
                await gateway.media(scene_media(command_id, with_script=True), authorization)
            except gateway.CommandError as error:
                assert error.status_code == 502 and error.code == "command_failed_definite" and error.fields.get("reason") == reason and error.fields.get("failed_step") == "set_overlay_scene", (error.status_code, error.code, error.fields)
            else:
                raise AssertionError(f"{command_id} must fail")
            assert upstreams.paths() == ["/api/admin/overlay/scene"], f"{command_id}: no other LiveTalking call may follow a failed scene: {upstreams.paths()}"
            assert journal_state(command_id) == ("failed_definite", 502, "command_failed_definite", reason), journal_state(command_id)
        print("PASS  a hash echo mismatch, a missing echo, an unpatched LiveTalking and a refused scene are definite failures that stop the command")
    finally:
        scene_gateway_restore(journal_dir, saved)


async def check_overlay_health() -> None:
    upstreams = SceneUpstreams()
    journal_dir, saved = scene_gateway_setup(upstreams)
    try:
        async def overlay_health() -> dict:
            response = await gateway.healthz()
            return json.loads(response.body)["dependencies"]["livetalking"]["overlay"]

        assert await overlay_health() == {"supported": True, "aigc_position": "bottom_right", "active_sessions": 2, "frames_composed": 120, "frames_overlay_failed": 3, "last_error": "caption_layer_conflict"}
        upstreams.overlay_status = 404
        unsupported = await overlay_health()
        assert unsupported["supported"] is False and unsupported["frames_composed"] is None, unsupported
        upstreams.overlay_status, upstreams.overlay_body = 200, {"code": 1}
        assert (await overlay_health())["supported"] is False
        upstreams.overlay_body = {"code": 0, "data": {"supported": "yes"}}
        assert (await overlay_health())["supported"] is False, "only an explicit true reads as supported"
        print("PASS  /healthz passes LiveTalking overlay state through and reports supported false when it cannot be read")
    finally:
        scene_gateway_restore(journal_dir, saved)


async def check_overlay_scene_rejected_before_reservation() -> None:
    upstreams = SceneUpstreams()
    journal_dir, saved = scene_gateway_setup(upstreams)
    authorization = "Bearer test-runtime-token"
    try:
        await gateway.media(scene_media("scene_reject_control"), authorization)  # creates the journal table, so the checks below are not vacuous
        upstreams.requests.clear()
        too_long = json.dumps({"version": 1, "pad": "x" * 8200})
        array_json, version_two = "[1]", json.dumps({"version": 2})
        bad = {
            "json only": dict(scene_sha256=None),
            "hash only": dict(scene_json=None),
            "hash mismatch": dict(scene_sha256="0" * 64),
            "uppercase hash": dict(scene_sha256=SCENE_SHA256.upper()),
            "not an object": dict(scene_json=array_json, scene_sha256=hashlib.sha256(array_json.encode()).hexdigest()),
            "version 2": dict(scene_json=version_two, scene_sha256=hashlib.sha256(version_two.encode()).hexdigest()),
            "too long": dict(scene_json=too_long, scene_sha256=hashlib.sha256(too_long.encode()).hexdigest()),
            "wrong action": dict(action="stop_program"),
        }
        for index, (label, fields) in enumerate(bad.items()):
            command_id = f"scene_reject_{index}"
            try:
                await gateway.media(scene_media(command_id, **fields), authorization)
            except gateway.HTTPException as error:
                assert error.status_code == 400, (label, error.status_code)
            else:
                raise AssertionError(f"{label} must be rejected")
            assert journal_state(command_id) is None, f"{label}: the command id must not be reserved"
        assert upstreams.requests == [], "a rejected scene request must not reach LiveTalking"
        print("PASS  invalid scene fields are rejected with 400 before the command id is reserved")
    finally:
        scene_gateway_restore(journal_dir, saved)

async def main() -> None:
    check_cue_timeline()
    check_unpronounceable_chunks()
    check_cue_limit()
    check_form_value()
    check_property_caption_timeline()
    await check_line_max_chars_configuration()
    await check_humanaudio_caption_field()
    await check_overlay_scene_steps_and_receipt()
    await check_overlay_scene_failures()
    await check_overlay_health()
    await check_overlay_scene_rejected_before_reservation()


asyncio.run(main())
