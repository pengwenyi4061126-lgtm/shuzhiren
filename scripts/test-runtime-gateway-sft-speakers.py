"""COSYVOICE_SFT_SPEAKER_MAP: ASCII runtime voice ids of the default presets (migration 082) map to CosyVoice's
built-in sft speaker names; the value is validated strictly and every failure is fail-closed."""
import asyncio
import hashlib
import pathlib
import sys
import tempfile
import time
from urllib.parse import parse_qs

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
import app as gateway

RealAsyncClient = httpx.AsyncClient
AUTHORIZATION = f"Bearer {'s' * 32}"


def check_parser() -> None:
    assert dict(gateway.parse_sft_speaker_map("")) == {"preset-zh-female": "中文女", "preset-zh-male": "中文男"}, "an unset map uses the built-in default"
    assert dict(gateway.parse_sft_speaker_map('{"brand_voice-1": "中文女", "en": "英文男"}')) == {"brand_voice-1": "中文女", "en": "英文男"}, "a set map replaces the default"
    assert dict(gateway.parse_sft_speaker_map("{}")) == {}, "{} disables the mapping"
    mapping = gateway.parse_sft_speaker_map("")
    try:
        mapping["preset-zh-female"] = "其他"  # type: ignore[index]
    except TypeError:
        pass
    else:
        raise AssertionError("the parsed map must be read-only")
    invalid = [
        ("not json", "JSON object"),
        (" ", "JSON object"),
        ('["preset-zh-female", "中文女"]', "JSON object"),
        ('"中文女"', "JSON object"),
        ("null", "JSON object"),
        ('{"preset-zh-female": "中文女",}', "JSON object"),
        ('{"preset-zh-female": "中文女", "preset-zh-female": "中文男"}', "must not repeat"),
        ('{"中文女": "中文女"}', "keys must be runtime voice ids"),
        ('{"-leading-dash": "中文女"}', "keys must be runtime voice ids"),
        ('{"has space": "中文女"}', "keys must be runtime voice ids"),
        ('{"": "中文女"}', "keys must be runtime voice ids"),
        ('{"%s": "中文女"}' % ("a" * 129), "keys must be runtime voice ids"),
        ('{"preset-zh-female": ""}', "values must be speaker names"),
        ('{"preset-zh-female": " 中文女"}', "values must be speaker names"),
        ('{"preset-zh-female": "中文女\\n"}', "values must be speaker names"),
        ('{"preset-zh-female": "中文\\u0000女"}', "values must be speaker names"),
        ('{"preset-zh-female": "中文\\u200b女"}', "values must be speaker names"),
        ('{"preset-zh-female": "%s"}' % ("女" * 65), "values must be speaker names"),
        ('{"preset-zh-female": 1}', "values must be speaker names"),
        ('{"preset-zh-female": null}', "values must be speaker names"),
        ('{"preset-zh-female": ["中文女"]}', "values must be speaker names"),
        ('{"preset-zh-female": {"name": "中文女"}}', "values must be speaker names"),
        ("{%s}" % ", ".join(f'"v{index}": "中文女"' for index in range(257)), "at most 256 entries"),
    ]
    for raw, expected in invalid:
        try:
            gateway.parse_sft_speaker_map(raw)
        except RuntimeError as error:
            assert expected in str(error), (raw, str(error))
            assert "COSYVOICE_SFT_SPEAKER_MAP" in str(error), str(error)
        else:
            raise AssertionError(f"COSYVOICE_SFT_SPEAKER_MAP={raw!r} must be rejected")
    assert len(gateway.parse_sft_speaker_map("{%s}" % ", ".join(f'"v{index}": "中文女"' for index in range(256)))) == 256
    assert gateway.parse_sft_speaker_map('{"v": "%s"}' % ("女" * 64))["v"] == "女" * 64


async def check_startup(voice_dir: str) -> None:
    """An invalid map stops the Gateway before it serves anything, whatever the model kind."""
    gateway.RUNTIME_TOKEN = "s" * 32
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = False
    original = (gateway.COSYVOICE_MODEL_KIND, gateway.COSYVOICE_VOICE_LIBRARY_DIR, gateway.COSYVOICE_SFT_SPEAKER_MAP)
    gateway.COSYVOICE_VOICE_LIBRARY_DIR = voice_dir
    try:
        for kind in ("sft", "zero_shot"):
            gateway.COSYVOICE_MODEL_KIND = kind
            gateway.COSYVOICE_SFT_SPEAKER_MAP = '{"preset-zh-female": ""}'
            try:
                async with gateway.lifespan(gateway.app):
                    raise AssertionError(f"Runtime Gateway ({kind}) must reject an invalid COSYVOICE_SFT_SPEAKER_MAP before startup")
            except RuntimeError as error:
                assert "COSYVOICE_SFT_SPEAKER_MAP" in str(error), str(error)
            for valid in ("", "{}", '{"preset-zh-female": "中文女"}'):
                gateway.COSYVOICE_SFT_SPEAKER_MAP = valid
                async with gateway.lifespan(gateway.app):
                    pass
    finally:
        gateway.COSYVOICE_MODEL_KIND, gateway.COSYVOICE_VOICE_LIBRARY_DIR, gateway.COSYVOICE_SFT_SPEAKER_MAP = original


class Upstreams:
    def __init__(self) -> None:
        self.cosyvoice: list[tuple[str, dict]] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "cosyvoice":
            content_type = request.headers.get("content-type", "")
            fields = {key: values[0] for key, values in parse_qs(request.content.decode("utf-8"), keep_blank_values=True).items()} if content_type.startswith("application/x-www-form-urlencoded") else {"multipart": True}
            self.cosyvoice.append((request.url.path, fields))
            return httpx.Response(200, content=b"\x01\x00" * 400)
        if request.url.path == "/humanaudio":
            return httpx.Response(200, json={"code": 0})
        return httpx.Response(200, json={"code": 0, "data": {"sessions": []}})


async def check_synthesis(voice_dir: str, journal_dir: str) -> None:
    upstreams = Upstreams()
    original_client = gateway.httpx.AsyncClient
    original = (gateway.COSYVOICE_MODEL_KIND, gateway.COSYVOICE_VOICE_LIBRARY_DIR, gateway.COSYVOICE_SFT_SPEAKER_MAP, gateway.RUNTIME_COMMAND_JOURNAL_PATH, gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED)
    gateway.httpx.AsyncClient = lambda **kwargs: RealAsyncClient(transport=httpx.MockTransport(upstreams.handler), **kwargs)
    gateway.RUNTIME_TOKEN = "s" * 32
    gateway.RUNTIME_COMMAND_JOURNAL_PATH = str(pathlib.Path(journal_dir) / "commands.sqlite3")
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = True
    gateway.COSYVOICE_VOICE_LIBRARY_DIR = voice_dir
    text = "欢迎来到直播间。"
    sequence = 0

    async def speak(voice: str, checksum: str | None = None, command_id: str | None = None) -> list[tuple[str, dict]]:
        nonlocal sequence
        sequence += 1
        first = len(upstreams.cosyvoice)
        request = gateway.SpeakRequest(command_id=command_id or f"sft_map_{sequence}", session_id="session_1", text=text, voice=voice, voice_checksum=checksum)
        result = await gateway.speak(request, AUTHORIZATION)
        assert result["accepted"] is True and result["provider"] == "cosyvoice_to_livetalking", result
        return upstreams.cosyvoice[first:]

    try:
        gateway.COSYVOICE_MODEL_KIND = "sft"
        gateway.COSYVOICE_SFT_SPEAKER_MAP = ""
        assert await speak("preset-zh-female") == [("/inference_sft", {"tts_text": text, "spk_id": "中文女"})]
        assert await speak("preset-zh-male") == [("/inference_sft", {"tts_text": text, "spk_id": "中文男"})]
        assert await speak("sft_speaker") == [("/inference_sft", {"tts_text": text, "spk_id": "sft_speaker"})], "an id without a map entry is sent unchanged"
        gateway.COSYVOICE_SFT_SPEAKER_MAP = '{"preset-zh-female": "品牌女声"}'
        assert await speak("preset-zh-female") == [("/inference_sft", {"tts_text": text, "spk_id": "品牌女声"})]
        assert await speak("preset-zh-male") == [("/inference_sft", {"tts_text": text, "spk_id": "preset-zh-male"})], "a set map replaces the default"
        gateway.COSYVOICE_SFT_SPEAKER_MAP = "{}"
        assert await speak("preset-zh-female") == [("/inference_sft", {"tts_text": text, "spk_id": "preset-zh-female"})]

        # A map that became invalid after startup fails closed before the command id is reserved: no synthesis,
        # no LiveTalking call, and the corrected retry with the same command id succeeds.
        gateway.COSYVOICE_SFT_SPEAKER_MAP = '{"preset-zh-female": "中文女", "preset-zh-female": "中文男"}'
        before = len(upstreams.cosyvoice)
        try:
            await gateway.speak(gateway.SpeakRequest(command_id="sft_map_retry", session_id="session_1", text=text, voice="preset-zh-female"), AUTHORIZATION)
        except gateway.CommandFailure as error:
            body = error.body()
            assert error.status_code == 503, error.status_code
            assert body["code"] == "voice_material_unavailable" and body["failure_source"] == "voice_library" and body["failure_reason"] == "sft_speaker_map_invalid", body
        else:
            raise AssertionError("an invalid COSYVOICE_SFT_SPEAKER_MAP must fail the command")
        assert len(upstreams.cosyvoice) == before, "a failed speaker mapping must not reach CosyVoice"
        # The synthesis path resolves a VoiceSpec built without load_voice_spec the same way.
        try:
            await gateway.cosyvoice_synthesize(text, gateway.VoiceSpec("preset-zh-female"), time.monotonic() + 5)
        except gateway.CommandFailure as error:
            assert error.body()["failure_reason"] == "sft_speaker_map_invalid", error.body()
        else:
            raise AssertionError("synthesis must not guess a speaker when the map is invalid")
        assert len(upstreams.cosyvoice) == before
        gateway.COSYVOICE_SFT_SPEAKER_MAP = ""
        assert await speak("preset-zh-female", command_id="sft_map_retry") == [("/inference_sft", {"tts_text": text, "spk_id": "中文女"})]

        # zero_shot ignores the map: the ASCII id names the operator's voice library directory.
        gateway.COSYVOICE_MODEL_KIND = "zero_shot"
        prompt_wav = gateway.pcm_s16le_to_wav(b"\x05\x00" * 1600, 16000)
        directory = pathlib.Path(voice_dir) / "preset-zh-female"
        directory.mkdir()
        (directory / "prompt.wav").write_bytes(prompt_wav)
        (directory / "prompt.txt").write_text("You are a helpful assistant.<|endofprompt|>欢迎来到直播间。\n", encoding="utf-8")
        calls = await speak("preset-zh-female", "sha256:" + hashlib.sha256(prompt_wav).hexdigest())
        assert [path for path, _fields in calls] == ["/inference_zero_shot"], calls
    finally:
        gateway.httpx.AsyncClient = original_client
        gateway.COSYVOICE_MODEL_KIND, gateway.COSYVOICE_VOICE_LIBRARY_DIR, gateway.COSYVOICE_SFT_SPEAKER_MAP, gateway.RUNTIME_COMMAND_JOURNAL_PATH, gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = original


async def main() -> None:
    check_parser()
    with tempfile.TemporaryDirectory() as voice_dir, tempfile.TemporaryDirectory() as journal_dir:
        await check_startup(voice_dir)
        await check_synthesis(voice_dir, journal_dir)


asyncio.run(main())
print("PASS  Runtime Gateway maps preset runtime voice ids to CosyVoice sft speakers and rejects invalid speaker maps")
