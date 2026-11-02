import asyncio
import os
import re
import time
import wave
from collections import OrderedDict
from io import BytesIO
from typing import Literal

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI(title="Shuzhiren Runtime Gateway", version="0.1.0")
LIVE_TALKING_URL = os.environ.get("LIVETALKING_BASE_URL", "http://livetalking:8010").rstrip("/")
COSYVOICE_URL = os.environ.get("COSYVOICE_BASE_URL", "http://cosyvoice:50000").rstrip("/")
COSYVOICE_SAMPLE_RATE = int(os.environ.get("COSYVOICE_SAMPLE_RATE", "22050"))
RUNTIME_TOKEN = os.environ.get("RUNTIME_SHARED_TOKEN", "")
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("RUNTIME_REQUEST_TIMEOUT_SECONDS", "15"))
COSYVOICE_REQUIRED = os.environ.get("COSYVOICE_REQUIRED", "false").lower() == "true"
MEDIA_COMMAND_CACHE_TTL_SECONDS = float(os.environ.get("MEDIA_COMMAND_CACHE_TTL_SECONDS", "3600"))
MEDIA_COMMAND_CACHE_MAX_ENTRIES = int(os.environ.get("MEDIA_COMMAND_CACHE_MAX_ENTRIES", "2048"))
runtime_command_lock = asyncio.Lock()
runtime_command_cache: OrderedDict[str, dict] = OrderedDict()
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

class SpeakRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    session_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    text: str = Field(min_length=1, max_length=800)
    interrupt: bool = False
    voice: str | None = Field(default=None, max_length=128)
    provider: Literal["cosyvoice", "livetalking"] = "cosyvoice"

class MediaRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    session_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    action: Literal["start_program", "switch_to_fallback", "switch_to_human", "stop_program"]

PROGRAM_AUDIOTYPE = int(os.environ.get("PROGRAM_AUDIOTYPE", "0"))
FALLBACK_AUDIOTYPE = int(os.environ.get("FALLBACK_AUDIOTYPE", "0"))
HUMAN_HANDOFF_AUDIOTYPE = int(os.environ.get("HUMAN_HANDOFF_AUDIOTYPE", "0"))

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

async def livetalking_get(path: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{LIVE_TALKING_URL}{path}")
            response.raise_for_status()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"LiveTalking request failed: {error}") from error
    data = response.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=502, detail=f"LiveTalking rejected request: {data.get('msg', 'unknown error')}")
    return data

async def service_health(url: str, path: str, expected_code: int | None = None) -> dict:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{url}{path}")
            response.raise_for_status()
        if expected_code is not None:
            data = response.json()
            if data.get("code") != expected_code:
                return {"available": False}
    except (httpx.HTTPError, ValueError):
        return {"available": False}
    return {"available": True}

def prune_runtime_command_cache(now: float) -> None:
    expiry = now - MEDIA_COMMAND_CACHE_TTL_SECONDS
    while runtime_command_cache:
        oldest_id, oldest = next(iter(runtime_command_cache.items()))
        if oldest["completed_at"] >= expiry and len(runtime_command_cache) <= MEDIA_COMMAND_CACHE_MAX_ENTRIES:
            break
        runtime_command_cache.pop(oldest_id)

def pcm_to_wav(pcm: bytes) -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(COSYVOICE_SAMPLE_RATE)
        wav.writeframes(pcm)
    return output.getvalue()

def gpu_observation() -> dict:
    try:
        from pynvml import nvmlDeviceGetHandleByIndex, nvmlDeviceGetMemoryInfo, nvmlDeviceGetUtilizationRates, nvmlInit, nvmlShutdown
        visible = os.environ.get("NVIDIA_VISIBLE_DEVICES", "0").split(",", 1)[0]
        device_index = int(visible) if visible.isdigit() else 0
        nvmlInit()
        try:
            handle = nvmlDeviceGetHandleByIndex(device_index)
            memory = nvmlDeviceGetMemoryInfo(handle)
            utilization = nvmlDeviceGetUtilizationRates(handle)
            return {"available": True, "utilization_percent": int(utilization.gpu), "memory_used_mib": int(memory.used // (1024 * 1024)), "memory_total_mib": int(memory.total // (1024 * 1024))}
        finally:
            nvmlShutdown()
    except Exception:
        return {"available": False}

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
async def healthz() -> JSONResponse:
    livetalking, cosyvoice = await asyncio.gather(
        service_health(LIVE_TALKING_URL, "/api/admin/sessions", expected_code=0),
        service_health(COSYVOICE_URL, "/openapi.json"),
    )
    status = "ok" if livetalking["available"] and (not COSYVOICE_REQUIRED or cosyvoice["available"]) else "degraded"
    return JSONResponse(
        status_code=200 if status == "ok" else 503,
        content={
            "status": status,
            "dependencies": {
                "livetalking": livetalking,
                "cosyvoice": {**cosyvoice, "required": COSYVOICE_REQUIRED},
            },
            "media_actions": ["start_program", "switch_to_fallback", "switch_to_human", "stop_program"],
        },
    )

@app.get("/v1/observations/{session_id}")
async def observation(session_id: str, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    if not SESSION_ID_PATTERN.fullmatch(session_id):
        raise HTTPException(status_code=400, detail="Invalid runtime session id")
    data = await livetalking_get("/api/admin/runtime-metrics")
    sessions = data.get("data", {}).get("sessions", [])
    session = next((item for item in sessions if isinstance(item, dict) and item.get("sessionid") == session_id), None)
    if not session:
        return {
            "session": {"id": session_id, "active": False, "speaking": False, "recording": False},
            "gpu": gpu_observation(),
            "quality": {"writer_accepting_frames": False, "output_fps": None, "inference_fps": None, "configured_bitrate_mbps": None, "actual_bitrate_mbps": None, "av_sync_ms": None, "destination_receipt": None},
            "limitations": ["session_not_found", "destination_receipt_not_available", "actual_bitrate_not_available", "av_sync_not_available"],
        }
    metrics = session.get("metrics") if isinstance(session.get("metrics"), dict) else {}
    return {
        "session": {"id": session_id, "active": True, "speaking": bool(session.get("speaking")), "recording": bool(session.get("recording"))},
        "gpu": gpu_observation(),
        "quality": {
            "writer_accepting_frames": bool(metrics.get("output_connected")),
            "output_fps": numeric_metric(metrics.get("output_fps")),
            "inference_fps": numeric_metric(metrics.get("inference_fps")),
            "configured_bitrate_mbps": numeric_metric(metrics.get("output_bitrate_mbps_configured")),
            "actual_bitrate_mbps": None,
            "av_sync_ms": None,
            "destination_receipt": None,
            "last_output_at": numeric_metric(metrics.get("last_output_at")),
            "last_output_error": metrics.get("last_output_error") if isinstance(metrics.get("last_output_error"), str) else None,
        },
        "limitations": ["writer_accepting_frames_is_not_destination_receipt", "actual_bitrate_not_available", "av_sync_not_available"],
    }

def numeric_metric(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None

@app.post("/v1/speak")
async def speak(request: SpeakRequest, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    identity = {"session_id": request.session_id, "text": request.text, "interrupt": request.interrupt, "voice": request.voice, "provider": request.provider}
    async with runtime_command_lock:
        now = time.monotonic()
        prune_runtime_command_cache(now)
        cached = runtime_command_cache.get(request.command_id)
        if cached:
            if cached["kind"] != "speech" or cached["identity"] != identity:
                raise HTTPException(status_code=409, detail="Runtime command id was already used with a different payload")
            return {**cached["response"], "duplicate": True}

        if request.provider == "cosyvoice":
            if not request.voice:
                raise HTTPException(status_code=400, detail="CosyVoice speaker id is required")
            if request.interrupt:
                await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
            await livetalking_audio(request.session_id, await cosyvoice_synthesize(request.text, request.voice))
            result = {"accepted": True, "provider": "cosyvoice_to_livetalking", "mode": "audio", "command_id": request.command_id}
        else:
            tts = {"voice": request.voice} if request.voice else {}
            await livetalking_post("/human", {"sessionid": request.session_id, "text": request.text, "type": "echo", "interrupt": request.interrupt, "tts": tts})
            result = {"accepted": True, "provider": "livetalking", "mode": "echo", "command_id": request.command_id}
        runtime_command_cache[request.command_id] = {"kind": "speech", "identity": identity, "response": result, "completed_at": now}
        prune_runtime_command_cache(now)
        return {**result, "duplicate": False}

@app.post("/v1/media")
async def media(request: MediaRequest, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    identity = {"session_id": request.session_id, "action": request.action}
    async with runtime_command_lock:
        now = time.monotonic()
        prune_runtime_command_cache(now)
        cached = runtime_command_cache.get(request.command_id)
        if cached:
            if cached["kind"] != "media" or cached["identity"] != identity:
                raise HTTPException(status_code=409, detail="Runtime command id was already used with a different payload")
            return {**cached["response"], "duplicate": True}

        downstream_actions: list[str] = []
        if request.action == "stop_program":
            await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
            downstream_actions.append("interrupt_talk")
            await livetalking_post("/record", {"sessionid": request.session_id, "type": "end_record"})
            downstream_actions.append("end_record")
        elif request.action == "start_program":
            await livetalking_post("/set_audiotype", {"sessionid": request.session_id, "audiotype": PROGRAM_AUDIOTYPE})
            downstream_actions.append("set_program_audiotype")
            await livetalking_post("/record", {"sessionid": request.session_id, "type": "start_record"})
            downstream_actions.append("start_record")
        else:
            await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
            downstream_actions.append("interrupt_talk")
            audiotype = FALLBACK_AUDIOTYPE if request.action == "switch_to_fallback" else HUMAN_HANDOFF_AUDIOTYPE
            await livetalking_post("/set_audiotype", {"sessionid": request.session_id, "audiotype": audiotype})
            downstream_actions.append("set_fallback_audiotype" if request.action == "switch_to_fallback" else "set_human_handoff_audiotype")
        result = {"accepted": True, "provider": "livetalking", "command_id": request.command_id, "action": request.action, "downstream_actions": downstream_actions}
        runtime_command_cache[request.command_id] = {"kind": "media", "identity": identity, "response": result, "completed_at": now}
        prune_runtime_command_cache(now)
        return {**result, "duplicate": False}
