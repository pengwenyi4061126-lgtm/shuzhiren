import hashlib
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
BACKUP_SCRIPT = ROOT / "scripts" / "backup-runtime-gateway-state.sh"
VERIFY_SCRIPT = ROOT / "scripts" / "verify-runtime-gateway-state-backup.sh"


def run(script: pathlib.Path, environment: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(script)],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=True,
    )


with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    state_dir = root / "gateway-state"
    backup_dir = root / "backups"
    state_dir.mkdir()
    database = state_dir / "commands.sqlite3"
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(
            "create table runtime_command_journal (command_id text primary key, identity_sha256 text not null, state text not null)"
        )
        connection.execute(
            "insert into runtime_command_journal(command_id, identity_sha256, state) values (?, ?, ?)",
            ("already-completed", "a" * 64, "completed"),
        )
        connection.commit()

        environment = {
            **os.environ,
            "RUNTIME_GATEWAY_STATE_PATH": str(state_dir),
            "BACKUP_DIR": str(backup_dir),
            "PYTHON_BIN": sys.executable,
        }
        result = run(BACKUP_SCRIPT, environment)
        assert "snapshot created and verified" in result.stdout
        snapshots = list(backup_dir.glob("*.sqlite3"))
        manifests = list(backup_dir.glob("*.manifest"))
        assert len(snapshots) == 1 and len(manifests) == 1
        snapshot = snapshots[0]
        checksum = hashlib.sha256(snapshot.read_bytes()).hexdigest()
        manifest = manifests[0].read_text(encoding="utf-8")
        assert f"sha256={checksum}" in manifest
        assert "journal_rows=1" in manifest

        verification = run(
            VERIFY_SCRIPT,
            {**environment, "BACKUP_FILE": str(snapshot), "EXPECTED_SHA256": checksum},
        )
        assert "Journal rows: 1" in verification.stdout
        tampered_manifest = backup_dir / "tampered.manifest"
        tampered_manifest.write_text(manifest.replace(f"bytes={snapshot.stat().st_size}", "bytes=0"), encoding="utf-8")
        rejected = subprocess.run(
            ["bash", str(VERIFY_SCRIPT)],
            cwd=ROOT,
            env={**environment, "BACKUP_FILE": str(snapshot), "MANIFEST_FILE": str(tampered_manifest)},
            text=True,
            capture_output=True,
            check=False,
        )
        assert rejected.returncode != 0
        assert "Gateway backup bytes do not match gateway backup manifest" in rejected.stderr
        snapshot_connection = sqlite3.connect(f"{snapshot.as_uri()}?mode=ro", uri=True)
        try:
            assert snapshot_connection.execute("select state from runtime_command_journal").fetchone()[0] == "completed"
        finally:
            snapshot_connection.close()
    finally:
        connection.close()

print("PASS  Gateway command journal backup creates a consistent, verifiable SQLite snapshot")
