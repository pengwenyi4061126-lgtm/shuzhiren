import asyncio
import hmac
import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import sys
import time
import unicodedata
from collections import OrderedDict
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from types import MappingProxyType
from typing import Literal, Mapping
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from audio import pcm_s16le_to_wav
from captions import build_caption_cues, caption_form_value, caption_id_for

logger = logging.getLogger(__name__)
# One JSON object per line for uncertain commands and operator resolutions. uvicorn's default logging
# configuration drops INFO records of application loggers, so this logger has its own handler.
audit_logger = logging.getLogger("runtime_gateway.audit")
if not audit_logger.handlers:
    audit_handler = logging.StreamHandler(sys.stderr)
    audit_handler.setFormatter(logging.Formatter("%(message)s"))
    audit_logger.addHandler(audit_handler)
audit_logger.setLevel(logging.INFO)
audit_logger.propagate = False

# Preserve backup-group read access while keeping the durable command journal private.
os.umask(0o027)

LIVE_TALKING_URL = os.environ.get("LIVETALKING_BASE_URL", "http://livetalking:8010").rstrip("/")
COSYVOICE_URL = os.environ.get("COSYVOICE_BASE_URL", "http://cosyvoice:50000").rstrip("/")
COSYVOICE_SAMPLE_RATE = int(os.environ.get("COSYVOICE_SAMPLE_RATE", "24000"))
RUNTIME_TOKEN = os.environ.get("RUNTIME_SHARED_TOKEN", "")
# Read-only credential of runtime-observer (Requirement 31.7-31.12): accepted only by
# endpoints that call authorize(..., allow_read=True). Empty disables the read scope.
RUNTIME_READ_TOKEN = os.environ.get("RUNTIME_GATEWAY_READ_TOKEN", "")
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("RUNTIME_REQUEST_TIMEOUT_SECONDS", "15"))
COSYVOICE_REQUIRED = os.environ.get("COSYVOICE_REQUIRED", "false").lower() == "true"
# sft: /inference_sft with spk_id = runtime voice id. zero_shot: /inference_zero_shot with the
# approved reference audio and transcript from the read-only voice library. No default (D2).
COSYVOICE_MODEL_KIND = os.environ.get("COSYVOICE_MODEL_KIND", "")
COSYVOICE_VOICE_LIBRARY_DIR = os.environ.get("COSYVOICE_VOICE_LIBRARY_DIR", "")
# sft only: JSON object mapping an ASCII runtime_voice_id to the model's built-in speaker name (spk_id). The
# platform default presets (migration 082) use ASCII ids for CosyVoice-300M-SFT's Chinese speaker names. Unset or
# empty uses the default below; a set value replaces it ({} disables the mapping). An id without an entry is sent
# as spk_id unchanged. An invalid value stops startup.
COSYVOICE_SFT_SPEAKER_MAP = os.environ.get("COSYVOICE_SFT_SPEAKER_MAP", "")
DEFAULT_COSYVOICE_SFT_SPEAKER_MAP = {"preset-zh-female": "中文女", "preset-zh-male": "中文男"}
COSYVOICE_SFT_SPEAKER_MAP_MAX_ENTRIES = 256
COSYVOICE_SFT_SPEAKER_MAX_CHARS = 64
COSYVOICE_CHUNK_MAX_CHARS = int(os.environ.get("COSYVOICE_CHUNK_MAX_CHARS", "120"))
# Longest caption line sent to LiveTalking with the speech audio (shuzhiren_caption cues).
CAPTION_LINE_MAX_CHARS = int(os.environ.get("CAPTION_LINE_MAX_CHARS", "18"))
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
    # The Gateway is one process: a command still reserved at startup was executing when the
    # previous process stopped, so its outcome is unknown.
    await asyncio.to_thread(recover_interrupted_commands)
    yield

# The interactive docs and the OpenAPI schema are not registered: every
# Gateway route except /healthz requires the shared runtime token, and
# GET /v1/observations/{session_id} also accepts RUNTIME_GATEWAY_READ_TOKEN.
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
    # The frozen picture-layer scene of the show; only start_program may carry it. Both fields are checked
    # in validate_media_request so every bad value is a 400 before the command id is reserved, not a 422.
    overlay_scene_json: str | None = None
    overlay_scene_sha256: str | None = None

OVERLAY_SCENE_JSON_MAX_CHARS = 8192
OVERLAY_SCENE_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
VOICE_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
VOICE_CHECKSUM_PATTERN = re.compile(r"sha256:[0-9a-fA-F]{64}")
# The Gateway only drives LiveTalking avatar state; speech audio goes through /humanaudio.
# /human would make LiveTalking synthesize the text with its own TTS plugin (edge-tts).
LIVETALKING_POST_PATHS = frozenset({"/interrupt_talk", "/set_audiotype", "/record", "/api/admin/overlay/scene"})
VOICE_PROMPT_WAV_MAX_BYTES = 16 * 1024 * 1024
VOICE_PROMPT_TEXT_MAX_CHARS = 1000
COSYVOICE_MAX_AUDIO_SECONDS = 600

class CommandError(HTTPException):
    """A command or operator response with a fixed detail text and a machine-readable code."""

    def __init__(self, status_code: int, detail: str, code: str, **fields):
        super().__init__(status_code=status_code, detail=detail)
        self.code = code
        self.fields = fields

    def body(self) -> dict:
        return {"detail": self.detail, "code": self.code, **self.fields}

class CommandFailure(CommandError):
    """A command that definitely did not reach LiveTalking. The body names the failing dependency."""

    def __init__(self, status_code: int, detail: str, failure_source: str, failure_reason: str, chunk_index: int | None = None, upstream_status: int | None = None):
        # Voice material is checked before the command id is reserved and is fixed by the deployer,
        # so it is not a recorded definite failure and a retry may succeed.
        super().__init__(status_code, detail, "voice_material_unavailable" if failure_source == "voice_library" else "command_failed_definite")
        self.failure_source = failure_source
        self.failure_reason = failure_reason
        self.chunk_index = chunk_index
        self.upstream_status = upstream_status

    def body(self) -> dict:
        return {
            "detail": self.detail,
            "code": self.code,
            "reason": f"{self.failure_source}_failed",
            "failure_source": self.failure_source,
            "failure_reason": self.failure_reason,
            "chunk_index": self.chunk_index,
            "upstream_status": self.upstream_status,
        }

@app.exception_handler(CommandError)
async def command_error_response(_request: Request, error: CommandError) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content=error.body())

class LiveTalkingFailure(HTTPException):
    """A failed LiveTalking command call. definite means the call cannot have taken effect."""

    def __init__(self, status_code: int, detail: str, reason: str, definite: bool):
        super().__init__(status_code=status_code, detail=detail)
        self.reason = reason
        self.definite = definite

class CommandOutcome(Exception):
    """A classified failure of a reserved command: failed_definite or uncertain."""

    def __init__(self, outcome: Literal["failed_definite", "uncertain"], reason: str, step: str | None, status_code: int, detail: str, original_reason: str | None = None):
        super().__init__(reason)
        self.outcome = outcome
        self.reason = reason
        self.step = step
        self.status_code = status_code
        self.detail = detail
        self.original_reason = original_reason

@dataclass
class CommandExecution:
    command_id: str
    kind: str
    identity_sha256: str
    deadline: float  # time.monotonic() + RUNTIME_COMMAND_DEADLINE_SECONDS, set when the id is reserved
    succeeded_steps: list[str] = field(default_factory=list)
    livetalking_succeeded: bool = False

    def remaining(self) -> float:
        return self.deadline - time.monotonic()

    def classify(self, definite: bool, reason: str, step: str, status_code: int, detail: str) -> CommandOutcome:
        # Once one LiveTalking call of this command succeeded, any later failure leaves the
        # session partly changed, so the outcome is uncertain whatever the failure was.
        if self.livetalking_succeeded:
            return CommandOutcome("uncertain", "partial_execution", step, status_code, detail, original_reason=reason)
        return CommandOutcome("failed_definite" if definite else "uncertain", reason, step, status_code, detail)

    def progress(self, step: str | None, original_reason: str | None = None) -> dict:
        progress: dict = {"succeeded_steps": list(self.succeeded_steps), "failed_step": step}
        if original_reason:
            progress["original_reason"] = original_reason
        return progress

@dataclass(frozen=True)
class VoiceSpec:
    runtime_voice_id: str
    prompt_wav: bytes | None = None
    prompt_text: str | None = None
    # sft only: the spk_id sent to /inference_sft (COSYVOICE_SFT_SPEAKER_MAP applied by load_voice_spec).
    sft_speaker_id: str | None = None

@dataclass(frozen=True)
class SynthesisResult:
    pcm: bytes
    chunks: int
    synth_ms: int
    # The text and the PCM sample count of every synthesized chunk, in order; they time the captions.
    chunk_texts: tuple[str, ...] = ()
    chunk_samples: tuple[int, ...] = ()

PROGRAM_AUDIOTYPE = int(os.environ.get("PROGRAM_AUDIOTYPE", "0"))
FALLBACK_AUDIOTYPE = int(os.environ.get("FALLBACK_AUDIOTYPE", "1"))
HUMAN_HANDOFF_AUDIOTYPE = int(os.environ.get("HUMAN_HANDOFF_AUDIOTYPE", "2"))

TokenScope = Literal["command", "read"]


def bearer_matches(authorization: str | None, token: str) -> bool:
    if not authorization or not token:
        return False
    try:
        # Starlette decodes header bytes as latin-1; encoding back restores the raw bytes.
        presented = authorization.encode("latin-1")
    except UnicodeEncodeError:
        return False
    expected = f"Bearer {token}".encode("utf-8")
    return hmac.compare_digest(hashlib.sha256(presented).digest(), hashlib.sha256(expected).digest())

def authenticate(authorization: str | None) -> TokenScope:
    if not RUNTIME_TOKEN:
        raise HTTPException(status_code=503, detail="Runtime gateway token is not configured")
    # Both comparisons always run, so the time taken does not reveal which token matched.
    is_command = bearer_matches(authorization, RUNTIME_TOKEN)
    is_read = bearer_matches(authorization, RUNTIME_READ_TOKEN)
    if is_command:
        return "command"
    if is_read:
        return "read"
    raise HTTPException(status_code=401, detail="Invalid runtime gateway token")


def authorize(authorization: str | None, *, allow_read: bool = False) -> TokenScope:
    """First statement of every authenticated endpoint: before locks, the journal and upstream calls.

    The shared token (command scope) may use every endpoint; the read-only token only
    endpoints that pass allow_read=True, others answer 403 (default deny).
    """
    scope = authenticate(authorization)
    if scope == "read" and not allow_read:
        raise HTTPException(status_code=403, detail="Read-only runtime gateway token cannot use this endpoint")
    return scope

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

# The request was never sent: LiveTalking cannot have acted on it.
LIVETALKING_UNREACHABLE_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout, httpx.UnsupportedProtocol)

async def livetalking_command_post(path: str, failed_detail: str, rejected_detail: str, **request) -> dict:
    """POST one command call to LiveTalking and classify every failure as definite or uncertain."""
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{LIVE_TALKING_URL}{path}", **request)
    except LIVETALKING_UNREACHABLE_ERRORS as error:
        logger.warning("LiveTalking unreachable for %s: %s", path, type(error).__name__)
        raise LiveTalkingFailure(502, failed_detail, "livetalking_unreachable", True) from error
    except httpx.TimeoutException as error:
        logger.warning("LiveTalking timed out for %s: %s", path, type(error).__name__)
        raise LiveTalkingFailure(504, failed_detail, "livetalking_timeout", False) from error
    except httpx.HTTPError as error:
        logger.warning("LiveTalking connection lost for %s: %s", path, type(error).__name__)
        raise LiveTalkingFailure(502, failed_detail, "livetalking_connection_lost", False) from error
    status = response.status_code
    if not 200 <= status < 300:
        logger.warning("LiveTalking returned status %s for %s", status, path)
        if 400 <= status < 500 and status not in (408, 429):
            raise LiveTalkingFailure(502, failed_detail, "livetalking_client_error", True)
        if status >= 500:
            raise LiveTalkingFailure(502, failed_detail, "livetalking_server_error", False)
        if status in (408, 429):
            raise LiveTalkingFailure(502, failed_detail, "livetalking_retryable_status", False)
        raise LiveTalkingFailure(502, failed_detail, "livetalking_unexpected_status", False)
    try:
        data = parse_upstream_json(response, "LiveTalking")
    except HTTPException as error:
        raise LiveTalkingFailure(502, error.detail, "livetalking_invalid_response", False) from error
    code = data.get("code")
    if type(code) is int and code == 0:
        return data
    if type(code) is int:
        logger.warning("LiveTalking rejected request for %s with code %r", path, code)
        raise LiveTalkingFailure(502, rejected_detail, "livetalking_business_rejected", True)
    logger.warning("LiveTalking answered %s without an integer code", path)
    raise LiveTalkingFailure(502, "LiveTalking returned an invalid response", "livetalking_invalid_response", False)

async def livetalking_post(path: str, payload: dict) -> dict:
    if path not in LIVETALKING_POST_PATHS:
        raise RuntimeError(f"LiveTalking path {path} is not allowed")
    return await livetalking_command_post(path, "LiveTalking request failed", "LiveTalking rejected request", json=payload)

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

def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

# Command_Journal schema version 1 (pragma user_version). States and the only permitted changes:
#   (none) -> reserved
#   reserved -> completed | failed_definite | uncertain
#   uncertain -> completed | failed_definite                 (operator resolution only)
#   completed, failed_definite -> deleted                    (pruning only)
# completed and failed_definite are terminal: a same-id, same-payload retry replays the recorded
# response without calling upstream (Requirement 19.6); a new attempt needs a new command id.
# The triggers refuse every other change, and refuse deleting reserved and uncertain rows.
JOURNAL_SCHEMA_VERSION = 1
JOURNAL_TABLE_DDL = """create table runtime_command_journal (
    command_id text primary key,
    kind text not null check (kind in ('speech', 'media')),
    identity_sha256 text not null check (length(identity_sha256) = 64),
    identity_json text,
    state text not null check (state in ('reserved', 'completed', 'failed_definite', 'uncertain')),
    response_json text,
    http_status integer,
    error_code text,
    failure_reason text,
    progress_json text,
    created_at real not null,
    completed_at real,
    uncertain_at real,
    resolved_from text check (resolved_from is null or resolved_from = 'uncertain'),
    resolved_at real,
    resolution_note text,
    check (state <> 'completed' or (response_json is not null and completed_at is not null and http_status is null)),
    check (state <> 'failed_definite' or (response_json is not null and completed_at is not null
           and http_status between 400 and 599 and error_code = 'command_failed_definite')),
    check (state <> 'uncertain' or (uncertain_at is not null and error_code = 'command_outcome_uncertain'))
)"""
JOURNAL_SCHEMA_STATEMENTS = (
    "create index runtime_command_journal_terminal_idx on runtime_command_journal (state, completed_at)",
    "create index runtime_command_journal_uncertain_idx on runtime_command_journal (created_at, command_id) where state = 'uncertain'",
    """create trigger runtime_command_journal_transition before update of state on runtime_command_journal
    when not ((old.state = 'reserved' and new.state in ('completed', 'failed_definite', 'uncertain'))
           or (old.state = 'uncertain' and new.state in ('completed', 'failed_definite')))
    begin select raise(abort, 'runtime command journal transition is not permitted'); end""",
    """create trigger runtime_command_journal_retain_open before delete on runtime_command_journal
    when old.state in ('reserved', 'uncertain')
    begin select raise(abort, 'reserved and uncertain commands are never pruned'); end""",
)

class JournalSchemaError(sqlite3.DatabaseError):
    """The journal was written by a newer Gateway; this image must not change it."""

class JournalNotFound(Exception):
    pass

class JournalNotUncertain(Exception):
    def __init__(self, state: str):
        super().__init__(state)
        self.state = state

class JournalIdentityUnavailable(Exception):
    pass

def migrate_runtime_command_journal(connection: sqlite3.Connection) -> None:
    """Create schema version 1, or convert the two-state journal of earlier Gateways in one transaction."""
    if connection.execute("pragma user_version").fetchone()[0] == JOURNAL_SCHEMA_VERSION:
        return
    connection.execute("begin immediate")
    try:
        version = connection.execute("pragma user_version").fetchone()[0]
        if version > JOURNAL_SCHEMA_VERSION:
            raise JournalSchemaError(f"runtime command journal schema version {version} is newer than {JOURNAL_SCHEMA_VERSION}")
        if version == JOURNAL_SCHEMA_VERSION:
            connection.execute("rollback")
            return
        legacy = connection.execute("select 1 from sqlite_master where type = 'table' and name = 'runtime_command_journal'").fetchone() is not None
        if legacy:
            connection.execute("alter table runtime_command_journal rename to runtime_command_journal_legacy")
        connection.execute(JOURNAL_TABLE_DDL)
        if legacy:
            completed = "state = 'completed' and response_json is not null and completed_at is not null"
            connection.execute(
                f"""insert into runtime_command_journal (command_id, kind, identity_sha256, state, response_json, created_at, completed_at)
                select command_id, kind, identity_sha256, 'completed', response_json, created_at, completed_at
                from runtime_command_journal_legacy where {completed}"""
            )
            # A reservation left by an earlier Gateway may belong to a command that ran partly, or to an
            # invalid request that never ran; nothing recorded tells them apart. An operator resolves it.
            connection.execute(
                f"""insert into runtime_command_journal (command_id, kind, identity_sha256, state, error_code, failure_reason, progress_json, created_at, uncertain_at)
                select command_id, kind, identity_sha256, 'uncertain', 'command_outcome_uncertain', 'legacy_reserved', ?, created_at, ?
                from runtime_command_journal_legacy where not ({completed})""",
                (canonical_json({"succeeded_steps": [], "failed_step": None}), time.time()),
            )
            connection.execute("drop table runtime_command_journal_legacy")
        for statement in JOURNAL_SCHEMA_STATEMENTS:
            connection.execute(statement)
        connection.execute(f"pragma user_version = {JOURNAL_SCHEMA_VERSION}")
        connection.execute("commit")
    except BaseException:
        if connection.in_transaction:
            connection.execute("rollback")
        raise

def open_runtime_command_journal() -> sqlite3.Connection | None:
    if not RUNTIME_COMMAND_JOURNAL_PATH:
        return None
    path = Path(RUNTIME_COMMAND_JOURNAL_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Autocommit mode: every write below opens its own "begin immediate" transaction.
    connection = sqlite3.connect(path, timeout=JOURNAL_BUSY_TIMEOUT_SECONDS, isolation_level=None)
    try:
        connection.execute("pragma journal_mode = wal")
        connection.execute("pragma synchronous = full")
        migrate_runtime_command_journal(connection)
    except BaseException:
        connection.close()
        raise
    return connection

# Without RUNTIME_COMMAND_JOURNAL_PATH (development and tests only; production requires the journal)
# the same state machine runs in one process-local in-memory database. Journal calls are serialized
# by runtime_command_cache_lock, so the shared connection is never used by two threads at once.
memory_journal_connection: sqlite3.Connection | None = None

def memory_runtime_command_journal() -> sqlite3.Connection:
    global memory_journal_connection
    if memory_journal_connection is None:
        connection = sqlite3.connect(":memory:", check_same_thread=False, isolation_level=None)
        migrate_runtime_command_journal(connection)
        memory_journal_connection = connection
    return memory_journal_connection

@contextmanager
def runtime_command_journal():
    """Yield a journal connection; raise sqlite3.Error or OSError when the journal is unavailable."""
    if not RUNTIME_COMMAND_JOURNAL_PATH:
        if RUNTIME_COMMAND_JOURNAL_REQUIRED:
            raise sqlite3.OperationalError("runtime command journal is not configured")
        yield memory_runtime_command_journal()
        return
    connection = None
    try:
        connection = open_runtime_command_journal()
    except (OSError, sqlite3.Error):
        if RUNTIME_COMMAND_JOURNAL_REQUIRED:
            raise
        logger.warning("Runtime command journal is unavailable; using a non-durable in-memory journal")
    if connection is None:
        yield memory_runtime_command_journal()
        return
    try:
        yield connection
    finally:
        connection.close()

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
    if RUNTIME_READ_TOKEN:
        validate_secret("RUNTIME_GATEWAY_READ_TOKEN", RUNTIME_READ_TOKEN)
        if RUNTIME_READ_TOKEN in (RUNTIME_TOKEN, PREVIEW_BROKER_TOKEN):
            raise RuntimeError("RUNTIME_GATEWAY_READ_TOKEN must differ from every other runtime gateway credential")
    validate_service_url("LIVETALKING_BASE_URL", LIVE_TALKING_URL)
    validate_service_url("COSYVOICE_BASE_URL", COSYVOICE_URL)
    validate_integer_range("COSYVOICE_SAMPLE_RATE", COSYVOICE_SAMPLE_RATE, 8_000, 192_000)
    if COSYVOICE_MODEL_KIND not in ("sft", "zero_shot"):
        raise RuntimeError("COSYVOICE_MODEL_KIND must be sft or zero_shot")
    # The voice library may be missing or broken at startup: commands without speech must still run.
    if COSYVOICE_MODEL_KIND == "zero_shot" and not os.path.isabs(COSYVOICE_VOICE_LIBRARY_DIR):
        raise RuntimeError("COSYVOICE_VOICE_LIBRARY_DIR must be an absolute path when COSYVOICE_MODEL_KIND is zero_shot")
    # Checked in both model kinds, so a broken value cannot wait for a later switch to sft.
    parse_sft_speaker_map(COSYVOICE_SFT_SPEAKER_MAP)
    validate_integer_range("COSYVOICE_CHUNK_MAX_CHARS", COSYVOICE_CHUNK_MAX_CHARS, 20, 800)
    validate_integer_range("CAPTION_LINE_MAX_CHARS", CAPTION_LINE_MAX_CHARS, 8, 40)
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

def prune_runtime_command_journal(connection: sqlite3.Connection, now: float) -> None:
    # Completed and definitely failed commands are counted separately, so a burst of failures never
    # pushes completed commands out. Reserved and uncertain commands are never pruned.
    expiry = now - MEDIA_COMMAND_CACHE_TTL_SECONDS
    for state in ("completed", "failed_definite"):
        connection.execute("delete from runtime_command_journal where state = ? and completed_at < ?", (state, expiry))
        overflow = connection.execute(
            "select command_id from runtime_command_journal where state = ? order by completed_at desc limit -1 offset ?",
            (state, MEDIA_COMMAND_CACHE_MAX_ENTRIES),
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

UNCERTAIN_COMMAND_DETAIL = "Runtime command outcome is uncertain; verify the media session before issuing a new command"
JOURNAL_UNAVAILABLE_DETAIL = "Runtime command journal is unavailable"
COMMAND_ID_CONFLICT_DETAIL = "Runtime command id was already used with a different payload"
JOURNAL_COLUMNS = "command_id, kind, identity_sha256, identity_json, state, response_json, http_status, error_code, failure_reason, progress_json, created_at, uncertain_at, resolved_from"
COMMAND_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")

@dataclass(frozen=True)
class JournalEntry:
    command_id: str
    kind: str
    identity_sha256: str
    identity: dict | None
    state: str
    response: dict | None
    http_status: int | None
    error_code: str | None
    failure_reason: str | None
    progress: dict | None
    created_at: float
    uncertain_at: float | None
    resolved_from: str | None

def optional_json(value: str | None) -> dict | None:
    if value is None:
        return None
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as error:
        raise sqlite3.DatabaseError("runtime command journal row is unreadable") from error
    if not isinstance(decoded, dict):
        raise sqlite3.DatabaseError("runtime command journal row is unreadable")
    return decoded

def journal_entry(row: tuple | None) -> JournalEntry | None:
    if row is None:
        return None
    command_id, kind, identity_sha256, identity_json, state, response_json, http_status, error_code, failure_reason, progress_json, created_at, uncertain_at, resolved_from = row
    return JournalEntry(command_id, kind, identity_sha256, optional_json(identity_json), state, optional_json(response_json), http_status, error_code, failure_reason, optional_json(progress_json), created_at, uncertain_at, resolved_from)

def select_journal_entry(connection: sqlite3.Connection, command_id: str) -> JournalEntry | None:
    return journal_entry(connection.execute(f"select {JOURNAL_COLUMNS} from runtime_command_journal where command_id = ?", (command_id,)).fetchone())

def write_transaction(connection: sqlite3.Connection, operation):
    connection.execute("begin immediate")
    try:
        result = operation()
        connection.execute("commit")
        return result
    except BaseException:
        if connection.in_transaction:
            connection.execute("rollback")
        raise

def require_one_row(cursor: sqlite3.Cursor) -> None:
    if cursor.rowcount != 1:
        raise sqlite3.OperationalError("runtime command journal row changed while it was updated")

def mark_stale_reservation(connection: sqlite3.Connection, command_id: str, reason: str, now: float) -> JournalEntry | None:
    """Turn a reservation without a running execution into an uncertain command (inside a write transaction)."""
    entry = select_journal_entry(connection, command_id)
    if entry is None or entry.state != "reserved":
        return entry
    require_one_row(connection.execute(
        "update runtime_command_journal set state = 'uncertain', error_code = 'command_outcome_uncertain', failure_reason = ?, progress_json = coalesce(progress_json, ?), uncertain_at = ? where command_id = ? and state = 'reserved'",
        (reason, canonical_json({"succeeded_steps": [], "failed_step": None}), now, command_id),
    ))
    log_uncertain_command(command_id, entry.kind, reason, None)
    return select_journal_entry(connection, command_id)

# The journal functions below are synchronous and run in a worker thread through journal_call.
# Each opens, uses, and closes its own connection inside that thread, so SQLite lock waits never
# stall the event loop. The caller holds the command's lock: a reserved row found by a caller
# therefore has no execution in this process any more (its terminal write failed or it was cancelled).
def lookup_journal_entry(command_id: str, now: float) -> JournalEntry | None:
    with runtime_command_journal() as connection:
        entry = select_journal_entry(connection, command_id)
        if entry is not None and entry.state == "reserved":
            entry = write_transaction(connection, lambda: mark_stale_reservation(connection, command_id, "execution_interrupted", now))
        return entry

def reserve_journal_entry(command_id: str, kind: str, identity_sha256: str, identity_json: str, now: float) -> JournalEntry | None:
    """Reserve the id and return None, or return the existing entry that answers this request."""
    def reserve() -> JournalEntry | None:
        entry = select_journal_entry(connection, command_id)
        if entry is None:
            connection.execute(
                "insert into runtime_command_journal (command_id, kind, identity_sha256, identity_json, state, created_at) values (?, ?, ?, ?, 'reserved', ?)",
                (command_id, kind, identity_sha256, identity_json, now),
            )
            return None
        if entry.state == "reserved":
            return mark_stale_reservation(connection, command_id, "execution_interrupted", now)
        # completed, failed_definite, and uncertain entries answer the request; none runs again (19.6).
        return entry

    with runtime_command_journal() as connection:
        return write_transaction(connection, reserve)

def finish_journal_entry(command_id: str, identity_sha256: str, state: str, response: dict | None, http_status: int | None, error_code: str | None, reason: str | None, progress: dict | None, now: float) -> None:
    def finish() -> None:
        require_one_row(connection.execute(
            """update runtime_command_journal set state = ?, response_json = ?, http_status = ?, error_code = ?, failure_reason = ?, progress_json = ?,
            completed_at = ?, uncertain_at = ? where command_id = ? and identity_sha256 = ? and state = 'reserved'""",
            (state, None if response is None else canonical_json(response), http_status, error_code, reason, None if progress is None else canonical_json(progress),
             None if state == "uncertain" else now, now if state == "uncertain" else None, command_id, identity_sha256),
        ))
        if state != "uncertain":
            prune_runtime_command_journal(connection, now)

    with runtime_command_journal() as connection:
        write_transaction(connection, finish)

def recover_interrupted_commands() -> list[str]:
    try:
        with runtime_command_journal() as connection:
            def recover() -> list[str]:
                ids = [row[0] for row in connection.execute("select command_id from runtime_command_journal where state = 'reserved' order by created_at, command_id")]
                now = time.time()
                for command_id in ids:
                    mark_stale_reservation(connection, command_id, "gateway_restarted_during_execution", now)
                return ids
            return write_transaction(connection, recover)
    except (OSError, sqlite3.Error):
        if RUNTIME_COMMAND_JOURNAL_REQUIRED:
            raise
        logger.warning("Runtime command journal is unavailable; interrupted commands were not recovered")
        return []

def list_uncertain_entries() -> list[JournalEntry]:
    with runtime_command_journal() as connection:
        rows = connection.execute(f"select {JOURNAL_COLUMNS} from runtime_command_journal where state = 'uncertain' order by created_at, command_id").fetchall()
        return [journal_entry(row) for row in rows]

def resolved_response(entry: JournalEntry, resolved_at: float) -> dict:
    """The response of a command an operator verified as executed, shaped like a normal completion."""
    identity = entry.identity or {}
    if entry.kind == "media":
        receipt = {"command_id": entry.command_id, "session_id": identity.get("session_id"), "action": identity.get("action"), "program_segment_id": identity.get("program_segment_id"), "accepted_at": iso_timestamp(resolved_at), "evidence": "operator_verified"}
        if identity.get("overlay_scene_sha256"):
            receipt["overlay_scene_sha256"] = identity["overlay_scene_sha256"]
        return {"accepted": True, "provider": "livetalking", "command_id": entry.command_id, "session_id": identity.get("session_id"), "action": identity.get("action"), "program_segment_id": identity.get("program_segment_id"), "downstream_actions": list((entry.progress or {}).get("succeeded_steps", [])), "receipt": receipt}
    return {"accepted": True, "provider": "cosyvoice_to_livetalking", "requested_provider": identity.get("provider"), "mode": "audio", "command_id": entry.command_id, "evidence": "operator_verified"}

def resolve_journal_entry(command_id: str, resolution: str, note: str, now: float) -> JournalEntry:
    """Mark an uncertain command completed or failed_definite; return the entry as it was before."""
    with runtime_command_journal() as connection:
        # Every rejection is decided before a write transaction is opened.
        entry = select_journal_entry(connection, command_id)
        if entry is None:
            raise JournalNotFound(command_id)
        if entry.state != "uncertain":
            raise JournalNotUncertain(entry.state)
        if resolution == "completed" and entry.identity is None:
            raise JournalIdentityUnavailable(command_id)

        def resolve() -> JournalEntry:
            current = select_journal_entry(connection, command_id)
            if current is None or current.state != "uncertain":
                raise JournalNotUncertain(current.state if current else "missing")
            if resolution == "completed":
                cursor = connection.execute(
                    """update runtime_command_journal set state = 'completed', response_json = ?, http_status = null, error_code = null,
                    completed_at = ?, resolved_from = 'uncertain', resolved_at = ?, resolution_note = ? where command_id = ? and state = 'uncertain'""",
                    (canonical_json(resolved_response(current, now)), now, now, note, command_id),
                )
            else:
                body = {"detail": "Runtime command was resolved by an operator as not executed", "code": "command_failed_definite", "reason": "operator_resolved_failed"}
                progress = {**(current.progress or {}), "uncertain_reason": current.failure_reason}
                cursor = connection.execute(
                    """update runtime_command_journal set state = 'failed_definite', response_json = ?, http_status = 502, error_code = 'command_failed_definite',
                    failure_reason = 'operator_resolved_failed', progress_json = ?, completed_at = ?, resolved_from = 'uncertain', resolved_at = ?, resolution_note = ?
                    where command_id = ? and state = 'uncertain'""",
                    (canonical_json(body), canonical_json(progress), now, now, note, command_id),
                )
            require_one_row(cursor)
            prune_runtime_command_journal(connection, now)
            return current

        return write_transaction(connection, resolve)

async def journal_call(function, *args):
    """Run a journal function in a worker thread; journal errors become 503 command_journal_unavailable."""
    async with runtime_command_cache_lock:
        try:
            return await asyncio.to_thread(function, *args)
        except (OSError, sqlite3.Error) as error:
            logger.warning("Runtime command journal call %s failed: %s", function.__name__, type(error).__name__)
            raise CommandError(503, JOURNAL_UNAVAILABLE_DETAIL, "command_journal_unavailable") from error

def iso_timestamp(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def log_uncertain_command(command_id: str, kind: str, reason: str, failed_step: str | None) -> None:
    audit_logger.info(canonical_json({"event": "runtime_command.uncertain", "command_id": command_id, "kind": kind, "reason": reason, "failed_step": failed_step, "at": iso_timestamp(time.time())}))

def replay_journal_entry(entry: JournalEntry, kind: str, identity_sha256: str) -> dict:
    """Answer a request for an id the journal already holds: the completed response, or an error.

    A definite failure replays its recorded failure response without calling upstream (19.6),
    whether the Gateway classified it or an operator resolved an uncertain command."""
    if entry.kind != kind or entry.identity_sha256 != identity_sha256:
        raise CommandError(409, COMMAND_ID_CONFLICT_DETAIL, "command_id_conflict")
    if entry.state == "completed" and entry.response is not None:
        return entry.response
    if entry.state == "failed_definite":
        body = dict(entry.response or {})
        detail = body.pop("detail", "Runtime command failed")
        code = body.pop("code", "command_failed_definite")
        raise CommandError(entry.http_status or 502, detail, code, **{**body, "duplicate": True})
    raise CommandError(409, UNCERTAIN_COMMAND_DETAIL, "command_outcome_uncertain", reason=entry.failure_reason, duplicate=True)

def remember_completed_command(command_id: str, kind: str, identity_sha256: str, response: dict) -> None:
    now = time.monotonic()
    runtime_command_cache[command_id] = {"kind": kind, "identity_sha256": identity_sha256, "response": response, "completed_at": now}
    prune_runtime_command_cache(now)

def answer_from_journal(entry: JournalEntry | None, command_id: str, kind: str, identity_sha256: str) -> dict | None:
    if entry is None:
        return None
    response = replay_journal_entry(entry, kind, identity_sha256)
    remember_completed_command(command_id, kind, identity_sha256, response)
    return {**response, "duplicate": True}

async def cached_runtime_command(command_id: str, kind: str, identity: dict) -> dict | None:
    """Answer a known command id from the cache or the journal; None when the command may run."""
    identity_sha256 = command_identity_hash(identity)
    async with runtime_command_cache_lock:
        prune_runtime_command_cache(time.monotonic())
        cached = runtime_command_cache.get(command_id)
    if cached:
        if cached["kind"] != kind or cached["identity_sha256"] != identity_sha256:
            raise CommandError(409, COMMAND_ID_CONFLICT_DETAIL, "command_id_conflict")
        return {**cached["response"], "duplicate": True}
    entry = await journal_call(lookup_journal_entry, command_id, time.time())
    return answer_from_journal(entry, command_id, kind, identity_sha256)

async def reserve_runtime_command(command_id: str, kind: str, identity: dict) -> dict | None:
    """Reserve a command id (None), or return the stored result of a completed command with the same payload."""
    identity_sha256 = command_identity_hash(identity)
    entry = await journal_call(reserve_journal_entry, command_id, kind, identity_sha256, canonical_json(identity), time.time())
    return answer_from_journal(entry, command_id, kind, identity_sha256)

def new_command_execution(command_id: str, kind: str, identity: dict) -> CommandExecution:
    return CommandExecution(command_id, kind, command_identity_hash(identity), time.monotonic() + RUNTIME_COMMAND_DEADLINE_SECONDS)

async def finish_command(execution: CommandExecution, state: str, *, response: dict | None = None, http_status: int | None = None, error_code: str | None = None, reason: str | None = None, progress: dict | None = None) -> None:
    try:
        await journal_call(finish_journal_entry, execution.command_id, execution.identity_sha256, state, response, http_status, error_code, reason, progress, time.time())
    except CommandError as error:
        # The row stays reserved; the next request for this id, or the next start, marks it uncertain.
        raise CommandError(503, UNCERTAIN_COMMAND_DETAIL, "command_outcome_uncertain", reason="journal_finalize_failed") from error

async def run_reserved_command(execution: CommandExecution, operation) -> dict:
    """Execute a reserved command and record completed, failed_definite, or uncertain."""
    try:
        result = await operation()
    except CommandFailure as failure:
        # CosyVoice synthesis finishes before the first LiveTalking call (D2).
        if execution.livetalking_succeeded:
            outcome = CommandOutcome("uncertain", "partial_execution", "synthesis", failure.status_code, failure.detail, original_reason=failure.body()["reason"])
            return await record_command_outcome(execution, outcome)
        body = failure.body()
        await finish_command(execution, "failed_definite", response=body, http_status=failure.status_code, error_code="command_failed_definite", reason=body["reason"], progress=execution.progress("synthesis", body["failure_reason"]))
        raise
    except CommandOutcome as outcome:
        return await record_command_outcome(execution, outcome)
    except Exception as error:
        logger.warning("Runtime command %s failed unexpectedly: %s", execution.command_id, type(error).__name__)
        return await record_command_outcome(execution, CommandOutcome("uncertain", "gateway_internal_error", None, 502, "Runtime command failed"))
    await finish_command(execution, "completed", response=result)
    async with runtime_command_cache_lock:
        remember_completed_command(execution.command_id, execution.kind, execution.identity_sha256, result)
    return {**result, "duplicate": False}

async def record_command_outcome(execution: CommandExecution, outcome: CommandOutcome):
    progress = execution.progress(outcome.step, outcome.original_reason)
    if outcome.outcome == "failed_definite":
        body = {"detail": outcome.detail, "code": "command_failed_definite", "reason": outcome.reason, "failed_step": outcome.step}
        await finish_command(execution, "failed_definite", response=body, http_status=outcome.status_code, error_code="command_failed_definite", reason=outcome.reason, progress=progress)
        raise CommandError(outcome.status_code, outcome.detail, "command_failed_definite", reason=outcome.reason, failed_step=outcome.step)
    await finish_command(execution, "uncertain", error_code="command_outcome_uncertain", reason=outcome.reason, progress=progress)
    log_uncertain_command(execution.command_id, execution.kind, outcome.reason, outcome.step)
    raise CommandError(outcome.status_code, outcome.detail, "command_outcome_uncertain", reason=outcome.reason, failed_step=outcome.step)

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

def reject_duplicate_sft_speakers(pairs: list[tuple[str, object]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError("COSYVOICE_SFT_SPEAKER_MAP must not repeat a runtime voice id")
        result[key] = value
    return result

def valid_sft_speaker_name(value: object) -> bool:
    # A built-in speaker name such as 中文女: no surrounding whitespace and no control, format, private-use,
    # surrogate or unassigned characters, so it is sent to CosyVoice exactly as configured.
    return (
        isinstance(value, str)
        and 1 <= len(value) <= COSYVOICE_SFT_SPEAKER_MAX_CHARS
        and value == value.strip()
        and not any(unicodedata.category(character).startswith("C") for character in value)
    )

@lru_cache(maxsize=8)
def parse_sft_speaker_map(raw: str) -> Mapping[str, str]:
    """COSYVOICE_SFT_SPEAKER_MAP as a read-only mapping; raises RuntimeError for any invalid value."""
    if raw == "":
        return MappingProxyType(dict(DEFAULT_COSYVOICE_SFT_SPEAKER_MAP))
    try:
        parsed = json.loads(raw, object_pairs_hook=reject_duplicate_sft_speakers)
    except ValueError as error:
        raise RuntimeError("COSYVOICE_SFT_SPEAKER_MAP must be a JSON object") from error
    if not isinstance(parsed, dict):
        raise RuntimeError("COSYVOICE_SFT_SPEAKER_MAP must be a JSON object")
    if len(parsed) > COSYVOICE_SFT_SPEAKER_MAP_MAX_ENTRIES:
        raise RuntimeError(f"COSYVOICE_SFT_SPEAKER_MAP must have at most {COSYVOICE_SFT_SPEAKER_MAP_MAX_ENTRIES} entries")
    for key, value in parsed.items():
        if not VOICE_ID_PATTERN.fullmatch(key):
            raise RuntimeError("COSYVOICE_SFT_SPEAKER_MAP keys must be runtime voice ids ([A-Za-z0-9][A-Za-z0-9_-]{0,127})")
        if not valid_sft_speaker_name(value):
            raise RuntimeError(f"COSYVOICE_SFT_SPEAKER_MAP values must be speaker names of 1-{COSYVOICE_SFT_SPEAKER_MAX_CHARS} printable characters without surrounding whitespace")
    return MappingProxyType(parsed)

def sft_speaker_id(runtime_voice_id: str) -> str:
    """The spk_id for an approved runtime voice id in sft mode; an id without a map entry is used as is."""
    try:
        speakers = parse_sft_speaker_map(COSYVOICE_SFT_SPEAKER_MAP)
    except RuntimeError as error:
        # Startup rejects an invalid map; this only fails closed if the value changed after startup.
        raise voice_material_failure("sft_speaker_map_invalid") from error
    return speakers.get(runtime_voice_id, runtime_voice_id)

def load_voice_spec(runtime_voice_id: str, voice_checksum: str | None) -> VoiceSpec:
    """Read the approved zero-shot reference audio and transcript; synchronous, run in a thread."""
    if COSYVOICE_MODEL_KIND == "sft":
        return VoiceSpec(runtime_voice_id, sft_speaker_id=sft_speaker_id(runtime_voice_id))
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
        path, data, files = "/inference_sft", {"tts_text": text, "spk_id": voice.sft_speaker_id or sft_speaker_id(voice.runtime_voice_id)}, None
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
    chunk_samples: list[int] = []
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
        chunk_samples.append(len(audio) // 2)
        logger.info("cosyvoice_chunk index=%d bytes=%d ms=%d", index, len(audio), int((time.monotonic() - chunk_started) * 1000))
    return SynthesisResult(bytes(pcm), len(chunks), int((time.monotonic() - started) * 1000), tuple(chunks), tuple(chunk_samples))

def command_caption(command_id: str, synthesis: SynthesisResult) -> str | None:
    """The shuzhiren_caption form value for a synthesized command, or None. A caption problem never stops the audio."""
    if not synthesis.chunk_texts:
        return None
    try:
        cues = build_caption_cues(list(synthesis.chunk_texts), list(synthesis.chunk_samples), COSYVOICE_SAMPLE_RATE, CAPTION_LINE_MAX_CHARS)
        return caption_form_value(caption_id_for(command_id), cues)
    except Exception as error:
        logger.warning("Caption cues could not be built for command %s: %s", command_id, type(error).__name__)
        return None

async def livetalking_audio(session_id: str, audio: bytes, caption: str | None = None) -> None:
    data = {"sessionid": session_id}
    if caption:
        # Unpatched LiveTalking ignores this field (it reads only sessionid and file).
        data["shuzhiren_caption"] = caption
    await livetalking_command_post("/humanaudio", "LiveTalking audio request failed", "LiveTalking rejected audio request", data=data, files={"file": ("speech.wav", audio, "audio/wav")})

async def play_audio(session_id: str, audio: bytes, caption: str | None) -> None:
    # Without a caption the call keeps its two-argument form.
    await (livetalking_audio(session_id, audio, caption) if caption else livetalking_audio(session_id, audio))

async def set_overlay_scene(session_id: str, scene_json: str, scene_sha256: str) -> None:
    """Install the frozen scene; LiveTalking must echo the same hash or the command fails definitely."""
    data = await livetalking_post("/api/admin/overlay/scene", {"sessionid": session_id, "scene_json": scene_json, "scene_sha256": scene_sha256})
    payload = data.get("data")
    echoed = payload.get("scene_sha256") if isinstance(payload, dict) else None
    if not isinstance(echoed, str) or not hmac.compare_digest(echoed, scene_sha256):
        logger.warning("LiveTalking echoed a different overlay scene hash for session %s", session_id)
        raise LiveTalkingFailure(502, "LiveTalking overlay scene hash does not match", "overlay_scene_hash_mismatch", True)

async def livetalking_step(execution: CommandExecution, step: str, call) -> None:
    """Run one LiveTalking call of a reserved command within the command's total deadline."""
    remaining = execution.remaining()
    if remaining < 0.05:
        raise execution.classify(True, "deadline_exhausted_before_send", step, 504, "Runtime command deadline was exhausted")
    try:
        await asyncio.wait_for(call(), timeout=remaining)
    except asyncio.TimeoutError as error:
        logger.warning("LiveTalking call %s exceeded the command deadline", step)
        outcome = CommandOutcome("uncertain", "deadline_exhausted_in_flight", step, 504, "LiveTalking request exceeded the command deadline")
        if execution.livetalking_succeeded:
            outcome = CommandOutcome("uncertain", "partial_execution", step, 504, outcome.detail, original_reason=outcome.reason)
        raise outcome from error
    except LiveTalkingFailure as failure:
        raise execution.classify(failure.definite, failure.reason, step, failure.status_code, failure.detail) from failure
    except Exception as error:
        logger.warning("LiveTalking call %s failed unexpectedly: %s", step, type(error).__name__)
        raise execution.classify(False, "gateway_internal_error", step, 502, "LiveTalking request failed") from error
    execution.succeeded_steps.append(step)
    execution.livetalking_succeeded = True

async def livetalking_aigc_label() -> dict:
    """Health passthrough of LiveTalking's AIGC explicit label; anything but an explicit enabled true reads as disabled."""
    try:
        data = await livetalking_get("/api/admin/aigc-label")
    except HTTPException:
        return {"enabled": False, "reported": False, "text": None, "position": None, "frames_labelled": None, "last_error": "livetalking_unavailable"}
    label = data.get("data") if isinstance(data.get("data"), dict) else {}
    text, position, frames, error = label.get("text"), label.get("position"), label.get("frames_labelled"), label.get("last_error")
    return {"enabled": label.get("enabled") is True, "reported": True, "text": text if isinstance(text, str) else None, "position": position if isinstance(position, str) else None, "frames_labelled": frames if type(frames) is int else None, "last_error": error if isinstance(error, str) else None}

async def livetalking_overlay() -> dict:
    """Health passthrough of LiveTalking's picture layer state; a failed or unpatched read reports supported false."""
    unsupported = {"supported": False, "aigc_position": None, "active_sessions": None, "frames_composed": None, "frames_overlay_failed": None, "last_error": "livetalking_unavailable"}
    try:
        data = await livetalking_get("/api/admin/overlay")
    except HTTPException:
        return unsupported
    overlay = data.get("data") if isinstance(data.get("data"), dict) else {}
    if overlay.get("supported") is not True:
        return unsupported
    position, error = overlay.get("aigc_position"), overlay.get("last_error")
    counts = {key: overlay.get(key) if type(overlay.get(key)) is int else None for key in ("active_sessions", "frames_composed", "frames_overlay_failed")}
    return {"supported": True, "aigc_position": position if isinstance(position, str) else None, **counts, "last_error": error if isinstance(error, str) else None}

@app.get("/healthz")
async def healthz() -> JSONResponse:
    livetalking, cosyvoice, aigc_label, overlay = await asyncio.gather(
        service_health(LIVE_TALKING_URL, "/api/admin/sessions", expected_code=0),
        service_health(COSYVOICE_URL, "/openapi.json"),
        livetalking_aigc_label(),
        livetalking_overlay(),
    )
    command_journal = await asyncio.to_thread(command_journal_status)
    status = "ok" if livetalking["available"] and (not COSYVOICE_REQUIRED or cosyvoice["available"]) and (not RUNTIME_COMMAND_JOURNAL_REQUIRED or command_journal["available"]) else "degraded"
    return JSONResponse(
        status_code=200 if status == "ok" else 503,
        content={
            "status": status,
            "dependencies": {
                "livetalking": {**livetalking, "aigc_label": aigc_label, "overlay": overlay},
                "cosyvoice": {**cosyvoice, "required": COSYVOICE_REQUIRED, "model_kind": COSYVOICE_MODEL_KIND},
                "command_journal": command_journal,
            },
            "media_actions": ["start_program", "switch_to_fallback", "switch_to_human", "stop_program", "insert_program", "resume_program"],
        },
    )

@app.get("/v1/observations/{session_id}")
async def observation(session_id: str, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization, allow_read=True)
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

def validate_overlay_scene(request: MediaRequest) -> None:
    scene_json, scene_sha256 = request.overlay_scene_json, request.overlay_scene_sha256
    if scene_json is None and scene_sha256 is None:
        return
    if request.action != "start_program":
        raise HTTPException(status_code=400, detail="Only program start may carry an overlay scene")
    if scene_json is None or scene_sha256 is None:
        raise HTTPException(status_code=400, detail="Overlay scene and hash must be supplied together")
    if len(scene_json) > OVERLAY_SCENE_JSON_MAX_CHARS:
        raise HTTPException(status_code=400, detail="Overlay scene is too long")
    if not OVERLAY_SCENE_SHA256_PATTERN.fullmatch(scene_sha256):
        raise HTTPException(status_code=400, detail="Overlay scene hash is invalid")
    try:
        digest = hashlib.sha256(scene_json.encode("utf-8")).hexdigest()
    except UnicodeEncodeError:
        raise HTTPException(status_code=400, detail="Overlay scene is not valid text") from None
    if not hmac.compare_digest(digest, scene_sha256):
        raise HTTPException(status_code=400, detail="Overlay scene hash does not match scene")
    try:
        scene = json.loads(scene_json)
    except (ValueError, RecursionError):
        raise HTTPException(status_code=400, detail="Overlay scene is not valid JSON") from None
    if not isinstance(scene, dict) or type(scene.get("version")) is not int or scene["version"] != 1:
        raise HTTPException(status_code=400, detail="Overlay scene must be a version 1 object")

def validate_media_request(request: MediaRequest) -> None:
    validate_overlay_scene(request)
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

async def synthesize_reserved_command(text: str, voice: VoiceSpec, deadline: float) -> tuple[SynthesisResult, bytes]:
    """Synthesize a reserved command's speech as one WAV before any LiveTalking call."""
    try:
        synthesis = await cosyvoice_synthesize(text, voice, synthesis_deadline(deadline))
        return synthesis, pcm_s16le_to_wav(synthesis.pcm, COSYVOICE_SAMPLE_RATE)
    except CommandFailure:
        raise
    except Exception as error:
        # Nothing reached LiveTalking yet: any synthesis problem is a definite failure.
        logger.warning("CosyVoice audio could not be prepared: %s", type(error).__name__)
        raise cosyvoice_failure(502, "CosyVoice returned unusable audio", "cosyvoice_audio_unusable", 0) from error

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
        execution = new_command_execution(request.command_id, "speech", identity)
        reserved_at = time.monotonic()

        async def execute() -> dict:
            synthesis, audio = await synthesize_reserved_command(request.text, voice, execution.deadline)
            caption = command_caption(request.command_id, synthesis)
            if request.interrupt:
                await livetalking_step(execution, "interrupt_talk", lambda: livetalking_post("/interrupt_talk", {"sessionid": request.session_id}))
            await livetalking_step(execution, "play_speech_audio", lambda: play_audio(request.session_id, audio, caption))
            log_command_timing(request.command_id, "speech", synthesis, reserved_at)
            return {"accepted": True, "provider": "cosyvoice_to_livetalking", "requested_provider": request.provider, "mode": "audio", "command_id": request.command_id, "synthesis": synthesis_summary(synthesis)}

        return await run_reserved_command(execution, execute)
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
    if request.overlay_scene_sha256 is not None:
        # Added only when present, so the identity of a command without a scene is unchanged.
        identity["overlay_scene_sha256"] = request.overlay_scene_sha256
    lock = await acquire_runtime_command_lock(request.command_id)
    try:
        cached = await cached_runtime_command(request.command_id, "media", identity)
        if cached:
            return cached
        voice = await asyncio.to_thread(load_voice_spec, request.runtime_voice_id, request.voice_checksum) if request.program_script else None
        replay = await reserve_runtime_command(request.command_id, "media", identity)
        if replay:
            return replay
        execution = new_command_execution(request.command_id, "media", identity)
        reserved_at = time.monotonic()
        session = {"sessionid": request.session_id}

        async def step(name: str, path: str, payload: dict) -> None:
            await livetalking_step(execution, name, lambda: livetalking_post(path, payload))

        async def execute() -> dict:
            synthesis: SynthesisResult | None = None
            audio = b""
            caption: str | None = None
            if request.program_script and voice is not None:
                synthesis, audio = await synthesize_reserved_command(request.program_script, voice, execution.deadline)
                caption = command_caption(request.command_id, synthesis)

            async def play_program() -> None:
                await livetalking_step(execution, "play_frozen_program_script", lambda: play_audio(request.session_id, audio, caption))

            if request.action == "stop_program":
                await step("interrupt_talk", "/interrupt_talk", session)
                await step("end_record", "/record", {**session, "type": "end_record"})
            elif request.action == "start_program":
                if request.overlay_scene_json is not None and request.overlay_scene_sha256 is not None:
                    # First step: a refused or mismatched scene is a definite failure that changed nothing.
                    await livetalking_step(execution, "set_overlay_scene", lambda: set_overlay_scene(request.session_id, request.overlay_scene_json, request.overlay_scene_sha256))
                if synthesis:
                    # Interrupt before /set_audiotype: LiveTalking's flush resets the audiotype to 0.
                    await step("interrupt_talk", "/interrupt_talk", session)
                await step("set_program_audiotype", "/set_audiotype", {**session, "audiotype": PROGRAM_AUDIOTYPE})
                await step("start_record", "/record", {**session, "type": "start_record"})
                if synthesis:
                    await play_program()
            elif request.action in ("insert_program", "resume_program"):
                await step("interrupt_talk", "/interrupt_talk", session)
                await step("set_program_audiotype", "/set_audiotype", {**session, "audiotype": PROGRAM_AUDIOTYPE})
                if synthesis:
                    await play_program()
            else:
                await step("interrupt_talk", "/interrupt_talk", session)
                audiotype = FALLBACK_AUDIOTYPE if request.action == "switch_to_fallback" else HUMAN_HANDOFF_AUDIOTYPE
                await step("set_fallback_audiotype" if request.action == "switch_to_fallback" else "set_human_handoff_audiotype", "/set_audiotype", {**session, "audiotype": audiotype})
            accepted_at = datetime.now(timezone.utc).isoformat()
            result = {"accepted": True, "provider": "livetalking", "command_id": request.command_id, "session_id": request.session_id, "action": request.action, "program_segment_id": request.program_segment_id, "downstream_actions": list(execution.succeeded_steps), "receipt": {"command_id": request.command_id, "session_id": request.session_id, "action": request.action, "program_segment_id": request.program_segment_id, "accepted_at": accepted_at, "evidence": "livetalking_api_accepted"}}
            if request.overlay_scene_sha256 is not None:
                result["receipt"]["overlay_scene_sha256"] = request.overlay_scene_sha256
            if synthesis:
                log_command_timing(request.command_id, "media", synthesis, reserved_at)
                result["synthesis"] = synthesis_summary(synthesis)
            return result

        return await run_reserved_command(execution, execute)
    finally:
        await release_runtime_command_lock(request.command_id, lock)

RESOLUTION_STATES = ("completed", "failed_definite")
RESOLUTION_NOTE_MAX_CHARS = 500
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")

def log_resolution_rejected(command_id: str, reason: str) -> None:
    logged_id = command_id if COMMAND_ID_PATTERN.fullmatch(command_id) else hashlib.sha256(command_id.encode("utf-8", "replace")).hexdigest()[:16]
    audit_logger.info(canonical_json({"event": "runtime_command.resolution_rejected", "command_id": logged_id, "reason": reason, "at": iso_timestamp(time.time())}))

def uncertain_command_view(entry: JournalEntry) -> dict:
    identity = entry.identity or {}
    progress = entry.progress or {}
    # Speech text is not returned: the list is for checking the media session, not for reading scripts.
    return {
        "command_id": entry.command_id,
        "kind": entry.kind,
        "reserved_at": iso_timestamp(entry.created_at),
        "uncertain_at": iso_timestamp(entry.uncertain_at),
        "reason": entry.failure_reason,
        "session_id": identity.get("session_id"),
        "action": identity.get("action") if entry.kind == "media" else None,
        "program_segment_id": identity.get("program_segment_id") if entry.kind == "media" else None,
        "succeeded_steps": list(progress.get("succeeded_steps", [])),
        "failed_step": progress.get("failed_step"),
        "identity_available": entry.identity is not None,
    }

@app.get("/v1/ops/uncertain-commands")
async def uncertain_commands(authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    entries = await journal_call(list_uncertain_entries)
    return {"count": len(entries), "commands": [uncertain_command_view(entry) for entry in entries]}

@app.post("/v1/ops/uncertain-commands/{command_id}/resolution")
async def resolve_uncertain_command(command_id: str, request: Request, authorization: str | None = Header(default=None)) -> dict:
    # Authenticate before the body is read, so every rejected attempt is logged.
    try:
        authorize(authorization)
    except HTTPException:
        log_resolution_rejected(command_id, "unauthorized")
        raise
    if not COMMAND_ID_PATTERN.fullmatch(command_id):
        log_resolution_rejected(command_id, "not_found")
        raise CommandError(404, "Runtime command was not found", "command_not_found")
    try:
        body = await request.json()
    except ValueError:
        body = None
    resolution = body.get("resolution") if isinstance(body, dict) else None
    note = body.get("note") if isinstance(body, dict) else None
    if resolution not in RESOLUTION_STATES or not isinstance(note, str) or not note.strip() or len(note) > RESOLUTION_NOTE_MAX_CHARS:
        log_resolution_rejected(command_id, "invalid_request")
        raise CommandError(422, "Resolution must be completed or failed_definite with a note of 1 to 500 characters", "request_invalid")
    lock = await acquire_runtime_command_lock(command_id)
    try:
        resolved_at = time.time()
        try:
            previous = await journal_call(resolve_journal_entry, command_id, resolution, note, resolved_at)
        except JournalNotFound:
            log_resolution_rejected(command_id, "not_found")
            raise CommandError(404, "Runtime command was not found", "command_not_found") from None
        except JournalNotUncertain as error:
            log_resolution_rejected(command_id, "not_uncertain")
            raise CommandError(409, "Runtime command outcome is not uncertain", "command_not_uncertain", current_state=error.state) from None
        except JournalIdentityUnavailable:
            log_resolution_rejected(command_id, "identity_unavailable")
            raise CommandError(409, "Runtime command identity is unavailable; it can only be resolved as failed_definite", "command_identity_unavailable") from None
    finally:
        await release_runtime_command_lock(command_id, lock)
    audit_logger.info(canonical_json({"event": "runtime_command.resolved", "command_id": command_id, "kind": previous.kind, "from_state": previous.state, "to_state": resolution, "uncertain_reason": previous.failure_reason, "resolved_at": iso_timestamp(resolved_at), "note": CONTROL_CHARACTERS.sub(" ", note)}))
    return {"command_id": command_id, "previous_state": previous.state, "state": resolution, "resolved_at": iso_timestamp(resolved_at)}
