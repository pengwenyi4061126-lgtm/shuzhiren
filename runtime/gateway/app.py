import asyncio
import hmac
import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from audio import pcm_s16le_to_wav

logger = logging.getLogger(__name__)

# Preserve backup-group read access while keeping the durable command journal private.
os.umask(0o027)

LIVE_TALKING_URL = os.environ.get("LIVETALKING_BASE_URL", "http://livetalking:8010").rstrip("/")
COSYVOICE_URL = os.environ.get("COSYVOICE_BASE_URL", "http://cosyvoice:50000").rstrip("/")
COSYVOICE_SAMPLE_RATE = int(os.environ.get("COSYVOICE_SAMPLE_RATE", "24000"))
RUNTIME_TOKEN = os.environ.get("RUNTIME_SHARED_TOKEN", "")
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("RUNTIME_REQUEST_TIMEOUT_SECONDS", "15"))
COSYVOICE_REQUIRED = os.environ.get("COSYVOICE_REQUIRED", "false").lower() == "true"
MEDIA_COMMAND_CACHE_TTL_SECONDS = float(os.environ.get("MEDIA_COMMAND_CACHE_TTL_SECONDS", "3600"))
MEDIA_COMMAND_CACHE_MAX_ENTRIES = int(os.environ.get("MEDIA_COMMAND_CACHE_MAX_ENTRIES", "2048"))
RUNTIME_COMMAND_JOURNAL_PATH = os.environ.get("RUNTIME_COMMAND_JOURNAL_PATH", "")
RUNTIME_COMMAND_JOURNAL_REQUIRED = os.environ.get("RUNTIME_COMMAND_JOURNAL_REQUIRED", "false").lower() == "true"
PREVIEW_BROKER_URL = os.environ.get("PREVIEW_BROKER_URL", "").rstrip("/")
PREVIEW_BROKER_TOKEN = os.environ.get("PREVIEW_BROKER_TOKEN", "")
PREVIEW_GRANT_MAX_SECONDS = int(os.environ.get("PREVIEW_GRANT_MAX_SECONDS", "600"))
runtime_command_cache_lock = asyncio.Lock()
runtime_command_cache: OrderedDict[str, dict] = OrderedDict()
runtime_command_locks: dict[str, dict] = {}
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

@asynccontextmanager
async def lifespan(_: FastAPI):
    validate_runtime_configuration()
    yield

app = FastAPI(title="Shuzhiren Runtime Gateway", version="0.1.0", lifespan=lifespan)

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
    action: Literal["start_program", "switch_to_fallback", "switch_to_human", "stop_program", "insert_program", "resume_program"]
    program_segment_id: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    program_script: str | None = Field(default=None, min_length=1, max_length=800)
    script_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

PROGRAM_AUDIOTYPE = int(os.environ.get("PROGRAM_AUDIOTYPE", "0"))
FALLBACK_AUDIOTYPE = int(os.environ.get("FALLBACK_AUDIOTYPE", "1"))
HUMAN_HANDOFF_AUDIOTYPE = int(os.environ.get("HUMAN_HANDOFF_AUDIOTYPE", "2"))

def authorize(authorization: str | None) -> None:
    if not RUNTIME_TOKEN:
        raise HTTPException(status_code=503, detail="Runtime gateway token is not configured")
    if not authorization or not hmac.compare_digest(authorization, f"Bearer {RUNTIME_TOKEN}"):
        raise HTTPException(status_code=401, detail="Invalid runtime gateway token")

async def livetalking_post(path: str, payload: dict) -> dict:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{LIVE_TALKING_URL}{path}", json=payload)
            response.raise_for_status()
    except httpx.HTTPError as error:
        logger.warning("LiveTalking request failed for %s: %s", path, error)
        raise HTTPException(status_code=502, detail="LiveTalking request failed") from error
    data = response.json()
    if data.get("code") != 0:
        logger.warning("LiveTalking rejected request for %s with code %r", path, data.get("code"))
        raise HTTPException(status_code=502, detail="LiveTalking rejected request")
    return data

async def livetalking_get(path: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{LIVE_TALKING_URL}{path}")
            response.raise_for_status()
    except httpx.HTTPError as error:
        logger.warning("LiveTalking request failed for %s: %s", path, error)
        raise HTTPException(status_code=502, detail="LiveTalking request failed") from error
    data = response.json()
    if data.get("code") != 0:
        logger.warning("LiveTalking rejected request for %s with code %r", path, data.get("code"))
        raise HTTPException(status_code=502, detail="LiveTalking rejected request")
    return data

async def preview_broker_get(session_id: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(
                f"{PREVIEW_BROKER_URL}/v1/previews/{session_id}",
                headers={"authorization": f"Bearer {PREVIEW_BROKER_TOKEN}"},
            )
            response.raise_for_status()
    except httpx.HTTPError as error:
        logger.warning("Preview broker request failed for session %s: %s", session_id, error)
        raise HTTPException(status_code=502, detail="Preview broker request failed") from error
    return validate_preview_grant(response.json())

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

def command_identity_hash(identity: dict) -> str:
    canonical = json.dumps(identity, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def open_runtime_command_journal() -> sqlite3.Connection | None:
    if not RUNTIME_COMMAND_JOURNAL_PATH:
        return None
    path = Path(RUNTIME_COMMAND_JOURNAL_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=5)
    connection.execute("pragma journal_mode = wal")
    connection.execute("pragma synchronous = full")
    connection.execute(
        """create table if not exists runtime_command_journal (
            command_id text primary key,
            kind text not null,
            identity_sha256 text not null,
            state text not null check (state in ('reserved', 'completed')),
            response_json text,
            created_at real not null,
            completed_at real
        )"""
    )
    return connection

def command_journal_status() -> dict:
    if not RUNTIME_COMMAND_JOURNAL_PATH:
        return {"available": False, "required": RUNTIME_COMMAND_JOURNAL_REQUIRED, "durable": False}
    try:
        connection = open_runtime_command_journal()
        if connection is not None:
            connection.close()
    except (OSError, sqlite3.Error):
        return {"available": False, "required": RUNTIME_COMMAND_JOURNAL_REQUIRED, "durable": False}
    return {"available": True, "required": RUNTIME_COMMAND_JOURNAL_REQUIRED, "durable": True}

def validate_runtime_configuration() -> None:
    if len(RUNTIME_TOKEN) < 32 or any(character.isspace() for character in RUNTIME_TOKEN):
        raise RuntimeError("RUNTIME_SHARED_TOKEN must contain at least 32 non-whitespace characters")
    validate_service_url("LIVETALKING_BASE_URL", LIVE_TALKING_URL)
    validate_service_url("COSYVOICE_BASE_URL", COSYVOICE_URL)
    validate_integer_range("COSYVOICE_SAMPLE_RATE", COSYVOICE_SAMPLE_RATE, 8_000, 192_000)
    validate_number_range("RUNTIME_REQUEST_TIMEOUT_SECONDS", REQUEST_TIMEOUT_SECONDS, 0.1, 120)
    validate_number_range("MEDIA_COMMAND_CACHE_TTL_SECONDS", MEDIA_COMMAND_CACHE_TTL_SECONDS, 60, 604_800)
    validate_integer_range("MEDIA_COMMAND_CACHE_MAX_ENTRIES", MEDIA_COMMAND_CACHE_MAX_ENTRIES, 1, 100_000)
    validate_integer_range("PREVIEW_GRANT_MAX_SECONDS", PREVIEW_GRANT_MAX_SECONDS, 30, 3_600)
    if bool(PREVIEW_BROKER_URL) != bool(PREVIEW_BROKER_TOKEN):
        raise RuntimeError("PREVIEW_BROKER_URL and PREVIEW_BROKER_TOKEN must be configured together")
    if PREVIEW_BROKER_URL:
        validate_service_url("PREVIEW_BROKER_URL", PREVIEW_BROKER_URL)
        validate_secret("PREVIEW_BROKER_TOKEN", PREVIEW_BROKER_TOKEN)
    action_slots = {
        "PROGRAM_AUDIOTYPE": PROGRAM_AUDIOTYPE,
        "FALLBACK_AUDIOTYPE": FALLBACK_AUDIOTYPE,
        "HUMAN_HANDOFF_AUDIOTYPE": HUMAN_HANDOFF_AUDIOTYPE,
    }
    for name, value in action_slots.items():
        validate_integer_range(name, value, 0, 255)
    if len(set(action_slots.values())) != len(action_slots):
        raise RuntimeError("PROGRAM_AUDIOTYPE, FALLBACK_AUDIOTYPE, and HUMAN_HANDOFF_AUDIOTYPE must be distinct")
    if RUNTIME_COMMAND_JOURNAL_REQUIRED and not command_journal_status()["available"]:
        raise RuntimeError("Runtime command journal is unavailable")

def validate_service_url(name: str, value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError(f"{name} must be an HTTP(S) base URL without embedded credentials")

def validate_secret(name: str, value: str) -> None:
    if len(value) < 32 or any(character.isspace() for character in value):
        raise RuntimeError(f"{name} must contain at least 32 non-whitespace characters")

def validate_number_range(name: str, value: float, minimum: float, maximum: float) -> None:
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")

def validate_integer_range(name: str, value: int, minimum: int, maximum: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be an integer between {minimum} and {maximum}")

def validate_preview_grant(value: object) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(status_code=502, detail="Preview broker response is invalid")
    url = value.get("url")
    mode = value.get("mode")
    expires_at = value.get("expiresAt")
    if not isinstance(url, str) or not isinstance(mode, str) or not isinstance(expires_at, str):
        raise HTTPException(status_code=502, detail="Preview broker response is invalid")
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or mode != "webrtc":
        raise HTTPException(status_code=502, detail="Preview broker response is invalid")
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if expiry.tzinfo is None:
            raise ValueError("timezone is required")
        seconds_remaining = (expiry.astimezone(timezone.utc) - datetime.now(timezone.utc)).total_seconds()
    except ValueError as error:
        raise HTTPException(status_code=502, detail="Preview broker response is invalid") from error
    if seconds_remaining < 15 or seconds_remaining > PREVIEW_GRANT_MAX_SECONDS:
        raise HTTPException(status_code=502, detail="Preview broker response is invalid")
    return {"url": url, "mode": "webrtc", "expiresAt": expiry.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}

def require_runtime_command_journal() -> sqlite3.Connection | None:
    try:
        connection = open_runtime_command_journal()
    except (OSError, sqlite3.Error) as error:
        if RUNTIME_COMMAND_JOURNAL_REQUIRED:
            raise HTTPException(status_code=503, detail="Runtime command journal is unavailable") from error
        return None
    if connection is None and RUNTIME_COMMAND_JOURNAL_REQUIRED:
        raise HTTPException(status_code=503, detail="Runtime command journal is not configured")
    return connection

def prune_runtime_command_journal(connection: sqlite3.Connection, now: float) -> None:
    expiry = now - MEDIA_COMMAND_CACHE_TTL_SECONDS
    connection.execute("delete from runtime_command_journal where state = 'completed' and completed_at < ?", (expiry,))
    overflow = connection.execute(
        "select command_id from runtime_command_journal where state = 'completed' order by completed_at desc limit -1 offset ?",
        (MEDIA_COMMAND_CACHE_MAX_ENTRIES,),
    ).fetchall()
    if overflow:
        connection.executemany("delete from runtime_command_journal where command_id = ?", overflow)

async def acquire_runtime_command_lock(command_id: str) -> asyncio.Lock:
    async with runtime_command_cache_lock:
        state = runtime_command_locks.get(command_id)
        if state is None:
            state = {"lock": asyncio.Lock(), "waiters": 0}
            runtime_command_locks[command_id] = state
        state["waiters"] += 1
        lock = state["lock"]
    await lock.acquire()
    return lock

async def release_runtime_command_lock(command_id: str, lock: asyncio.Lock) -> None:
    lock.release()
    async with runtime_command_cache_lock:
        state = runtime_command_locks.get(command_id)
        if state is None:
            return
        state["waiters"] -= 1
        if state["waiters"] == 0:
            runtime_command_locks.pop(command_id, None)

async def cached_runtime_command(command_id: str, kind: str, identity: dict) -> dict | None:
    identity_sha256 = command_identity_hash(identity)
    async with runtime_command_cache_lock:
        now = time.monotonic()
        prune_runtime_command_cache(now)
        cached = runtime_command_cache.get(command_id)
        if cached:
            if cached["kind"] != kind or cached["identity_sha256"] != identity_sha256:
                raise HTTPException(status_code=409, detail="Runtime command id was already used with a different payload")
            return {**cached["response"], "duplicate": True}
        connection = require_runtime_command_journal()
        if connection is None:
            return None
        try:
            row = connection.execute(
                "select kind, identity_sha256, state, response_json from runtime_command_journal where command_id = ?",
                (command_id,),
            ).fetchone()
            if not row:
                return None
            stored_kind, stored_identity, state, response_json = row
            if stored_kind != kind or stored_identity != identity_sha256:
                raise HTTPException(status_code=409, detail="Runtime command id was already used with a different payload")
            if state != "completed" or not response_json:
                raise HTTPException(status_code=409, detail="Runtime command outcome is uncertain; verify the media session before issuing a new command")
            response = json.loads(response_json)
            runtime_command_cache[command_id] = {"kind": kind, "identity_sha256": identity_sha256, "response": response, "completed_at": now}
            prune_runtime_command_cache(now)
            return {**response, "duplicate": True}
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=503, detail="Runtime command journal is unreadable") from error
        finally:
            connection.close()

async def reserve_runtime_command(command_id: str, kind: str, identity: dict) -> None:
    identity_sha256 = command_identity_hash(identity)
    async with runtime_command_cache_lock:
        connection = require_runtime_command_journal()
        if connection is None:
            return
        try:
            now = time.time()
            existing = connection.execute(
                "select kind, identity_sha256, state from runtime_command_journal where command_id = ?",
                (command_id,),
            ).fetchone()
            if existing:
                stored_kind, stored_identity, state = existing
                if stored_kind != kind or stored_identity != identity_sha256:
                    raise HTTPException(status_code=409, detail="Runtime command id was already used with a different payload")
                if state != "completed":
                    raise HTTPException(status_code=409, detail="Runtime command outcome is uncertain; verify the media session before issuing a new command")
                return
            connection.execute(
                "insert into runtime_command_journal (command_id, kind, identity_sha256, state, created_at) values (?, ?, ?, 'reserved', ?)",
                (command_id, kind, identity_sha256, now),
            )
            connection.commit()
        finally:
            connection.close()

async def cache_runtime_command(command_id: str, kind: str, identity: dict, response: dict) -> None:
    identity_sha256 = command_identity_hash(identity)
    async with runtime_command_cache_lock:
        connection = require_runtime_command_journal()
        if connection is not None:
            try:
                now = time.time()
                completed = connection.execute(
                    "update runtime_command_journal set state = 'completed', response_json = ?, completed_at = ? where command_id = ? and kind = ? and identity_sha256 = ? and state = 'reserved'",
                    (json.dumps(response, ensure_ascii=False, separators=(",", ":"), sort_keys=True), now, command_id, kind, identity_sha256),
                )
                if completed.rowcount != 1:
                    raise HTTPException(status_code=409, detail="Runtime command journal reservation is no longer valid")
                prune_runtime_command_journal(connection, now)
                connection.commit()
            finally:
                connection.close()
        cache_now = time.monotonic()
        runtime_command_cache[command_id] = {"kind": kind, "identity_sha256": identity_sha256, "response": response, "completed_at": cache_now}
        prune_runtime_command_cache(cache_now)

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
        logger.warning("CosyVoice synthesis request failed: %s", error)
        raise HTTPException(status_code=502, detail="CosyVoice request failed") from error
    return pcm_s16le_to_wav(response.content, COSYVOICE_SAMPLE_RATE)

async def livetalking_audio(session_id: str, audio: bytes) -> None:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{LIVE_TALKING_URL}/humanaudio", data={"sessionid": session_id}, files={"file": ("speech.wav", audio, "audio/wav")})
            response.raise_for_status()
    except httpx.HTTPError as error:
        logger.warning("LiveTalking audio request failed: %s", error)
        raise HTTPException(status_code=502, detail="LiveTalking audio request failed") from error
    data = response.json()
    if data.get("code") != 0:
        logger.warning("LiveTalking rejected audio request with code %r", data.get("code"))
        raise HTTPException(status_code=502, detail="LiveTalking rejected audio request")

@app.get("/healthz")
async def healthz() -> JSONResponse:
    livetalking, cosyvoice = await asyncio.gather(
        service_health(LIVE_TALKING_URL, "/api/admin/sessions", expected_code=0),
        service_health(COSYVOICE_URL, "/openapi.json"),
    )
    command_journal = command_journal_status()
    status = "ok" if livetalking["available"] and (not COSYVOICE_REQUIRED or cosyvoice["available"]) and (not RUNTIME_COMMAND_JOURNAL_REQUIRED or command_journal["available"]) else "degraded"
    return JSONResponse(
        status_code=200 if status == "ok" else 503,
        content={
            "status": status,
            "dependencies": {
                "livetalking": livetalking,
                "cosyvoice": {**cosyvoice, "required": COSYVOICE_REQUIRED},
                "command_journal": command_journal,
            },
            "media_actions": ["start_program", "switch_to_fallback", "switch_to_human", "stop_program", "insert_program", "resume_program"],
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

@app.get("/v1/previews/{session_id}")
async def preview(session_id: str, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    if not SESSION_ID_PATTERN.fullmatch(session_id):
        raise HTTPException(status_code=400, detail="Invalid runtime session id")
    if not PREVIEW_BROKER_URL:
        return {"available": False, "reason": "not_configured"}
    data = await livetalking_get("/api/admin/runtime-metrics")
    sessions = data.get("data", {}).get("sessions", [])
    active = any(isinstance(item, dict) and item.get("sessionid") == session_id for item in sessions)
    if not active:
        return {"available": False, "reason": "session_inactive"}
    return {"available": True, **(await preview_broker_get(session_id))}

def numeric_metric(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None

@app.post("/v1/speak")
async def speak(request: SpeakRequest, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    identity = {"session_id": request.session_id, "text": request.text, "interrupt": request.interrupt, "voice": request.voice, "provider": request.provider}
    lock = await acquire_runtime_command_lock(request.command_id)
    try:
        cached = await cached_runtime_command(request.command_id, "speech", identity)
        if cached:
            return cached
        await reserve_runtime_command(request.command_id, "speech", identity)
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
        await cache_runtime_command(request.command_id, "speech", identity, result)
        return {**result, "duplicate": False}
    finally:
        await release_runtime_command_lock(request.command_id, lock)

@app.post("/v1/media")
async def media(request: MediaRequest, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    if request.action == "insert_program":
        if not request.program_segment_id or not request.program_script or not request.script_sha256:
            raise HTTPException(status_code=400, detail="Program insertion requires segment, script, and script hash")
        if not hmac.compare_digest(hashlib.sha256(request.program_script.encode("utf-8")).hexdigest(), request.script_sha256):
            raise HTTPException(status_code=400, detail="Program script hash does not match script")
    elif request.action == "resume_program":
        if (request.program_script is None) != (request.script_sha256 is None):
            raise HTTPException(status_code=400, detail="Program resume script and hash must be supplied together")
        if request.program_script and not request.program_segment_id:
            raise HTTPException(status_code=400, detail="Program resume script requires a segment")
        if request.program_script and not hmac.compare_digest(hashlib.sha256(request.program_script.encode("utf-8")).hexdigest(), request.script_sha256 or ""):
            raise HTTPException(status_code=400, detail="Program script hash does not match script")
    elif request.program_segment_id or request.program_script or request.script_sha256:
        raise HTTPException(status_code=400, detail="Only program transition actions may carry a script")

    identity = {"session_id": request.session_id, "action": request.action, "program_segment_id": request.program_segment_id, "script_sha256": request.script_sha256}
    lock = await acquire_runtime_command_lock(request.command_id)
    try:
        cached = await cached_runtime_command(request.command_id, "media", identity)
        if cached:
            return cached
        await reserve_runtime_command(request.command_id, "media", identity)
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
        elif request.action in ("insert_program", "resume_program"):
            await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
            downstream_actions.append("interrupt_talk")
            await livetalking_post("/set_audiotype", {"sessionid": request.session_id, "audiotype": PROGRAM_AUDIOTYPE})
            downstream_actions.append("set_program_audiotype")
            if request.program_script:
                await livetalking_post("/human", {"sessionid": request.session_id, "text": request.program_script, "type": "echo", "interrupt": True})
                downstream_actions.append("play_frozen_program_script")
        else:
            await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
            downstream_actions.append("interrupt_talk")
            audiotype = FALLBACK_AUDIOTYPE if request.action == "switch_to_fallback" else HUMAN_HANDOFF_AUDIOTYPE
            await livetalking_post("/set_audiotype", {"sessionid": request.session_id, "audiotype": audiotype})
            downstream_actions.append("set_fallback_audiotype" if request.action == "switch_to_fallback" else "set_human_handoff_audiotype")
        accepted_at = datetime.now(timezone.utc).isoformat()
        result = {"accepted": True, "provider": "livetalking", "command_id": request.command_id, "session_id": request.session_id, "action": request.action, "program_segment_id": request.program_segment_id, "downstream_actions": downstream_actions, "receipt": {"command_id": request.command_id, "session_id": request.session_id, "action": request.action, "program_segment_id": request.program_segment_id, "accepted_at": accepted_at, "evidence": "livetalking_api_accepted"}}
        await cache_runtime_command(request.command_id, "media", identity, result)
        return {**result, "duplicate": False}
    finally:
        await release_runtime_command_lock(request.command_id, lock)
