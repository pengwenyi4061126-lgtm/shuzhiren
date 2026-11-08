import asyncio
import pathlib
import sys
import time

from fastapi import HTTPException

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
import app as gateway


async def main() -> None:
    original_token = gateway.RUNTIME_TOKEN
    original_active = gateway.active_runtime_sessions
    original_load = gateway.load_voice_spec
    original_synthesize = gateway.cosyvoice_synthesize
    gateway.RUNTIME_TOKEN = "p" * 32
    syntheses: list[tuple[str, str, int]] = []
    active = False

    async def active_sessions() -> bool:
        return active

    def load_voice(runtime_voice_id: str, checksum: str | None) -> gateway.VoiceSpec:
        assert runtime_voice_id == "approved_voice"
        assert checksum == "sha256:" + "a" * 64
        return gateway.VoiceSpec(runtime_voice_id)

    async def synthesize(text: str, voice: gateway.VoiceSpec, deadline: float, max_seconds: int) -> gateway.SynthesisResult:
        assert voice.runtime_voice_id == "approved_voice"
        assert deadline > time.monotonic()
        syntheses.append((text, voice.runtime_voice_id, max_seconds))
        return gateway.SynthesisResult(b"\x00\x00" * 480, 1, 1, (text,), (480,))

    gateway.active_runtime_sessions = active_sessions
    gateway.load_voice_spec = load_voice
    gateway.cosyvoice_synthesize = synthesize
    request = gateway.SynthesisPreviewRequest(text="欢迎了解商品。", voice="approved_voice", voice_checksum="sha256:" + "a" * 64)
    try:
        try:
            await gateway.synthesize_preview(request, "Bearer " + "x" * 32)
        except HTTPException as error:
            assert error.status_code == 401
        else:
            raise AssertionError("speech preview must require the runtime command credential")

        response = await gateway.synthesize_preview(request, "Bearer " + gateway.RUNTIME_TOKEN)
        assert response.status_code == 200
        assert response.media_type == "audio/wav"
        assert response.headers["cache-control"] == "no-store"
        assert response.body[:4] == b"RIFF" and response.body[8:12] == b"WAVE"
        assert syntheses == [(request.text, "approved_voice", gateway.COSYVOICE_PREVIEW_MAX_SECONDS)]

        active = True
        try:
            await gateway.synthesize_preview(request, "Bearer " + gateway.RUNTIME_TOKEN)
        except gateway.CommandError as error:
            assert error.status_code == 409
            assert error.body()["code"] == "offline_speech_preview_busy"
        else:
            raise AssertionError("offline preview must be rejected while a live session exists")
        assert len(syntheses) == 1, "active live session must be checked before consuming GPU synthesis"

        active = False
        await gateway.cosyvoice_synthesis_lock.acquire()
        pending = asyncio.create_task(gateway.synthesize_preview(request, "Bearer " + gateway.RUNTIME_TOKEN))
        await asyncio.sleep(0)
        assert not pending.done(), "offline preview must wait while a live start owns the synthesis lock"
        gateway.cosyvoice_synthesis_lock.release()
        await pending
        assert len(syntheses) == 2
    finally:
        if gateway.cosyvoice_synthesis_lock.locked():
            gateway.cosyvoice_synthesis_lock.release()
        gateway.RUNTIME_TOKEN = original_token
        gateway.active_runtime_sessions = original_active
        gateway.load_voice_spec = original_load
        gateway.cosyvoice_synthesize = original_synthesize


asyncio.run(main())
print("PASS  Runtime Gateway speech preview auth, WAV output, live-session rejection, and synthesis serialization")
