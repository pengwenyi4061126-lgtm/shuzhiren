"""Caption cues for the Runtime Gateway (live-commerce-p1-features, Requirement 6.10 and 6.11).

The Gateway synthesizes a script chunk by chunk, so it knows how many samples each chunk produced. build_caption_cues turns
the chunk texts and sample counts into display lines timed by the audio that LiveTalking will actually play. caption_form_value
serializes them as the `shuzhiren_caption` field of the /humanaudio request. LiveTalking advances the cues only with the audio
frames that carry the caption id (design K3), so the times here are positions inside this one audio, not wall-clock times.

Timing: the start of chunk i is S_i = round(1000 * sum(samples[:i]) / sample_rate). Rounding is half up, in integer
arithmetic. Lines inside a chunk share the chunk's samples in proportion to their non-whitespace characters, using the same
rounding on absolute sample positions, so cues touch exactly and the last cue ends at the rounded total duration.

A chunk without pronounceable text (whitespace or punctuation only) has no cue of its own. Its text and samples join the
previous chunk, or the next one when it comes first, as split_script in app.py already does for CosyVoice requests. A script
with no non-whitespace character has no cue at all.
"""
import hashlib
import json
import re
import unicodedata

MAX_CUES = 200
MAX_CAPTION_FORM_BYTES = 16 * 1024
MIN_LINE_MAX_CHARS = 8
MAX_LINE_MAX_CHARS = 40
DEFAULT_LINE_MAX_CHARS = 18
MAX_CAPTION_ID_CHARS = 64

# Same sets as split_script in app.py. A sentence keeps its end marks and the closing marks that follow them.
SENTENCE_END_CHARS = frozenset("。！？!?；;…\n")
SENTENCE_CLOSING_CHARS = frozenset("”’）)」』】》\"'")
SECONDARY_BREAK_CHARS = frozenset("，,、：:")

# LiveTalking's parse_caption accepts exactly this id alphabet.
CAPTION_ID_PATTERN = re.compile(r"[A-Za-z0-9_.:\-]{1,64}")
WHITESPACE = re.compile(r"\s+")


def _round_half_up_ms(numerator: int, denominator: int) -> int:
    """round(1000 * numerator / denominator) for non-negative integers, halves rounded up."""
    return (2 * 1000 * numerator + denominator) // (2 * denominator)


def _pronounceable(text: str) -> bool:
    return any(unicodedata.category(character)[0] in "LN" for character in text)


def _significant_chars(text: str) -> int:
    return sum(1 for character in text if not character.isspace())


def _sentences(text: str) -> list[str]:
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


def _cut_long_sentence(sentence: str, max_chars: int) -> list[str]:
    """Stripped pieces of at most max_chars. A piece ends after a comma or a space when one lies in the second half."""
    pieces: list[str] = []
    remaining = sentence.strip()
    while len(remaining) > max_chars:
        cut = next((end for end in range(max_chars, max_chars // 2 - 1, -1) if remaining[end - 1] in SECONDARY_BREAK_CHARS or remaining[end - 1].isspace()), max_chars)
        pieces.append(remaining[:cut].strip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        pieces.append(remaining)
    return pieces


def _display_lines(text: str, max_chars: int) -> list[str]:
    """Split text into non-empty stripped lines of at most max_chars; the lines hold every non-whitespace character in order."""
    lines: list[str] = []
    current = ""
    for sentence in _sentences(WHITESPACE.sub(" ", text).strip()):
        if len(sentence.strip()) > max_chars:
            if current.strip():
                lines.append(current.strip())
            pieces = _cut_long_sentence(sentence, max_chars)
            lines.extend(pieces[:-1])
            current = pieces[-1]
            continue
        candidate = current + sentence
        if len(candidate.strip()) <= max_chars:
            current = candidate
        else:
            if current.strip():
                lines.append(current.strip())
            current = sentence
    if current.strip():
        lines.append(current.strip())
    return lines


def _validate(chunk_texts: list[str], chunk_samples: list[int], sample_rate: int, line_max_chars: int) -> None:
    if len(chunk_texts) != len(chunk_samples):
        raise ValueError("chunk_texts and chunk_samples must have the same length")
    if any(not isinstance(text, str) for text in chunk_texts):
        raise ValueError("chunk_texts must be strings")
    if any(isinstance(samples, bool) or not isinstance(samples, int) or samples < 0 for samples in chunk_samples):
        raise ValueError("chunk_samples must be non-negative integers")
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError("sample_rate must be a positive integer")
    if isinstance(line_max_chars, bool) or not isinstance(line_max_chars, int) or not MIN_LINE_MAX_CHARS <= line_max_chars <= MAX_LINE_MAX_CHARS:
        raise ValueError(f"line_max_chars must be an integer between {MIN_LINE_MAX_CHARS} and {MAX_LINE_MAX_CHARS}")


def _groups(chunk_texts: list[str], chunk_samples: list[int]) -> list[tuple[str, int, int]]:
    """(text, first sample, sample count) per run of chunks that end in pronounceable text; others join a neighbour."""
    groups: list[list] = []
    first_sample = 0
    pending_text, pending_samples = "", 0
    for text, samples in zip(chunk_texts, chunk_samples):
        if not _pronounceable(text):
            if groups:
                groups[-1][0] += text
                groups[-1][2] += samples
            else:
                pending_text += text
                pending_samples += samples
        else:
            groups.append([pending_text + text, first_sample - pending_samples, pending_samples + samples])
            pending_text, pending_samples = "", 0
        first_sample += samples
    if pending_text.strip() and not groups:
        groups.append([pending_text, 0, pending_samples])
    return [(text, start, samples) for text, start, samples in groups]


def build_caption_cues(chunk_texts: list[str], chunk_samples: list[int], sample_rate: int, line_max_chars: int = DEFAULT_LINE_MAX_CHARS) -> list[dict]:
    """[{"text": str, "start_ms": int, "end_ms": int}, ...], at most MAX_CUES entries.

    Cues are sorted, adjacent ones touch, no text is empty or longer than line_max_chars, and the texts joined without
    whitespace equal the chunk texts joined without whitespace. If more than MAX_CUES lines result, the lines from the
    MAX_CUES-th on become one last cue that runs to the end of the audio, with its text cut to line_max_chars.
    """
    _validate(chunk_texts, chunk_samples, sample_rate, line_max_chars)
    cues: list[dict] = []
    for text, first_sample, samples in _groups(chunk_texts, chunk_samples):
        lines = _display_lines(text, line_max_chars)
        total_chars = sum(_significant_chars(line) for line in lines)
        consumed = 0
        previous_end = _round_half_up_ms(first_sample, sample_rate)
        for line in lines:
            consumed += _significant_chars(line)
            end = _round_half_up_ms(first_sample * total_chars + samples * consumed, sample_rate * total_chars)
            cues.append({"text": line, "start_ms": previous_end, "end_ms": end})
            previous_end = end
    if len(cues) > MAX_CUES:
        merged_text = " ".join(cue["text"] for cue in cues[MAX_CUES - 1:])[:line_max_chars].strip()
        cues = cues[:MAX_CUES - 1] + [{"text": merged_text, "start_ms": cues[MAX_CUES - 1]["start_ms"], "end_ms": cues[-1]["end_ms"]}]
    return cues


def caption_id_for(command_id: str) -> str:
    """The command id when LiveTalking accepts it as a caption id, otherwise a fixed-length digest of it."""
    if CAPTION_ID_PATTERN.fullmatch(command_id):
        return command_id
    return hashlib.sha256(command_id.encode("utf-8")).hexdigest()[:MAX_CAPTION_ID_CHARS]


def caption_form_value(caption_id: str, cues: list[dict]) -> str | None:
    """The `shuzhiren_caption` form value {"id", "cues"} as compact UTF-8 JSON of at most MAX_CAPTION_FORM_BYTES.

    If the cues do not fit, the latest ones are left out, so the caption stops early instead of the audio failing.
    Returns None when no cue is left, so the caller sends no caption field.
    """
    if not isinstance(caption_id, str) or not CAPTION_ID_PATTERN.fullmatch(caption_id):
        raise ValueError("caption_id must be 1 to 64 characters of letters, digits and _.:-")
    head = json.dumps({"id": caption_id, "cues": []}, ensure_ascii=False, separators=(",", ":"))[:-2]
    size = len(head.encode("utf-8")) + len(b"]}")
    kept: list[str] = []
    for cue in cues:
        encoded = json.dumps({"text": cue["text"], "start_ms": cue["start_ms"], "end_ms": cue["end_ms"]}, ensure_ascii=False, separators=(",", ":"))
        added = len(encoded.encode("utf-8")) + (1 if kept else 0)
        if size + added > MAX_CAPTION_FORM_BYTES:
            break
        kept.append(encoded)
        size += added
    if not kept:
        return None
    return f"{head}{','.join(kept)}]}}"
