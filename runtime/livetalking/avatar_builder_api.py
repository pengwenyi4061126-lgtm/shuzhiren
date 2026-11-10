import asyncio
import hashlib
import hmac
import json
import os
import shutil
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import psycopg2
from aiohttp import web
from avatars.musetalk.genavatar import generate_avatar

TOKEN = os.environ.get("AVATAR_BUILDER_TOKEN", "")
PORT = int(os.environ.get("AVATAR_BUILDER_PORT", "8020"))
CANDIDATE_ROOT = Path(os.environ.get("AVATAR_BUILDER_CANDIDATE_ROOT", "/var/lib/shuzhiren-avatar-candidates")).resolve()
LOCK_DATABASE_URL = os.environ.get("AVATAR_BUILDER_LOCK_DATABASE_URL", "")
GPU_LOCK_KEY = 7421900641201
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_DURATION_SECONDS = 180
ALLOWED_EXTENSIONS = {".mp4", ".webm", ".mov"}
TASKS = {}
TASK_BY_CANDIDATE = {}
TASKS_LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="avatar-builder")


def authorized(request):
    header = request.headers.get("Authorization", "")
    supplied = header[7:] if header.startswith("Bearer ") else ""
    return bool(TOKEN) and hmac.compare_digest(supplied.encode(), TOKEN.encode())


def require_auth(request):
    if not authorized(request):
        raise web.HTTPUnauthorized(headers={"Cache-Control": "no-store"})


def build_status(task):
    return {key: task[key] for key in ("taskId", "candidateId", "status", "progress", "errorCode") if key in task}


async def health(_request):
    return web.json_response({"ok": True}, headers={"Cache-Control": "no-store"})


async def create_build(request):
    require_auth(request)
    reader = await request.multipart()
    tenant_id = None
    candidate_id = None
    source_checksum = None
    video_path = None
    video_name = None
    total_bytes = 0
    try:
        async for part in reader:
            if part.name == "tenant_id":
                tenant_id = (await part.text()).strip()
            elif part.name == "candidate_id":
                candidate_id = (await part.text()).strip()
            elif part.name == "source_checksum":
                source_checksum = (await part.text()).strip()
            elif part.name == "video_file":
                suffix = Path(part.filename or "").suffix.lower()
                if suffix not in ALLOWED_EXTENSIONS:
                    raise web.HTTPUnsupportedMediaType(text="unsupported_video_type")
                handle, name = tempfile.mkstemp(prefix="avatar-source-", suffix=suffix)
                os.close(handle)
                video_path = Path(name)
                video_name = Path(part.filename or "source").name
                with video_path.open("wb") as output:
                    while chunk := await part.read_chunk(size=1024 * 1024):
                        total_bytes += len(chunk)
                        if total_bytes > MAX_UPLOAD_BYTES:
                            raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD_BYTES, actual_size=total_bytes)
                        output.write(chunk)
            else:
                raise web.HTTPBadRequest(text="unexpected_upload_field")
        if (not tenant_id or str(uuid.UUID(tenant_id)) != tenant_id or not candidate_id or str(uuid.UUID(candidate_id)) != candidate_id
                or not source_checksum or len(source_checksum) != 71 or not source_checksum.startswith("sha256:")
                or any(character not in "0123456789abcdef" for character in source_checksum[7:]) or not video_path or total_bytes < 1):
            raise web.HTTPBadRequest(text="invalid_build_input")
        if hashlib.sha256(video_path.read_bytes()).hexdigest() != source_checksum[7:]:
            raise web.HTTPBadRequest(text="source_checksum_mismatch")
        metadata = inspect_video(video_path)
        tenant_root = CANDIDATE_ROOT / tenant_id
        candidate_path = tenant_root / candidate_id
        tenant_root.mkdir(parents=True, exist_ok=True)
        with TASKS_LOCK:
            existing_task_id = TASK_BY_CANDIDATE.get((tenant_id, candidate_id))
            existing_task = TASKS.get(existing_task_id) if existing_task_id else None
            if existing_task and existing_task.get("sourceChecksum") == source_checksum:
                if existing_task.get("status") != "failed":
                    video_path.unlink(missing_ok=True)
                    return web.json_response({"data": build_status(existing_task)}, status=202, headers={"Cache-Control": "no-store"})
                TASK_BY_CANDIDATE.pop((tenant_id, candidate_id), None)
            if existing_task:
                if existing_task.get("status") != "failed" or existing_task.get("sourceChecksum") != source_checksum:
                    raise web.HTTPConflict(text="candidate_source_mismatch")
            if candidate_path.exists():
                if not candidate_path.is_dir() or candidate_path.is_symlink() or not verify_candidate(candidate_path, tenant_id, candidate_id, source_checksum):
                    raise web.HTTPConflict(text="candidate_integrity_conflict")
                task_id = str(uuid.uuid4())
                task = {"taskId": task_id, "tenantId": tenant_id, "candidateId": candidate_id, "sourceChecksum": source_checksum, "status": "completed", "progress": 100}
                TASKS[task_id] = task
                TASK_BY_CANDIDATE[(tenant_id, candidate_id)] = task_id
                video_path.unlink(missing_ok=True)
                return web.json_response({"data": build_status(task)}, status=202, headers={"Cache-Control": "no-store"})
            task_id = str(uuid.uuid4())
            task = {"taskId": task_id, "tenantId": tenant_id, "candidateId": candidate_id, "sourceChecksum": source_checksum, "status": "queued", "progress": 0}
            TASKS[task_id] = task
            TASK_BY_CANDIDATE[(tenant_id, candidate_id)] = task_id
        loop = asyncio.get_running_loop()
        loop.run_in_executor(EXECUTOR, run_build, task_id, tenant_id, candidate_id, source_checksum, video_path, video_name, metadata)
        return web.json_response({"data": build_status(task)}, status=202, headers={"Cache-Control": "no-store"})
    except web.HTTPException:
        if video_path:
            video_path.unlink(missing_ok=True)
        raise
    except Exception:
        if video_path:
            video_path.unlink(missing_ok=True)
        raise web.HTTPBadRequest(text="invalid_build_input")


def inspect_video(path):
    capture = cv2.VideoCapture(str(path))
    try:
        ok, frame = capture.read()
        fps = capture.get(cv2.CAP_PROP_FPS)
        frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        duration = frame_count / fps if fps > 0 else 0
        if not ok or frame is None or width < 320 or height < 320 or duration < 1 or duration > MAX_DURATION_SECONDS:
            raise ValueError("invalid_video_metadata")
        return {"durationSeconds": round(duration, 2), "width": width, "height": height}
    finally:
        capture.release()


def run_build(task_id, tenant_id, candidate_id, source_checksum, video_path, video_name, metadata):
    tenant_root = CANDIDATE_ROOT / tenant_id
    candidate_path = tenant_root / candidate_id
    temporary_root = tenant_root / f".building-{candidate_id}-{uuid.uuid4()}"
    temporary_candidate = temporary_root / candidate_id
    gpu_lock = None
    try:
        gpu_lock = acquire_gpu_lock()
        with TASKS_LOCK:
            task = TASKS[task_id]
            task["status"] = "running"
            task["progress"] = 1
        generate_avatar(
            video_path=str(video_path),
            avatar_id=candidate_id,
            save_path=str(temporary_root),
            bbox_shift=0,
            extra_margin=10,
            parsing_mode="jaw",
            version="v15",
            progress_callback=lambda value: update_progress(task_id, value),
        )
        images = sorted((temporary_candidate / "full_imgs").glob("*.png"))
        if not images:
            raise ValueError("avatar_frames_missing")
        frame = cv2.imread(str(images[len(images) // 2]))
        if frame is None or not cv2.imwrite(str(temporary_candidate / "preview.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 88]):
            raise ValueError("avatar_preview_failed")
        write_candidate_manifest(temporary_candidate, tenant_id, candidate_id, source_checksum)
        if not verify_candidate(temporary_candidate, tenant_id, candidate_id, source_checksum):
            raise ValueError("avatar_candidate_integrity_failed")
        os.replace(temporary_candidate, candidate_path)
        with TASKS_LOCK:
            task = TASKS[task_id]
            task.update({"status": "completed", "progress": 100, "sourceName": video_name, "sourceMetadata": metadata})
    except Exception:
        shutil.rmtree(temporary_root, ignore_errors=True)
        with TASKS_LOCK:
            task = TASKS.get(task_id)
            if task:
                task.update({"status": "failed", "progress": 0, "errorCode": "avatar_build_failed"})
    finally:
        if gpu_lock:
            gpu_lock.close()
        video_path.unlink(missing_ok=True)


def write_candidate_manifest(candidate_path, tenant_id, candidate_id, source_checksum):
    required = ("full_imgs", "mask", "coords.pkl", "mask_coords.pkl", "latents.pt", "avator_info.json", "preview.jpg")
    for name in required:
        path = candidate_path / name
        if not path.exists() or path.is_symlink():
            raise ValueError("avatar_candidate_incomplete")
    files = []
    for path in sorted(candidate_path.rglob("*")):
        if path.is_symlink():
            raise ValueError("avatar_candidate_symlink")
        if path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            files.append({"path": path.relative_to(candidate_path).as_posix(), "sha256": digest.hexdigest(), "bytes": path.stat().st_size})
    manifest = {"version": 1, "tenantId": tenant_id, "candidateId": candidate_id, "sourceChecksum": source_checksum, "files": files}
    (candidate_path / "shuzhiren-candidate.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")


def verify_candidate(candidate_path, tenant_id, candidate_id, source_checksum):
    try:
        if candidate_path.is_symlink() or not candidate_path.is_dir():
            return False
        manifest_path = candidate_path / "shuzhiren-candidate.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (manifest.get("version") != 1 or manifest.get("tenantId") != tenant_id or manifest.get("candidateId") != candidate_id
                or manifest.get("sourceChecksum") != source_checksum or not isinstance(manifest.get("files"), list)):
            return False
        expected = {entry["path"]: entry for entry in manifest["files"]}
        actual = {}
        for path in candidate_path.rglob("*"):
            if path.is_symlink():
                return False
            if path.is_file() and path != manifest_path:
                actual[path.relative_to(candidate_path).as_posix()] = path
        if set(expected) != set(actual):
            return False
        for name, path in actual.items():
            entry = expected[name]
            digest = hashlib.sha256()
            with path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            if path.stat().st_size != entry.get("bytes") or digest.hexdigest() != entry.get("sha256"):
                return False
        for name in ("coords.pkl", "mask_coords.pkl", "latents.pt", "avator_info.json", "preview.jpg"):
            if name not in actual:
                return False
        if not any(name.startswith("full_imgs/") for name in actual) or not any(name.startswith("mask/") for name in actual):
            return False
        return True
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return False


def acquire_gpu_lock():
    connection = psycopg2.connect(LOCK_DATABASE_URL, connect_timeout=5)
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute("select pg_try_advisory_lock_shared(%s::bigint)", (GPU_LOCK_KEY,))
            if not cursor.fetchone()[0]:
                raise RuntimeError("runtime_gpu_reserved")
        return connection
    except Exception:
        connection.close()
        raise


def update_progress(task_id, value):
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        if task and task["status"] == "running":
            task["progress"] = max(1, min(99, int(value)))


async def get_build(request):
    require_auth(request)
    task_id = request.match_info["task_id"]
    try:
        uuid.UUID(task_id)
    except ValueError:
        raise web.HTTPNotFound(text="build_not_found")
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        result = build_status(task) if task else None
    if result is None:
        raise web.HTTPNotFound(text="build_not_found")
    return web.json_response({"data": result}, headers={"Cache-Control": "no-store"})


async def get_preview(request):
    require_auth(request)
    tenant_id = request.match_info["tenant_id"]
    candidate_id = request.match_info["candidate_id"]
    try:
        if str(uuid.UUID(tenant_id)) != tenant_id:
            raise ValueError("non_canonical_uuid")
        if str(uuid.UUID(candidate_id)) != candidate_id:
            raise ValueError("non_canonical_uuid")
    except ValueError:
        raise web.HTTPNotFound(text="candidate_not_found")
    path = CANDIDATE_ROOT / tenant_id / candidate_id / "preview.jpg"
    if not path.is_file():
        raise web.HTTPNotFound(text="candidate_preview_not_found")
    return web.FileResponse(path, headers={"Cache-Control": "no-store"})


def create_app():
    if len(TOKEN) < 48 or any(character.isspace() for character in TOKEN):
        raise RuntimeError("AVATAR_BUILDER_TOKEN must contain at least 48 non-whitespace characters")
    if not LOCK_DATABASE_URL:
        raise RuntimeError("AVATAR_BUILDER_LOCK_DATABASE_URL is required")
    app = web.Application(client_max_size=MAX_UPLOAD_BYTES + 1024 * 1024)
    app.router.add_get("/healthz", health)
    app.router.add_post("/v1/builds", create_build)
    app.router.add_get("/v1/builds/{task_id}", get_build)
    app.router.add_get("/v1/candidates/{tenant_id}/{candidate_id}/preview", get_preview)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=PORT, access_log=None)
