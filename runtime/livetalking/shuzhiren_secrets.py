"""Stream-key handling for the Shuzhiren LiveTalking image (audit H2, design Requirement 14).

The RTMP stream key is read from a file (a Compose secret mounted at
/run/secrets/stream-key), never from argv or the environment, and every place
LiveTalking could echo it (log records, HTTP responses, raw stdout/stderr) is
redacted. Standard library only; aiohttp is imported lazily by the middleware.
"""

from __future__ import annotations

import argparse
import logging
import sys
import threading
from typing import Iterable
from urllib.parse import quote, quote_plus, urlsplit

REDACTED = "<redacted>"
REDACTED_URL_SUFFIX = "/<redacted>"
STREAM_KEY_FILE_EXIT_CODE = 78  # EX_CONFIG
MAX_STREAM_KEY_BYTES = 1024
FORBIDDEN_KEY_CHARACTERS = frozenset('"\\')


class StreamKeyFileError(Exception):
    """The stream key file cannot be used; `reason` is missing, unreadable, empty or invalid."""

    def __init__(self, path: str, reason: str) -> None:
        super().__init__(f"LiveTalking stream key file {path} is {reason}")
        self.path = path
        self.reason = reason


def load_stream_key(path: str) -> str:
    """Reads and validates the key; the error message names only the path and a category."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_STREAM_KEY_BYTES + 1)
    except FileNotFoundError:
        raise StreamKeyFileError(path, "missing") from None
    except OSError:
        raise StreamKeyFileError(path, "unreadable") from None
    if raw.endswith(b"\r\n"):
        raw = raw[:-2]
    elif raw.endswith(b"\n"):
        raw = raw[:-1]
    if not raw.strip():
        raise StreamKeyFileError(path, "empty")
    if len(raw) > MAX_STREAM_KEY_BYTES:
        raise StreamKeyFileError(path, "invalid")
    try:
        key = raw.decode("ascii")
    except UnicodeDecodeError:
        raise StreamKeyFileError(path, "invalid") from None
    if any(ord(character) <= 0x20 or ord(character) == 0x7F or character in FORBIDDEN_KEY_CHARACTERS for character in key):
        raise StreamKeyFileError(path, "invalid")
    return key


def join_push_url(base: str, key: str) -> str:
    """Same address the former `--push_url ${STREAM_RTMP_URL}/${STREAM_KEY}` produced."""
    return f"{base}/{key}"


def redact_push_url(url: object) -> str:
    """Keeps scheme, host and port; everything after the port becomes /<redacted>."""
    try:
        parts = urlsplit(str(url))
        host = parts.hostname
        port = parts.port
    except ValueError:
        return REDACTED_URL_SUFFIX
    if not parts.scheme or not host:
        return REDACTED_URL_SUFFIX
    if ":" in host:
        host = f"[{host}]"
    netloc = host if port is None else f"{host}:{port}"
    return f"{parts.scheme}://{netloc}{REDACTED_URL_SUFFIX}"


def secret_variants(key: str, push_url: str | None = None) -> list[str]:
    """Every spelling of the key LiveTalking could print, longest first."""
    variants = {key, quote(key, safe=""), quote_plus(key)}
    if push_url:
        variants.add(push_url)
    return sorted((value for value in variants if value), key=len, reverse=True)


_secrets_lock = threading.Lock()
_secrets: list[str] = []


def register_secret(key: str, push_url: str | None = None) -> None:
    with _secrets_lock:
        merged = set(_secrets) | set(secret_variants(key, push_url))
        _secrets[:] = sorted(merged, key=len, reverse=True)


def registered_secrets() -> tuple[str, ...]:
    with _secrets_lock:
        return tuple(_secrets)


def redact_text(text: object, secrets: Iterable[str] | None = None) -> object:
    if not isinstance(text, str):
        return text
    for secret in registered_secrets() if secrets is None else secrets:
        if secret:
            text = text.replace(secret, REDACTED)
    return text


def apply_stream_key(opt: argparse.Namespace, stream=None) -> argparse.Namespace:
    """Called at the end of config.parse_args(): appends the key from --stream_key_file to push_url.

    RTMP output without a usable key file exits with 78 before any listener or stream starts.
    """
    stream = stream or sys.stderr
    path = getattr(opt, "stream_key_file", "") or ""
    if not path:
        if getattr(opt, "transport", "") == "rtmp":
            stream.write("ERROR LiveTalking RTMP output requires --stream_key_file\n")
            stream.flush()
            raise SystemExit(STREAM_KEY_FILE_EXIT_CODE)
        return opt
    try:
        key = load_stream_key(path)
    except StreamKeyFileError as error:
        stream.write(f"ERROR {error}\n")
        stream.flush()
        raise SystemExit(STREAM_KEY_FILE_EXIT_CODE) from None
    opt.push_url = join_push_url(opt.push_url, key)
    register_secret(key, opt.push_url)
    return opt


class StreamRedactor:
    """Byte-stream redaction for the launcher's stdout/stderr pumps.

    Keeps the last (longest secret - 1) bytes buffered so a secret split across
    reads is still replaced; secrets contain no line breaks, so everything up to
    the last line break can be released immediately.
    """

    def __init__(self, secrets: Iterable[str], max_buffer: int = 65536) -> None:
        self._secrets = sorted({secret.encode("utf-8") for secret in secrets if secret}, key=len, reverse=True)
        self._keep = max((len(secret) for secret in self._secrets), default=1) - 1
        self._max_buffer = max(max_buffer, self._keep + 1)
        self._replacement = REDACTED.encode("ascii")
        self._buffer = b""

    def _replace(self, data: bytes) -> bytes:
        for secret in self._secrets:
            data = data.replace(secret, self._replacement)
        return data

    def feed(self, chunk: bytes) -> bytes:
        data = self._replace(self._buffer + chunk)
        cut = max(data.rfind(b"\n"), data.rfind(b"\r")) + 1
        output, self._buffer = data[:cut], data[cut:]
        if len(self._buffer) > self._max_buffer:
            split = len(self._buffer) - self._keep
            output, self._buffer = output + self._buffer[:split], self._buffer[split:]
        return output

    def flush(self) -> bytes:
        data, self._buffer = self._replace(self._buffer), b""
        return data


class RedactingFormatter(logging.Formatter):
    """Wraps an existing formatter and redacts the complete formatted record, traceback included."""

    def __init__(self, inner: logging.Formatter | None = None) -> None:
        super().__init__()
        self._inner = inner or logging.Formatter()

    def format(self, record: logging.LogRecord) -> str:
        return redact_text(self._inner.format(record))

    def formatException(self, ei) -> str:  # noqa: N802 - logging API name
        return redact_text(self._inner.formatException(ei))


def install_log_redaction(loggers: Iterable[logging.Logger] = ()) -> None:
    for logger in [logging.getLogger(), *loggers]:
        for handler in logger.handlers:
            if not isinstance(handler.formatter, RedactingFormatter):
                handler.setFormatter(RedactingFormatter(handler.formatter))


def _redact_value(value):
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(item) for item in value)
    if isinstance(value, dict):
        return {key: _redact_value(item) for key, item in value.items()}
    return value


def redacted_options_dict(opt: argparse.Namespace) -> dict:
    """Copy of the parsed options safe for logs and /api/admin/config."""
    options = {}
    for key, value in vars(opt).items():
        options[key] = redact_push_url(value) if key == "push_url" and isinstance(value, str) else _redact_value(value)
    return options


def redacted_options(opt: argparse.Namespace) -> argparse.Namespace:
    return argparse.Namespace(**redacted_options_dict(opt))


def secret_redaction_middleware():
    """aiohttp middleware: redacts registered secrets from every response body and hides handler errors."""
    from aiohttp import web

    replacement = REDACTED.encode("ascii")

    @web.middleware
    async def middleware(request, handler):
        try:
            response = await handler(request)
        except web.HTTPException:
            raise
        except Exception as error:  # the message may contain the push URL
            logging.getLogger("shuzhiren_secrets").error("request %s failed: %s", request.path, type(error).__name__)
            return web.json_response({"code": -1, "msg": "internal error"}, status=500)
        if isinstance(response, web.Response):
            body = response.body
            if isinstance(body, (bytes, bytearray)) and body:
                redacted = bytes(body)
                for secret in registered_secrets():
                    redacted = redacted.replace(secret.encode("utf-8"), replacement)
                if redacted != body:
                    response.body = redacted
        return response

    return middleware
