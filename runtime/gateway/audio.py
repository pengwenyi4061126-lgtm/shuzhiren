from io import BytesIO
import wave


def pcm_s16le_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    if not isinstance(sample_rate, int) or sample_rate < 8_000 or sample_rate > 192_000:
        raise ValueError("sample_rate must be an integer between 8000 and 192000")
    if len(pcm) % 2:
        raise ValueError("PCM S16LE payload must contain complete 16-bit samples")
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()
