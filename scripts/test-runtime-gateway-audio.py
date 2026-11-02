from io import BytesIO
import pathlib
import sys
import wave

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
from audio import pcm_s16le_to_wav


payload = b"\x00\x00" * 24_000
with wave.open(BytesIO(pcm_s16le_to_wav(payload, 24_000)), "rb") as reader:
    assert reader.getnchannels() == 1
    assert reader.getsampwidth() == 2
    assert reader.getframerate() == 24_000
    assert reader.getnframes() == 24_000

try:
    pcm_s16le_to_wav(b"\x00", 24_000)
except ValueError:
    pass
else:
    raise AssertionError("odd-length PCM must be rejected")

print("PASS  Runtime Gateway wraps CosyVoice S16LE PCM as verified WAV")
