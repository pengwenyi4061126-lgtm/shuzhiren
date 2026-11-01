import os
import wave
from io import BytesIO
from typing import Literal

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Shuzhiren Runtime Gateway", version="0.1.0")
LIVE_TALKING_URL = os.environ.get("LIVETALKING_BASE_URL", "http://livetalking:8010").rstrip("/")
COSYVOICE_URL = os.environ.get("COSYVOICE_BASE_URL", "http://cosyvoice:50000").rstrip("/")
COSYVOICE_SAMPLE_RATE = int(os.environ.get("COSYVOICE_SAMPLE_RATE", "22050"))
RUNTIME_TOKEN = os.environ.get("RUNTIME_SHARED_TOKEN", "")
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("RUNTIME_REQUEST_TIMEOUT_SECONDS", "15"))

class SpeakRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=800)
    interrupt: bool = False
    voice: str | None = Field(default=None, max_length=128)
    provider: Literal["cosyvoice", "livetalking"] = "cosyvoice"

class MediaRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    action: Literal["start_program", "switch_to_fallback", "switch_to_human", "stop_program"]
    fallback_audiotype: int = Field(default=0, ge=0, le=99)

def authorize(authorization: str | None) -> None:
    if not RUNTIME_TOKEN:
        raise HTTPException(status_code=503, detail="Runtime gateway token is not configured")
    if authorization != f"Bearer {RUNTIME_TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid runtime gateway token")

async def livetalking_post(path: str, payload: dict) -> dict:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{LIVE_TALKING_URL}{path}", json=payload)
            response.raise_for_status()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"LiveTalking request failed: {error}") from error
    data = response.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=502, detail=f"LiveTalking rejected request: {data.get('msg', 'unknown error')}")
    return data

def pcm_to_wav(pcm: bytes) -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(COSYVOICE_SAMPLE_RATE)
        wav.writeframes(pcm)
    return output.getvalue()

async def cosyvoice_synthesize(text: str, speaker: str) -> bytes:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{COSYVOICE_URL}/inference_sft", data={"tts_text": text, "spk_id": speaker})
            response.raise_for_status()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"CosyVoice request failed: {error}") from error
    return pcm_to_wav(response.content)

async def livetalking_audio(session_id: str, audio: bytes) -> None:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{LIVE_TALKING_URL}/humanaudio", data={"sessionid": session_id}, files={"file": ("speech.wav", audio, "audio/wav")})
            response.raise_for_status()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"LiveTalking audio request failed: {error}") from error
    data = response.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=502, detail=f"LiveTalking rejected audio: {data.get('msg', 'unknown error')}")

@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "livetalking": LIVE_TALKING_URL}

@app.post("/v1/speak")
async def speak(request: SpeakRequest, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    if request.provider == "cosyvoice":
        if not request.voice:
            raise HTTPException(status_code=400, detail="CosyVoice speaker id is required")
        if request.interrupt:
            await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
        await livetalking_audio(request.session_id, await cosyvoice_synthesize(request.text, request.voice))
        return {"accepted": True, "provider": "cosyvoice_to_livetalking", "mode": "audio"}
    tts = {"voice": request.voice} if request.voice else {}
    await livetalking_post("/human", {"sessionid": request.session_id, "text": request.text, "type": "echo", "interrupt": request.interrupt, "tts": tts})
    return {"accepted": True, "provider": "livetalking", "mode": "echo"}

@app.post("/v1/media")
async def media(request: MediaRequest, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    if request.action == "stop_program":
        await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
    elif request.action in {"switch_to_fallback", "switch_to_human"}:
        await livetalking_post("/set_audiotype", {"sessionid": request.session_id, "audiotype": request.fallback_audiotype})
    return {"accepted": True, "provider": "livetalking", "action": request.action}
