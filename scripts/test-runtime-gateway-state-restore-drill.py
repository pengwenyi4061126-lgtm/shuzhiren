import asyncio
import hashlib
import os
import pathlib
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime" / "gateway"))
import app as gateway


BACKUP_SCRIPT = ROOT / "scripts" / "backup-runtime-gateway-state.sh"
RESTORE_SCRIPT = ROOT / "scripts" / "restore-runtime-gateway-state-drill.sh"


def run(script: pathlib.Path, environment: dict[str, str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(script)],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=check,
    )


async def main() -> None:
    gateway.RUNTIME_TOKEN = "test-runtime-token"
    gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED = True
    gateway.COSYVOICE_MODEL_KIND = "sft"
    gateway.runtime_command_cache.clear()
    gateway.runtime_command_locks.clear()

    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        source_state = root / "source-gateway-state"
        backup_dir = root / "backups"
        drill_state = root / "isolated-gateway-restore"
        unsafe_state = root / "unsafe-gateway-restore"
        evidence = root / "gateway-restore-evidence.manifest"
        source_state.mkdir()
        drill_state.mkdir()
        unsafe_state.mkdir()
        (unsafe_state / "not-empty").write_text("refuse", encoding="utf-8")
        gateway.RUNTIME_COMMAND_JOURNAL_PATH = str(source_state / "commands.sqlite3")
        media_calls: list[tuple[str, dict]] = []
        synthesis_calls: list[tuple[str, str]] = []
        audio_calls: list[tuple[str, bytes]] = []

        async def livetalking_post(path: str, payload: dict) -> dict:
            media_calls.append((path, payload))
            return {"code": 0}

        async def cosyvoice_synthesize(text: str, voice, deadline: float):
            synthesis_calls.append((text, voice.runtime_voice_id))
            return gateway.SynthesisResult(pcm=b"\x01\x00\x02\x00", chunks=1, synth_ms=0)

        async def livetalking_audio(session_id: str, audio: bytes) -> None:
            audio_calls.append((session_id, audio))

        gateway.livetalking_post = livetalking_post
        gateway.cosyvoice_synthesize = cosyvoice_synthesize
        gateway.livetalking_audio = livetalking_audio
        authorization = "Bearer test-runtime-token"
        media_request = gateway.MediaRequest(
            command_id="restore_completed_command",
            session_id="restore_session",
            action="start_program",
        )
        speech_request = gateway.SpeakRequest(
            command_id="restore_completed_speech",
            session_id="restore_session",
            text="A completed speech command must not be replayed.",
            voice="restore-drill-speaker",
            provider="cosyvoice",
        )
        original_media = await gateway.media(media_request, authorization)
        original_speech = await gateway.speak(speech_request, authorization)
        assert original_media["duplicate"] is False
        assert original_speech["duplicate"] is False
        assert len(media_calls) == 2
        assert synthesis_calls == [(speech_request.text, speech_request.voice)]
        assert audio_calls == [(speech_request.session_id, gateway.pcm_s16le_to_wav(b"\x01\x00\x02\x00", gateway.COSYVOICE_SAMPLE_RATE))]

        backup_environment = {
            **os.environ,
            "RUNTIME_GATEWAY_STATE_PATH": str(source_state),
            "BACKUP_DIR": str(backup_dir),
            "PYTHON_BIN": sys.executable,
        }
        run(BACKUP_SCRIPT, backup_environment)
        snapshots = list(backup_dir.glob("*.sqlite3"))
        assert len(snapshots) == 1
        snapshot = snapshots[0]
        checksum = hashlib.sha256(snapshot.read_bytes()).hexdigest()

        restore_environment = {
            **backup_environment,
            "BACKUP_FILE": str(snapshot),
            "DRILL_GATEWAY_STATE_PATH": str(drill_state),
            "DRILL_EVIDENCE_FILE": str(evidence),
            "DRILL_GATEWAY_UID": str(os.getuid()),
            "DRILL_GATEWAY_BACKUP_GROUP": str(os.getgid()),
            "RESTORE_DRILL_CONFIRM": f"restore-{checksum}",
            "WORKSPACE_ROOT": str(ROOT),
        }
        restored = run(RESTORE_SCRIPT, restore_environment)
        assert "restored into isolated state directory" in restored.stdout
        assert (drill_state / "commands.sqlite3").is_file()
        evidence_text = evidence.read_text(encoding="utf-8")
        assert f"snapshot_sha256={checksum}" in evidence_text
        assert "completed_command_rows=2" in evidence_text
        assert "gateway_started=false" in evidence_text

        unsafe = run(
            RESTORE_SCRIPT,
            {**restore_environment, "DRILL_GATEWAY_STATE_PATH": str(unsafe_state), "DRILL_EVIDENCE_FILE": str(root / "unsafe-evidence.manifest")},
            check=False,
        )
        assert unsafe.returncode != 0
        assert "must be empty" in unsafe.stderr

        gateway.RUNTIME_COMMAND_JOURNAL_PATH = str(drill_state / "commands.sqlite3")
        gateway.runtime_command_cache.clear()
        gateway.runtime_command_locks.clear()
        assert gateway.command_journal_status()["available"] is True
        replay_attempts: list[str] = []

        async def fail_on_replay(path: str, payload: dict) -> dict:
            replay_attempts.append("livetalking_post")
            raise AssertionError("a restored completed command must not call LiveTalking")

        async def fail_on_synthesis(text: str, voice, deadline: float):
            replay_attempts.append("cosyvoice_synthesize")
            raise AssertionError("a restored completed command must not call CosyVoice")

        async def fail_on_audio(session_id: str, audio: bytes) -> None:
            replay_attempts.append("livetalking_audio")
            raise AssertionError("a restored completed command must not inject audio into LiveTalking")

        gateway.livetalking_post = fail_on_replay
        gateway.cosyvoice_synthesize = fail_on_synthesis
        gateway.livetalking_audio = fail_on_audio
        repeated_media = await gateway.media(media_request, authorization)
        repeated_speech = await gateway.speak(speech_request, authorization)
        assert repeated_media["duplicate"] is True
        assert repeated_speech["duplicate"] is True
        assert {key: value for key, value in repeated_media.items() if key != "duplicate"} == {
            key: value for key, value in original_media.items() if key != "duplicate"
        }
        assert {key: value for key, value in repeated_speech.items() if key != "duplicate"} == {
            key: value for key, value in original_speech.items() if key != "duplicate"
        }
        assert not replay_attempts


asyncio.run(main())
print("PASS  Gateway journal isolated restore preserves completed media and speech commands without replaying downstream services")
