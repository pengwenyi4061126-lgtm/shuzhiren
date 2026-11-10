import hashlib
import hmac
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path, PurePosixPath

from aiohttp import web

TOKEN = os.environ.get("AVATAR_PUBLISHER_TOKEN", "")
PORT = int(os.environ.get("AVATAR_PUBLISHER_PORT", "8021"))
CANDIDATE_ROOT = Path(os.environ.get("AVATAR_PUBLISHER_CANDIDATE_ROOT", "/var/lib/shuzhiren-avatar-candidates")).resolve()
PUBLISHED_ROOT = Path(os.environ.get("AVATAR_PUBLISHER_PUBLISHED_ROOT", "/var/lib/shuzhiren-avatars")).resolve()
REQUIRED_FILES = {"coords.pkl", "mask_coords.pkl", "latents.pt", "avator_info.json"}


def authorized(request):
    header = request.headers.get("Authorization", "")
    supplied = header[7:] if header.startswith("Bearer ") else ""
    return bool(TOKEN) and hmac.compare_digest(supplied.encode(), TOKEN.encode())


def require_auth(request):
    if not authorized(request):
        raise web.HTTPUnauthorized(headers={"Cache-Control": "no-store"})


async def health(_request):
    return web.json_response({"ok": True}, headers={"Cache-Control": "no-store"})


async def publish(request):
    require_auth(request)
    try:
        body = await request.json()
        tenant_id = str(uuid.UUID(body.get("tenantId", "")))
        candidate_id = str(uuid.UUID(body.get("candidateId", "")))
        checksum = body.get("sourceChecksum", "")
        if (tenant_id != body.get("tenantId") or candidate_id != body.get("candidateId")
                or len(checksum) != 71 or not checksum.startswith("sha256:")
                or any(character not in "0123456789abcdef" for character in checksum[7:])):
            raise ValueError("invalid_publish_input")
        avatar_id = f"sr_{candidate_id.replace('-', '')}"
        candidate = CANDIDATE_ROOT / tenant_id / candidate_id
        if not verify_candidate(candidate, tenant_id, candidate_id, checksum):
            raise ValueError("candidate_integrity_failed")
        destination = PUBLISHED_ROOT / avatar_id
        marker = {"version": 1, "avatarId": avatar_id, "tenantId": tenant_id, "candidateId": candidate_id, "sourceChecksum": checksum}
        if destination.exists():
            if destination.is_symlink() or not destination.is_dir() or not verify_published(destination, marker):
                raise ValueError("published_avatar_conflict")
            return web.json_response({"data": {"avatarId": avatar_id, "status": "published"}}, headers={"Cache-Control": "no-store"})

        PUBLISHED_ROOT.mkdir(parents=True, exist_ok=True)
        if PUBLISHED_ROOT.is_symlink():
            raise ValueError("published_root_invalid")
        temporary = Path(tempfile.mkdtemp(prefix=f".publishing-{avatar_id}-", dir=PUBLISHED_ROOT))
        try:
            copy_verified_files(candidate, temporary)
            (temporary / "shuzhiren-published.json").write_text(json.dumps(marker, separators=(",", ":")), encoding="utf-8")
            if not verify_published(temporary, marker):
                raise ValueError("published_avatar_integrity_failed")
            try:
                os.replace(temporary, destination)
            except FileExistsError:
                if not verify_published(destination, marker):
                    raise ValueError("published_avatar_conflict")
                shutil.rmtree(temporary, ignore_errors=True)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        return web.json_response({"data": {"avatarId": avatar_id, "status": "published"}}, headers={"Cache-Control": "no-store"})
    except (ValueError, TypeError, AttributeError, json.JSONDecodeError):
        raise web.HTTPConflict(text="avatar_candidate_not_publishable", headers={"Cache-Control": "no-store"})


def candidate_manifest(root, tenant_id, candidate_id, checksum):
    if root.is_symlink() or not root.is_dir():
        raise ValueError("candidate_directory_invalid")
    manifest = json.loads((root / "shuzhiren-candidate.json").read_text(encoding="utf-8"))
    if (manifest.get("version") != 1 or manifest.get("tenantId") != tenant_id or manifest.get("candidateId") != candidate_id
            or manifest.get("sourceChecksum") != checksum or not isinstance(manifest.get("files"), list)):
        raise ValueError("candidate_manifest_mismatch")
    expected = {}
    for entry in manifest["files"]:
        name = entry.get("path")
        path = PurePosixPath(name) if isinstance(name, str) else None
        if (path is None or path.is_absolute() or ".." in path.parts or "\\" in name or name in expected
                or not isinstance(entry.get("bytes"), int) or entry["bytes"] < 0
                or not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64
                or any(character not in "0123456789abcdef" for character in entry["sha256"])):
            raise ValueError("candidate_manifest_invalid")
        expected[name] = entry
    actual = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("candidate_symlink")
        if path.is_file() and path.name != "shuzhiren-candidate.json":
            actual[path.relative_to(root).as_posix()] = path
    if set(expected) != set(actual):
        raise ValueError("candidate_file_set_mismatch")
    for name, path in actual.items():
        entry = expected[name]
        if path.stat().st_size != entry["bytes"] or file_sha256(path) != entry["sha256"]:
            raise ValueError("candidate_file_checksum_mismatch")
    if not REQUIRED_FILES.issubset(expected) or not any(name.startswith("full_imgs/") for name in expected) or not any(name.startswith("mask/") for name in expected):
        raise ValueError("candidate_runtime_files_missing")
    return actual


def verify_candidate(root, tenant_id, candidate_id, checksum):
    try:
        candidate_manifest(root, tenant_id, candidate_id, checksum)
        return True
    except (OSError, ValueError, TypeError, KeyError, AttributeError, json.JSONDecodeError):
        return False


def copy_verified_files(candidate, destination):
    manifest = json.loads((candidate / "shuzhiren-candidate.json").read_text(encoding="utf-8"))
    files = candidate_manifest(candidate, manifest["tenantId"], manifest["candidateId"], manifest["sourceChecksum"])
    for name, source in files.items():
        target = destination.joinpath(*PurePosixPath(name).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)


def verify_published(root, expected_marker):
    try:
        if root.is_symlink() or not root.is_dir():
            return False
        marker = json.loads((root / "shuzhiren-published.json").read_text(encoding="utf-8"))
        if marker != expected_marker:
            return False
        tenant_id, candidate_id = marker["tenantId"], marker["candidateId"]
        candidate = CANDIDATE_ROOT / tenant_id / candidate_id
        files = candidate_manifest(candidate, tenant_id, candidate_id, marker["sourceChecksum"])
        actual = set()
        for path in root.rglob("*"):
            if path.is_symlink():
                return False
            if path.is_file():
                actual.add(path.relative_to(root).as_posix())
        if actual != set(files) | {"shuzhiren-published.json"}:
            return False
        for name, source in files.items():
            target = root.joinpath(*PurePosixPath(name).parts)
            if target.is_symlink() or not target.is_file() or target.stat().st_size != source.stat().st_size or file_sha256(target) != file_sha256(source):
                return False
        return True
    except (OSError, ValueError, TypeError, KeyError, AttributeError, json.JSONDecodeError):
        return False


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    if len(TOKEN) < 48 or any(character.isspace() for character in TOKEN):
        raise RuntimeError("AVATAR_PUBLISHER_TOKEN must contain at least 48 non-whitespace characters")
    app = web.Application(client_max_size=16 * 1024)
    app.router.add_get("/healthz", health)
    app.router.add_post("/v1/publish", publish)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)


if __name__ == "__main__":
    main()
