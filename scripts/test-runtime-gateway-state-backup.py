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


def run_unchecked(script: pathlib.Path, environment: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(script)], cwd=ROOT, env=environment, text=True, capture_output=True, check=False)


def backup_environment(state_dir: pathlib.Path, backup_dir: pathlib.Path) -> dict[str, str]:
    return {
        **os.environ,
        "RUNTIME_GATEWAY_STATE_PATH": str(state_dir),
        "BACKUP_DIR": str(backup_dir),
        "PYTHON_BIN": sys.executable,
    }


def create_idle_wal_journal(state_dir: pathlib.Path, rows: int) -> pathlib.Path:
    state_dir.mkdir()
    database = state_dir / "commands.sqlite3"
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(
            "create table runtime_command_journal (command_id text primary key, identity_sha256 text not null, state text not null)"
        )
        connection.executemany(
            "insert into runtime_command_journal(command_id, identity_sha256, state) values (?, ?, ?)",
            [(f"idle-command-{index}", "b" * 64, "completed") for index in range(rows)],
        )
        connection.commit()
    finally:
        connection.close()
    return database


def snapshot_facts(snapshot: pathlib.Path) -> tuple[str, int, str]:
    connection = sqlite3.connect(f"{snapshot.as_uri()}?mode=ro", uri=True)
    try:
        return (
            connection.execute("PRAGMA integrity_check").fetchone()[0],
            connection.execute("select count(*) from runtime_command_journal").fetchone()[0],
            connection.execute("PRAGMA journal_mode").fetchone()[0],
        )
    finally:
        connection.close()


def assert_single_error_line(result: subprocess.CompletedProcess[str], database: pathlib.Path, *fragments: str) -> None:
    assert result.returncode != 0, result.stdout
    assert "Traceback" not in result.stderr, result.stderr
    error_lines = [line for line in result.stderr.splitlines() if line.strip()]
    assert len(error_lines) == 1 and error_lines[0].startswith("ERROR"), result.stderr
    assert str(database.resolve()) in error_lines[0], result.stderr
    for fragment in fragments:
        assert fragment in error_lines[0], result.stderr


def make_read_only(directory: pathlib.Path) -> None:
    os.chmod(directory, 0o555)
    try:
        open(directory / "probe", "x").close()
    except PermissionError:
        return
    raise AssertionError(f"{directory} must reject new files for the read-only backup test")


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

        environment = backup_environment(state_dir, backup_dir)
        result = run(BACKUP_SCRIPT, environment)
        assert "snapshot created and verified" in result.stdout
        snapshots = list(backup_dir.glob("*.sqlite3"))
        manifests = list(backup_dir.glob("*.manifest"))
        assert len(snapshots) == 1 and len(manifests) == 1
        assert sorted(path.name for path in backup_dir.iterdir()) == sorted([snapshots[0].name, manifests[0].name]), "a backup must not leave temporary files"
        snapshot = snapshots[0]
        checksum = hashlib.sha256(snapshot.read_bytes()).hexdigest()
        manifest = manifests[0].read_text(encoding="utf-8")
        assert f"sha256={checksum}" in manifest
        assert "journal_rows=1" in manifest
        assert snapshot_facts(snapshot)[2] == "delete", "a snapshot must not depend on -wal or -shm files"

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

    # A journal without the Gateway table fails with one ERROR line and leaves nothing behind.
    foreign_state = root / "foreign-state"
    foreign_backups = root / "foreign-backups"
    foreign_state.mkdir()
    foreign_database = foreign_state / "commands.sqlite3"
    foreign = sqlite3.connect(foreign_database)
    try:
        foreign.execute("create table unrelated (id integer)")
        foreign.commit()
    finally:
        foreign.close()
    refused = run_unchecked(BACKUP_SCRIPT, backup_environment(foreign_state, foreign_backups))
    assert_single_error_line(refused, foreign_database, "runtime_command_journal")
    assert list(foreign_backups.iterdir()) == [], "a failed backup must not leave files in BACKUP_DIR"

    # An idle Gateway leaves only commands.sqlite3. The backup must not create
    # -wal or -shm files there: they would belong to the backup user.
    idle_state = root / "idle-writable-state"
    idle_backups = root / "idle-writable-backups"
    create_idle_wal_journal(idle_state, rows=3)
    run(BACKUP_SCRIPT, backup_environment(idle_state, idle_backups))
    assert sorted(path.name for path in idle_state.iterdir()) == ["commands.sqlite3"], sorted(path.name for path in idle_state.iterdir())
    idle_snapshots = list(idle_backups.glob("*.sqlite3"))
    assert len(idle_snapshots) == 1 and snapshot_facts(idle_snapshots[0]) == ("ok", 3, "delete")
    assert "journal_rows=3" in next(idle_backups.glob("*.manifest")).read_text(encoding="utf-8")

print("PASS  Gateway command journal backup creates a consistent, verifiable SQLite snapshot")

# Scheduled backups run with the state directory mounted read-only
# (ReadOnlyPaths=) while the Gateway is usually idle, so -wal and -shm are absent.
assert hasattr(os, "geteuid") and os.geteuid() != 0, "the read-only journal backup checks need Linux and a non-root user"
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    idle_state = root / "idle-state"
    idle_backups = root / "idle-backups"
    idle_database = create_idle_wal_journal(idle_state, rows=3)
    assert not pathlib.Path(f"{idle_database}-wal").exists() and not pathlib.Path(f"{idle_database}-shm").exists()
    make_read_only(idle_state)
    try:
        environment = backup_environment(idle_state, idle_backups)
        result = run(BACKUP_SCRIPT, environment)
        assert "snapshot created and verified" in result.stdout
        snapshots = list(idle_backups.glob("*.sqlite3"))
        manifests = list(idle_backups.glob("*.manifest"))
        assert len(snapshots) == 1 and len(manifests) == 1
        assert sorted(path.name for path in idle_backups.iterdir()) == sorted([snapshots[0].name, manifests[0].name])
        integrity, rows, journal_mode = snapshot_facts(snapshots[0])
        assert integrity == "ok" and rows == 3 and journal_mode == "delete", (integrity, rows, journal_mode)
        assert "journal_rows=3" in manifests[0].read_text(encoding="utf-8")
        assert sorted(path.name for path in idle_state.iterdir()) == ["commands.sqlite3"], "the backup must not write into the Gateway state directory"
        verification = run(VERIFY_SCRIPT, {**environment, "BACKUP_FILE": str(snapshots[0])})
        assert "Journal rows: 3" in verification.stdout
    finally:
        os.chmod(idle_state, 0o755)

    stranded_state = root / "stranded-state"
    stranded_backups = root / "stranded-backups"
    stranded_database = create_idle_wal_journal(stranded_state, rows=3)
    pathlib.Path(f"{stranded_database}-wal").write_bytes(b"uncheckpointed frames")
    make_read_only(stranded_state)
    try:
        rejected = run_unchecked(BACKUP_SCRIPT, backup_environment(stranded_state, stranded_backups))
        assert_single_error_line(rejected, stranded_database, "-shm")
        assert list(stranded_backups.iterdir()) == [], "a refused backup must not leave files in BACKUP_DIR"
    finally:
        os.chmod(stranded_state, 0o755)

print("PASS  Gateway command journal backup snapshots an idle WAL journal from a read-only state directory")
