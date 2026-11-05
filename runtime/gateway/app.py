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
import unicodedata
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
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
# sft: /inference_sft with spk_id = runtime voice id. zero_shot: /inference_zero_shot with the
# approved reference audio and transcript from the read-only voice library. No default (D2).
COSYVOICE_MODEL_KIND = os.environ.get("COSYVOICE_MODEL_KIND", "")
COSYVOICE_VOICE_LIBRARY_DIR = os.environ.get("COSYVOICE_VOICE_LIBRARY_DIR", "")
COSYVOICE_CHUNK_MAX_CHARS = int(os.environ.get("COSYVOICE_CHUNK_MAX_CHARS", "120"))
# Total upstream budget of one command, counted from its journal reservation.
RUNTIME_COMMAND_DEADLINE_SECONDS = int(os.environ.get("RUNTIME_COMMAND_DEADLINE_SECONDS", "15"))
MEDIA_COMMAND_CACHE_TTL_SECONDS = float(os.environ.get("MEDIA_COMMAND_CACHE_TTL_SECONDS", "3600"))
MEDIA_COMMAND_CACHE_MAX_ENTRIES = int(os.environ.get("MEDIA_COMMAND_CACHE_MAX_ENTRIES", "2048"))
RUNTIME_COMMAND_JOURNAL_PATH = os.environ.get("RUNTIME_COMMAND_JOURNAL_PATH", "")
RUNTIME_COMMAND_JOURNAL_REQUIRED = os.environ.get("RUNTIME_COMMAND_JOURNAL_REQUIRED", "false").lower() == "true"
# SQLite waits this long for another connection's write lock. Journal calls run
# in worker threads, so the wait never blocks the event loop.
JOURNAL_BUSY_TIMEOUT_SECONDS = 5.0
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

# The interactive docs and the OpenAPI schema are not registered: every
# Gateway route except /healthz requires the shared runtime token.
app = FastAPI(
    title="Shuzhiren Runtime Gateway",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    swagger_ui_oauth2_redirect_url=None,
)

class SpeakRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    session_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    text: str = Field(min_length=1, max_length=800)
    interrupt: bool = False
    # Voice fields are checked in validate_speak_request so every bad value is a 400, not a 422.
    voice: str | None = None
    voice_checksum: str | None = None
    # Both values are synthesized by CosyVoice; "livetalking" no longer selects LiveTalking's own TTS.
    provider: Literal["cosyvoice", "livetalking"] = "cosyvoice"

class MediaRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    session_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    action: Literal["start_program", "switch_to_fallback", "switch_to_human", "stop_program", "insert_program", "resume_program"]
    program_segment_id: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    program_script: str | None = Field(default=None, min_length=1, max_length=800)
    script_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    runtime_voice_id: str | None = None
    voice_checksum: str | None = None

VOICE_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
VOICE_CHECKSUM_PATTERN = re.compile(r"sha256:[0-9a-fA-F]{64}")
# The Gateway only drives LiveTalking avatar state; speech audio goes through /humanaudio.
# /human would make LiveTalking synthesize the text with its own TTS plugin (edge-tts).
LIVETALKING_POST_PATHS = frozenset({"/interrupt_talk", "/set_audiotype", "/record"})
VOICE_PROMPT_WAV_MAX_BYTES = 16 * 1024 * 1024
VOICE_PROMPT_TEXT_MAX_CHARS = 1000
COSYVOICE_MAX_AUDIO_SECONDS = 600

class CommandFailure(HTTPException):
    """A command that definitely did not reach LiveTalking. The body names the failing dependency."""

    def __init__(self, status_code: int, detail: str, failure_source: str, failure_reason: str, chunk_index: int | None = None, upstream_status: int | None = None):
        super().__init__(status_code=status_code, detail=detail)
        self.failure_source = failure_source
        self.failure_reason = failure_reason
        self.chunk_index = chunk_index
        self.upstream_status = upstream_status

    def body(self) -> dict:
        return {
            "detail": self.detail,
            "code": "command_failed_definite",
            "reason": f"{self.failure_source}_failed",
            "failure_source": self.failure_source,
            "failure_reason": self.failure_reason,
            "chunk_index": self.chunk_index,
            "upstream_status": self.upstream_status,
        }

@app.exception_handler(CommandFailure)
async def command_failure_response(_request: Request, error: CommandFailure) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content=error.body())

@dataclass(frozen=True)
class VoiceSpec:
    runtime_voice_id: str
    prompt_wav: bytes | None = None
    prompt_text: str | None = None

@dataclass(frozen=True)
class SynthesisResult:
    pcm: bytes
    chunks: int
    synth_ms: int

PROGRAM_AUDIOTYPE = int(os.environ.get("PROGRAM_AUDIOTYPE", "0"))
FALLBACK_AUDIOTYPE = int(os.environ.get("FALLBACK_AUDIOTYPE", "1"))
HUMAN_HANDOFF_AUDIOTYPE = int(os.environ.get("HUMAN_HANDOFF_AUDIOTYPE", "2"))

def bearer_matches(authorization: str | None, token: str) -> bool:
    if not authorization:
        return False
    try:
        # Starlette decodes header bytes as latin-1; encoding back restores the raw bytes.
        presented = authorization.encode("latin-1")
    except UnicodeEncodeError:
        return False
    expected = f"Bearer {token}".encode("utf-8")
    return hmac.compare_digest(hashlib.sha256(presented).digest(), hashlib.sha256(expected).digest())

def authorize(authorization: str | None) -> None:
    if not RUNTIME_TOKEN:
        raise HTTPException(status_code=503, detail="Runtime gateway token is not configured")
    if not bearer_matches(authorization, RUNTIME_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid runtime gateway token")

def parse_upstream_json(response: httpx.Response, upstream: str) -> dict:
    try:
        data = response.json()
    except ValueError as error:
        logger.warning("%s returned an invalid response (status %s, %s)", upstream, response.status_code, type(error).__name__)
        raise HTTPException(status_code=502, detail=f"{upstream} returned an invalid response") from error
    if not isinstance(data, dict):
        logger.warning("%s returned an invalid response (status %s, %s)", upstream, response.status_code, type(data).__name__)
        raise HTTPException(status_code=502, detail=f"{upstream} returned an invalid response")
    return data

def livetalking_sessions(data: dict) -> list:
    payload = data.get("data", {})
    sessions = payload.get("sessions", []) if isinstance(payload, dict) else None
    if not isinstance(sessions, list):
        logger.warning("LiveTalking returned runtime metrics without a session list")
        raise HTTPException(status_code=502, detail="LiveTalking returned an invalid response")
    return sessions

async def livetalking_post(path: str, payload: dict) -> dict:
    if path not in LIVETALKING_POST_PATHS:
        raise RuntimeError(f"LiveTalking path {path} is not allowed")
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{LIVE_TALKING_URL}{path}", json=payload)
            response.raise_for_status()
    except httpx.HTTPError as error:
        logger.warning("LiveTalking request failed for %s: %s", path, error)
        raise HTTPException(status_code=502, detail="LiveTalking request failed") from error
    data = parse_upstream_json(response, "LiveTalking")
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
    data = parse_upstream_json(response, "LiveTalking")
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
    return validate_preview_grant(parse_upstream_json(response, "Preview broker"))

async def service_health(url: str, path: str, expected_code: int | None = None) -> dict:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{url}{path}")
        # Only 200 counts: a redirect or an empty 204 is not a loaded, listening service.
        if response.status_code != 200:
            return {"available": False}
        if expected_code is not None:
            data = response.json()
            if not isinstance(data, dict) or data.get("code") != expected_code:
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
    connection = sqlite3.connect(path, timeout=JOURNAL_BUSY_TIMEOUT_SECONDS)
    try:
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
    except BaseException:
        connection.close()
        raise
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
    if COSYVOICE_MODEL_KIND not in ("sft", "zero_shot"):
        raise RuntimeError("COSYVOICE_MODEL_KIND must be sft or zero_shot")
    # The voice library may be missing or broken at startup: commands without speech must still run.
    if COSYVOICE_MODEL_KIND == "zero_shot" and not os.path.isabs(COSYVOICE_VOICE_LIBRARY_DIR):
        raise RuntimeError("COSYVOICE_VOICE_LIBRARY_DIR must be an absolute path when COSYVOICE_MODEL_KIND is zero_shot")
    validate_integer_range("COSYVOICE_CHUNK_MAX_CHARS", COSYVOICE_CHUNK_MAX_CHARS, 20, 800)
    validate_integer_range("RUNTIME_COMMAND_DEADLINE_SECONDS", RUNTIME_COMMAND_DEADLINE_SECONDS, 1, 59)
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

JOURNAL_ENTRY_COLUMNS = "kind, identity_sha256, state, response_json"
UNCERTAIN_COMMAND_DETAIL = "Runtime command outcome is uncertain; verify the media session before issuing a new command"

# The read_/reserve_/complete_ journal functions are synchronous and run in a
# worker thread through asyncio.to_thread. Each opens, uses, and closes its own
# connection inside that thread, so SQLite lock waits never stall the event loop.
def read_journal_entry(command_id: str) -> tuple | None:
    connection = require_runtime_command_journal()
    if connection is None:
        return None
    try:
        return connection.execute(f"select {JOURNAL_ENTRY_COLUMNS} from runtime_command_journal where command_id = ?", (command_id,)).fetchone()
    except sqlite3.Error as error:
        raise HTTPException(status_code=503, detail="Runtime command journal is unavailable") from error
    finally:
        connection.close()

def reserve_journal_entry(command_id: str, kind: str, identity_sha256: str, now: float) -> tuple | None:
    """Insert a reservation and return None, or return the existing entry without changing it."""
    connection = require_runtime_command_journal()
    if connection is None:
        return None
    try:
        existing = connection.execute(f"select {JOURNAL_ENTRY_COLUMNS} from runtime_command_journal where command_id = ?", (command_id,)).fetchone()
        if existing:
            return existing
        connection.execute(
            "insert into runtime_command_journal (command_id, kind, identity_sha256, state, created_at) values (?, ?, ?, 'reserved', ?)",
            (command_id, kind, identity_sha256, now),
        )
        connection.commit()
        return None
    except sqlite3.Error as error:
        # Nothing was sent downstream yet, so the caller may retry the same command id.
        raise HTTPException(status_code=503, detail="Runtime command journal is unavailable") from error
    finally:
        connection.close()

def complete_journal_entry(command_id: str, kind: str, identity_sha256: str, response_json: str, now: float) -> None:
    connection = require_runtime_command_journal()
    if connection is None:
        return
    try:
        completed = connection.execute(
            "update runtime_command_journal set state = 'completed', response_json = ?, completed_at = ? where command_id = ? and kind = ? and identity_sha256 = ? and state = 'reserved'",
            (response_json, now, command_id, kind, identity_sha256),
        )
        if completed.rowcount != 1:
            raise HTTPException(status_code=409, detail="Runtime command journal reservation is no longer valid")
        prune_runtime_command_journal(connection, now)
        connection.commit()
    except sqlite3.Error as error:
        # The downstream calls already ran; the reservation stays and retries report the outcome as uncertain.
        raise HTTPException(status_code=503, detail=UNCERTAIN_COMMAND_DETAIL) from error
    finally:
        connection.close()

def release_journal_entry(command_id: str, kind: str, identity_sha256: str) -> None:
    """Drop a reservation whose command failed before any LiveTalking call, so a retry may run it."""
    try:
        connection = require_runtime_command_journal()
    except HTTPException:
        logger.warning("Runtime command journal unavailable; reservation of %s stays uncertain", command_id)
        return
    if connection is None:
        return
    try:
        connection.execute(
            "delete from runtime_command_journal where command_id = ? and kind = ? and identity_sha256 = ? and state = 'reserved'",
            (command_id, kind, identity_sha256),
        )
        connection.commit()
    except sqlite3.Error:
        # The reservation stays; retries then report the outcome as uncertain, which is still safe.
        logger.warning("Runtime command journal could not release reservation of %s", command_id)
    finally:
        connection.close()

def stored_command_response(entry: tuple, kind: str, identity_sha256: str) -> dict:
    stored_kind, stored_identity, state, response_json = entry
    if stored_kind != kind or stored_identity != identity_sha256:
        raise HTTPException(status_code=409, detail="Runtime command id was already used with a different payload")
    if state != "completed" or not response_json:
        raise HTTPException(status_code=409, detail=UNCERTAIN_COMMAND_DETAIL)
    try:
        return json.loads(response_json)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=503, detail="Runtime command journal is unreadable") from error

def remember_completed_command(command_id: str, kind: str, identity_sha256: str, response: dict) -> None:
    now = time.monotonic()
    runtime_command_cache[command_id] = {"kind": kind, "identity_sha256": identity_sha256, "response": response, "completed_at": now}
    prune_runtime_command_cache(now)

async def cached_runtime_command(command_id: str, kind: str, identity: dict) -> dict | None:
    identity_sha256 = command_identity_hash(identity)
    async with runtime_command_cache_lock:
        prune_runtime_command_cache(time.monotonic())
        cached = runtime_command_cache.get(command_id)
        if cached:
            if cached["kind"] != kind or cached["identity_sha256"] != identity_sha256:
                raise HTTPException(status_code=409, detail="Runtime command id was already used with a different payload")
            return {**cached["response"], "duplicate": True}
        entry = await asyncio.to_thread(read_journal_entry, command_id)
        if entry is None:
            return None
        response = stored_command_response(entry, kind, identity_sha256)
        remember_completed_command(command_id, kind, identity_sha256, response)
        return {**response, "duplicate": True}

async def reserve_runtime_command(command_id: str, kind: str, identity: dict) -> dict | None:
    """Reserve a new command id, or return the stored result of a completed command with the same payload."""
    identity_sha256 = command_identity_hash(identity)
    async with runtime_command_cache_lock:
        existing = await asyncio.to_thread(reserve_journal_entry, command_id, kind, identity_sha256, time.time())
        if existing is None:
            return None
        response = stored_command_response(existing, kind, identity_sha256)
        remember_completed_command(command_id, kind, identity_sha256, response)
        return {**response, "duplicate": True}

async def release_runtime_command(command_id: str, kind: str, identity: dict) -> None:
    identity_sha256 = command_identity_hash(identity)
    async with runtime_command_cache_lock:
        await asyncio.to_thread(release_journal_entry, command_id, kind, identity_sha256)

async def cache_runtime_command(command_id: str, kind: str, identity: dict, response: dict) -> None:
    identity_sha256 = command_identity_hash(identity)
    response_json = json.dumps(response, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    async with runtime_command_cache_lock:
        await asyncio.to_thread(complete_journal_entry, command_id, kind, identity_sha256, response_json, time.time())
        remember_completed_command(command_id, kind, identity_sha256, response)

def gpu_observation() -> dict:
    try:
        from pynvml import nvmlDeviceGetHandleByIndex, nvmlDeviceGetMemoryInfo, nvmlDeviceGetUtilizationRates, nvmlInit, nvmlShutdown
        nvmlInit()
        try:
            # The container runtime exposes only the GPUs selected by
            # NVIDIA_VISIBLE_DEVICES, so NVML device 0 is the first selected GPU
            # whatever host index or UUID the variable names.
            handle = nvmlDeviceGetHandleByIndex(0)
            memory = nvmlDeviceGetMemoryInfo(handle)
            utilization = nvmlDeviceGetUtilizationRates(handle)
            return {"available": True, "utilization_percent": int(utilization.gpu), "memory_used_mib": int(memory.used // (1024 * 1024)), "memory_total_mib": int(memory.total // (1024 * 1024))}
        finally:
            nvmlShutdown()
    except Exception:
        return {"available": False}

SENTENCE_END_CHARS = frozenset("。！？!?；;…\n")
SENTENCE_CLOSING_CHARS = frozenset("”’」』）)】》\"'")
SECONDARY_BREAK_CHARS = frozenset("，,、：:")

def pronounceable(text: str) -> bool:
    return any(unicodedata.category(character)[0] in "LN" for character in text)

def split_sentences(text: str) -> list[str]:
    sentences: list[str] = []
    start = index = 0
    while index < len(text):
        if text[index] in SENTENCE_END_CHARS:
            index += 1
            while index < len(text) and (text[index] in SENTENCE_END_CHARS or text[index] in SENTENCE_CLOSING_CHARS):
                index += 1
            sentences.append(text[start:index])
            start = index
        else:
            index += 1
    if start < len(text):
        sentences.append(text[start:])
    return sentences

def cut_long_sentence(sentence: str, max_chars: int) -> list[str]:
    pieces: list[str] = []
    while len(sentence) > max_chars:
        cut = next((end for end in range(max_chars, 0, -1) if sentence[end - 1] in SECONDARY_BREAK_CHARS or sentence[end - 1].isspace()), max_chars)
        pieces.append(sentence[:cut])
        sentence = sentence[cut:]
    if sentence:
        pieces.append(sentence)
    return pieces

def split_script(text: str, max_chars: int) -> list[str]:
    """Split text into CosyVoice requests. Joining the result gives back the text unchanged."""
    segments: list[str] = []
    for sentence in split_sentences(text):
        for piece in cut_long_sentence(sentence, max_chars):
            if segments and len(segments[-1]) + len(piece) <= max_chars:
                segments[-1] += piece
            else:
                segments.append(piece)
    # A segment of punctuation or whitespace alone would make CosyVoice return no audio. Joining
    # it to a neighbour adds only non-pronounceable characters at that neighbour's edge.
    merged: list[str] = []
    pending = ""
    for segment in segments:
        if not pronounceable(segment):
            if merged:
                merged[-1] += segment
            else:
                pending += segment
            continue
        merged.append(pending + segment)
        pending = ""
    if pending:
        merged.append(pending)
    return merged

def voice_material_failure(reason: str) -> CommandFailure:
    return CommandFailure(503, "Approved voice material is unavailable", "voice_library", reason)

def read_voice_file(path: Path, limit: int) -> bytes:
    try:
        with open(path, "rb") as handle:
            content = handle.read(limit + 1)
    except FileNotFoundError as error:
        raise voice_material_failure("voice_material_missing") from error
    except OSError as error:
        raise voice_material_failure("voice_material_unreadable") from error
    if len(content) > limit:
        raise voice_material_failure("voice_material_invalid")
    return content

def load_voice_spec(runtime_voice_id: str, voice_checksum: str | None) -> VoiceSpec:
    """Read the approved zero-shot reference audio and transcript; synchronous, run in a thread."""
    if COSYVOICE_MODEL_KIND == "sft":
        return VoiceSpec(runtime_voice_id)
    if not COSYVOICE_VOICE_LIBRARY_DIR or not voice_checksum:
        raise voice_material_failure("voice_material_missing")
    library = Path(os.path.realpath(COSYVOICE_VOICE_LIBRARY_DIR))
    directory = library / runtime_voice_id
    paths = {name: Path(os.path.realpath(directory / name)) for name in ("prompt.wav", "prompt.txt")}
    if any(library not in path.parents for path in paths.values()):
        raise voice_material_failure("voice_material_invalid")
    prompt_wav = read_voice_file(paths["prompt.wav"], VOICE_PROMPT_WAV_MAX_BYTES)
    if len(prompt_wav) < 12 or prompt_wav[:4] != b"RIFF" or prompt_wav[8:12] != b"WAVE":
        raise voice_material_failure("voice_material_invalid")
    if not hmac.compare_digest(hashlib.sha256(prompt_wav).hexdigest(), voice_checksum.split(":", 1)[1].lower()):
        raise voice_material_failure("voice_material_checksum_mismatch")
    try:
        prompt_text = read_voice_file(paths["prompt.txt"], VOICE_PROMPT_TEXT_MAX_CHARS * 4 + 2).decode("utf-8")
    except UnicodeDecodeError as error:
        raise voice_material_failure("voice_material_invalid") from error
    if prompt_text.endswith("\r\n"):
        prompt_text = prompt_text[:-2]
    elif prompt_text.endswith("\n"):
        prompt_text = prompt_text[:-1]
    if not 1 <= len(prompt_text) <= VOICE_PROMPT_TEXT_MAX_CHARS or "\x00" in prompt_text:
        raise voice_material_failure("voice_material_invalid")
    return VoiceSpec(runtime_voice_id, prompt_wav, prompt_text)

def cosyvoice_failure(status_code: int, detail: str, reason: str, chunk_index: int, upstream_status: int | None = None) -> CommandFailure:
    return CommandFailure(status_code, detail, "cosyvoice", reason, chunk_index, upstream_status)

async def cosyvoice_chunk(text: str, voice: VoiceSpec, chunk_index: int, remaining_seconds: float, max_bytes: int) -> bytes:
    if COSYVOICE_MODEL_KIND == "sft":
        path, data, files = "/inference_sft", {"tts_text": text, "spk_id": voice.runtime_voice_id}, None
    else:
        path = "/inference_zero_shot"
        data = {"tts_text": text, "prompt_text": voice.prompt_text or ""}
        files = {"prompt_wav": ("prompt.wav", voice.prompt_wav or b"", "audio/wav")}
    audio = bytearray()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=min(5.0, remaining_seconds))) as client:
            async with client.stream("POST", f"{COSYVOICE_URL}{path}", data=data, files=files) as response:
                if not 200 <= response.status_code < 300:
                    raise cosyvoice_failure(502, "CosyVoice rejected the synthesis request", "cosyvoice_http_status", chunk_index, response.status_code)
                async for part in response.aiter_bytes():
                    audio.extend(part)
                    if len(audio) > max_bytes:
                        raise cosyvoice_failure(502, "CosyVoice returned too much audio", "cosyvoice_audio_too_long", chunk_index)
    except (httpx.ConnectError, httpx.ConnectTimeout) as error:
        logger.warning("CosyVoice unreachable for chunk %d: %s", chunk_index, type(error).__name__)
        raise cosyvoice_failure(502, "CosyVoice request failed", "cosyvoice_unreachable", chunk_index) from error
    except httpx.TimeoutException as error:
        logger.warning("CosyVoice timed out for chunk %d: %s", chunk_index, type(error).__name__)
        raise cosyvoice_failure(502, "CosyVoice request timed out", "cosyvoice_timeout", chunk_index) from error
    except httpx.HTTPError as error:
        logger.warning("CosyVoice stream interrupted for chunk %d: %s", chunk_index, type(error).__name__)
        raise cosyvoice_failure(502, "CosyVoice audio stream was interrupted", "cosyvoice_stream_interrupted", chunk_index) from error
    if not audio:
        raise cosyvoice_failure(502, "CosyVoice returned no audio", "cosyvoice_empty_audio", chunk_index)
    if len(audio) % 2:
        raise cosyvoice_failure(502, "CosyVoice returned incomplete audio", "cosyvoice_odd_audio_length", chunk_index)
    return bytes(audio)

async def cosyvoice_synthesize(text: str, voice: VoiceSpec, deadline: float) -> SynthesisResult:
    """Synthesize every segment in order before anything reaches LiveTalking (D2)."""
    started = time.monotonic()
    chunks = split_script(text, COSYVOICE_CHUNK_MAX_CHARS)
    max_bytes = COSYVOICE_SAMPLE_RATE * 2 * COSYVOICE_MAX_AUDIO_SECONDS
    pcm = bytearray()
    for index, chunk in enumerate(chunks):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise cosyvoice_failure(504, "CosyVoice synthesis exceeded the command deadline", "cosyvoice_deadline_exceeded", index)
        chunk_started = time.monotonic()
        try:
            audio = await asyncio.wait_for(cosyvoice_chunk(chunk, voice, index, remaining, max_bytes - len(pcm)), timeout=remaining)
        except asyncio.TimeoutError as error:
            raise cosyvoice_failure(504, "CosyVoice synthesis exceeded the command deadline", "cosyvoice_deadline_exceeded", index) from error
        pcm.extend(audio)
        logger.info("cosyvoice_chunk index=%d bytes=%d ms=%d", index, len(audio), int((time.monotonic() - chunk_started) * 1000))
    return SynthesisResult(bytes(pcm), len(chunks), int((time.monotonic() - started) * 1000))

async def livetalking_audio(session_id: str, audio: bytes) -> None:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{LIVE_TALKING_URL}/humanaudio", data={"sessionid": session_id}, files={"file": ("speech.wav", audio, "audio/wav")})
            response.raise_for_status()
    except httpx.HTTPError as error:
        logger.warning("LiveTalking audio request failed: %s", error)
        raise HTTPException(status_code=502, detail="LiveTalking audio request failed") from error
    data = parse_upstream_json(response, "LiveTalking")
    if data.get("code") != 0:
        logger.warning("LiveTalking rejected audio request with code %r", data.get("code"))
        raise HTTPException(status_code=502, detail="LiveTalking rejected audio request")

@app.get("/healthz")
async def healthz() -> JSONResponse:
    livetalking, cosyvoice = await asyncio.gather(
        service_health(LIVE_TALKING_URL, "/api/admin/sessions", expected_code=0),
        service_health(COSYVOICE_URL, "/openapi.json"),
    )
    command_journal = await asyncio.to_thread(command_journal_status)
    status = "ok" if livetalking["available"] and (not COSYVOICE_REQUIRED or cosyvoice["available"]) and (not RUNTIME_COMMAND_JOURNAL_REQUIRED or command_journal["available"]) else "degraded"
    return JSONResponse(
        status_code=200 if status == "ok" else 503,
        content={
            "status": status,
            "dependencies": {
                "livetalking": livetalking,
                "cosyvoice": {**cosyvoice, "required": COSYVOICE_REQUIRED, "model_kind": COSYVOICE_MODEL_KIND},
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
    sessions = livetalking_sessions(data)
    session = next((item for item in sessions if isinstance(item, dict) and item.get("sessionid") == session_id), None)
    if not session:
        return {
            "session": {"id": session_id, "active": False, "speaking": False, "recording": False},
            "gpu": await asyncio.to_thread(gpu_observation),
            "quality": {"writer_accepting_frames": False, "output_fps": None, "inference_fps": None, "configured_bitrate_mbps": None, "actual_bitrate_mbps": None, "av_sync_ms": None, "destination_receipt": None},
            "limitations": ["session_not_found", "destination_receipt_not_available", "actual_bitrate_not_available", "av_sync_not_available"],
        }
    metrics = session.get("metrics") if isinstance(session.get("metrics"), dict) else {}
    return {
        "session": {"id": session_id, "active": True, "speaking": bool(session.get("speaking")), "recording": bool(session.get("recording"))},
        "gpu": await asyncio.to_thread(gpu_observation),
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
    sessions = livetalking_sessions(data)
    active = any(isinstance(item, dict) and item.get("sessionid") == session_id for item in sessions)
    if not active:
        return {"available": False, "reason": "session_inactive"}
    return {"available": True, **(await preview_broker_get(session_id))}

def numeric_metric(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def script_sha256_matches(script: str, expected: str | None) -> bool:
    return hmac.compare_digest(hashlib.sha256(script.encode("utf-8")).hexdigest(), expected or "")

def validate_voice_checksum(voice_checksum: str | None) -> None:
    if voice_checksum is None:
        if COSYVOICE_MODEL_KIND != "sft":
            raise HTTPException(status_code=400, detail="Approved voice checksum is required")
        return
    if not isinstance(voice_checksum, str) or not VOICE_CHECKSUM_PATTERN.fullmatch(voice_checksum):
        raise HTTPException(status_code=400, detail="Approved voice checksum is invalid")

def validate_runtime_voice(runtime_voice_id: str | None, voice_checksum: str | None) -> None:
    if not isinstance(runtime_voice_id, str) or not VOICE_ID_PATTERN.fullmatch(runtime_voice_id):
        raise HTTPException(status_code=400, detail="Approved runtime voice id is required")
    validate_voice_checksum(voice_checksum)

def validate_speak_request(request: SpeakRequest) -> None:
    # Every deterministic rejection happens before the command id is reserved,
    # so an invalid request never consumes the id of the corrected retry.
    # Both providers are synthesized by CosyVoice with the approved voice.
    validate_runtime_voice(request.voice, request.voice_checksum)
    if not pronounceable(request.text):
        raise HTTPException(status_code=400, detail="Speech text has nothing to pronounce")

def validate_media_request(request: MediaRequest) -> None:
    if request.action == "insert_program":
        if not request.program_segment_id or not request.program_script or not request.script_sha256:
            raise HTTPException(status_code=400, detail="Program insertion requires segment, script, and script hash")
        if not script_sha256_matches(request.program_script, request.script_sha256):
            raise HTTPException(status_code=400, detail="Program script hash does not match script")
    elif request.action == "start_program":
        if (request.program_script is None) != (request.script_sha256 is None):
            raise HTTPException(status_code=400, detail="Program start script and hash must be supplied together")
        if request.program_script and not request.program_segment_id:
            raise HTTPException(status_code=400, detail="Program start script requires a segment")
        if request.program_script and not script_sha256_matches(request.program_script, request.script_sha256):
            raise HTTPException(status_code=400, detail="Program script hash does not match script")
    elif request.action == "resume_program":
        if (request.program_script is None) != (request.script_sha256 is None):
            raise HTTPException(status_code=400, detail="Program resume script and hash must be supplied together")
        if request.program_script and not request.program_segment_id:
            raise HTTPException(status_code=400, detail="Program resume script requires a segment")
        if request.program_script and not script_sha256_matches(request.program_script, request.script_sha256):
            raise HTTPException(status_code=400, detail="Program script hash does not match script")
    elif request.program_segment_id or request.program_script or request.script_sha256:
        raise HTTPException(status_code=400, detail="Only program transition actions may carry a script")
    if request.program_script:
        validate_runtime_voice(request.runtime_voice_id, request.voice_checksum)
        if not pronounceable(request.program_script):
            raise HTTPException(status_code=400, detail="Program script has nothing to pronounce")
    elif request.runtime_voice_id is not None or request.voice_checksum is not None:
        raise HTTPException(status_code=400, detail="Only commands with a program script may carry a voice")

def synthesis_deadline(deadline: float) -> float:
    # Leave time for the LiveTalking calls that follow synthesis.
    return deadline - min(3.0, 0.25 * RUNTIME_COMMAND_DEADLINE_SECONDS)

async def synthesize_reserved_command(command_id: str, kind: str, identity: dict, text: str, voice: VoiceSpec, deadline: float) -> tuple[SynthesisResult, bytes]:
    """Synthesize a reserved command's speech as one WAV before any LiveTalking call."""
    try:
        synthesis = await cosyvoice_synthesize(text, voice, synthesis_deadline(deadline))
        return synthesis, pcm_s16le_to_wav(synthesis.pcm, COSYVOICE_SAMPLE_RATE)
    except Exception:
        # Nothing reached LiveTalking, so the command definitely did not run: release the id.
        await release_runtime_command(command_id, kind, identity)
        raise

def synthesis_summary(synthesis: SynthesisResult) -> dict:
    return {"model_kind": COSYVOICE_MODEL_KIND, "chunks": synthesis.chunks, "audio_bytes": len(synthesis.pcm), "sample_rate": COSYVOICE_SAMPLE_RATE}

def log_command_timing(command_id: str, kind: str, synthesis: SynthesisResult, reserved_at: float) -> None:
    logger.info("runtime_command_timing command_id=%s kind=%s chunks=%d synth_ms=%d audio_ack_ms=%d", command_id, kind, synthesis.chunks, synthesis.synth_ms, int((time.monotonic() - reserved_at) * 1000))

@app.post("/v1/speak")
async def speak(request: SpeakRequest, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    validate_speak_request(request)
    identity = {"session_id": request.session_id, "text": request.text, "interrupt": request.interrupt, "voice": request.voice, "provider": request.provider}
    if request.voice_checksum is not None:
        identity["voice_checksum"] = request.voice_checksum
    lock = await acquire_runtime_command_lock(request.command_id)
    try:
        cached = await cached_runtime_command(request.command_id, "speech", identity)
        if cached:
            return cached
        # Voice material problems are fixed by the deployer; the command id is not consumed.
        voice = await asyncio.to_thread(load_voice_spec, request.voice, request.voice_checksum)
        replay = await reserve_runtime_command(request.command_id, "speech", identity)
        if replay:
            return replay
        reserved_at = time.monotonic()
        synthesis, audio = await synthesize_reserved_command(request.command_id, "speech", identity, request.text, voice, reserved_at + RUNTIME_COMMAND_DEADLINE_SECONDS)
        if request.interrupt:
            await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
        await livetalking_audio(request.session_id, audio)
        log_command_timing(request.command_id, "speech", synthesis, reserved_at)
        result = {"accepted": True, "provider": "cosyvoice_to_livetalking", "requested_provider": request.provider, "mode": "audio", "command_id": request.command_id, "synthesis": synthesis_summary(synthesis)}
        await cache_runtime_command(request.command_id, "speech", identity, result)
        return {**result, "duplicate": False}
    finally:
        await release_runtime_command_lock(request.command_id, lock)

@app.post("/v1/media")
async def media(request: MediaRequest, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    validate_media_request(request)
    identity = {"session_id": request.session_id, "action": request.action, "program_segment_id": request.program_segment_id, "script_sha256": request.script_sha256}
    if request.program_script:
        identity["runtime_voice_id"] = request.runtime_voice_id
        identity["voice_checksum"] = request.voice_checksum
    lock = await acquire_runtime_command_lock(request.command_id)
    try:
        cached = await cached_runtime_command(request.command_id, "media", identity)
        if cached:
            return cached
        voice = await asyncio.to_thread(load_voice_spec, request.runtime_voice_id, request.voice_checksum) if request.program_script else None
        replay = await reserve_runtime_command(request.command_id, "media", identity)
        if replay:
            return replay
        reserved_at = time.monotonic()
        synthesis: SynthesisResult | None = None
        audio = b""
        if request.program_script and voice is not None:
            synthesis, audio = await synthesize_reserved_command(request.command_id, "media", identity, request.program_script, voice, reserved_at + RUNTIME_COMMAND_DEADLINE_SECONDS)
        downstream_actions: list[str] = []
        if request.action == "stop_program":
            await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
            downstream_actions.append("interrupt_talk")
            await livetalking_post("/record", {"sessionid": request.session_id, "type": "end_record"})
            downstream_actions.append("end_record")
        elif request.action == "start_program":
            if synthesis:
                # Interrupt before /set_audiotype: LiveTalking's flush resets the audiotype to 0.
                await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
                downstream_actions.append("interrupt_talk")
            await livetalking_post("/set_audiotype", {"sessionid": request.session_id, "audiotype": PROGRAM_AUDIOTYPE})
            downstream_actions.append("set_program_audiotype")
            await livetalking_post("/record", {"sessionid": request.session_id, "type": "start_record"})
            downstream_actions.append("start_record")
            if synthesis:
                await livetalking_audio(request.session_id, audio)
                downstream_actions.append("play_frozen_program_script")
        elif request.action in ("insert_program", "resume_program"):
            await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
            downstream_actions.append("interrupt_talk")
            await livetalking_post("/set_audiotype", {"sessionid": request.session_id, "audiotype": PROGRAM_AUDIOTYPE})
            downstream_actions.append("set_program_audiotype")
            if synthesis:
                await livetalking_audio(request.session_id, audio)
                downstream_actions.append("play_frozen_program_script")
        else:
            await livetalking_post("/interrupt_talk", {"sessionid": request.session_id})
            downstream_actions.append("interrupt_talk")
            audiotype = FALLBACK_AUDIOTYPE if request.action == "switch_to_fallback" else HUMAN_HANDOFF_AUDIOTYPE
            await livetalking_post("/set_audiotype", {"sessionid": request.session_id, "audiotype": audiotype})
            downstream_actions.append("set_fallback_audiotype" if request.action == "switch_to_fallback" else "set_human_handoff_audiotype")
        accepted_at = datetime.now(timezone.utc).isoformat()
        result = {"accepted": True, "provider": "livetalking", "command_id": request.command_id, "session_id": request.session_id, "action": request.action, "program_segment_id": request.program_segment_id, "downstream_actions": downstream_actions, "receipt": {"command_id": request.command_id, "session_id": request.session_id, "action": request.action, "program_segment_id": request.program_segment_id, "accepted_at": accepted_at, "evidence": "livetalking_api_accepted"}}
        if synthesis:
            log_command_timing(request.command_id, "media", synthesis, reserved_at)
            result["synthesis"] = synthesis_summary(synthesis)
        await cache_runtime_command(request.command_id, "media", identity, result)
        return {**result, "duplicate": False}
    finally:
        await release_runtime_command_lock(request.command_id, lock)
