"""PID 1 of the Shuzhiren LiveTalking image (audit H2, design Requirement 14).

Usage: python3 /opt/shuzhiren/launcher.py <command> [args...]
(the image ENTRYPOINT; the command comes from CMD or the Compose `command`).

1. When the command has --stream_key_file, the key file is validated first;
   a missing, unreadable, empty or malformed file exits with 78 before
   LiveTalking starts, so nothing listens or streams.
2. The command is started with the same argv and environment (the key is never
   added to either), stdin closed and stdout/stderr piped.
3. Both pipes are copied to the launcher's own stdout/stderr with every spelling
   of the key and the full push URL replaced, which also covers output written
   by native code (FFmpeg/python_rtmpstream) outside Python logging.
4. SIGTERM, SIGINT and SIGHUP are forwarded; the launcher exits with the child's
   status (128 + N when the child is killed by signal N).
5. When the command runs LiveTalking's app.py, the AIGC label configuration
   (AIGC_LABEL_* environment, CJK font, numpy and Pillow) is validated and a
   test frame is labelled first; a disabled, invalid or undrawable label exits
   with 78 before LiveTalking starts (shuzhiren_aigc_label.py). The patched
   LiveTalking checks the same configuration again in-process.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading

from shuzhiren_aigc_label import AIGC_LABEL_EXIT_CODE, AigcLabelError, AigcLabelRenderer, config_from_env
from shuzhiren_secrets import STREAM_KEY_FILE_EXIT_CODE, StreamKeyFileError, StreamRedactor, join_push_url, load_stream_key, secret_variants

DEFAULT_COMMAND = ["python3", "app.py"]


def option_value(args: list[str], name: str) -> str | None:
    """Last value of `name X` or `name=X` in args (argparse keeps the last occurrence)."""
    value = None
    for index, arg in enumerate(args):
        if arg == name and index + 1 < len(args):
            value = args[index + 1]
        elif arg.startswith(name + "="):
            value = arg[len(name) + 1:]
    return value


def pump(source, sink, redactor: StreamRedactor) -> None:
    try:
        while True:
            chunk = source.read1(65536)
            if not chunk:
                break
            output = redactor.feed(chunk)
            if output:
                sink.write(output)
                sink.flush()
    except (BrokenPipeError, ValueError):
        pass
    finally:
        tail = redactor.flush()
        try:
            if tail:
                sink.write(tail)
                sink.flush()
        except (BrokenPipeError, ValueError):
            pass
        source.close()


def runs_livetalking_app(args: list[str]) -> bool:
    """True when the command starts LiveTalking's server (an app.py argument), the only command that streams."""
    return any(os.path.basename(arg) == "app.py" for arg in args)


def main(argv: list[str]) -> int:
    command = argv or DEFAULT_COMMAND
    if runs_livetalking_app(command):
        try:
            label = AigcLabelRenderer(config_from_env()).config
        except AigcLabelError as error:
            sys.stderr.buffer.write(f"ERROR {error}\n".encode("utf-8"))
            sys.stderr.flush()
            return AIGC_LABEL_EXIT_CODE
        sys.stdout.buffer.write(f"INFO AIGC label enabled: text={label.text!r} position={label.position} font={os.path.basename(label.font_file or '')}\n".encode("utf-8"))
        sys.stdout.flush()
    secrets: list[str] = []
    key_file = option_value(command, "--stream_key_file")
    if key_file is not None:
        try:
            key = load_stream_key(key_file)
        except StreamKeyFileError as error:
            sys.stderr.write(f"ERROR {error}\n")
            sys.stderr.flush()
            return STREAM_KEY_FILE_EXIT_CODE
        push_url = option_value(command, "--push_url")
        secrets = secret_variants(key, join_push_url(push_url, key) if push_url else None)
        del key

    environment = dict(os.environ)
    environment["PYTHONUNBUFFERED"] = "1"
    try:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    except OSError as error:
        sys.stderr.write(f"ERROR cannot start {command[0]}: {type(error).__name__}\n")
        sys.stderr.flush()
        return 127

    def forward(signum, _frame) -> None:
        try:
            child.send_signal(signum)
        except ProcessLookupError:
            pass

    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), forward)

    pumps = [
        threading.Thread(target=pump, args=(child.stdout, sys.stdout.buffer, StreamRedactor(secrets)), daemon=True),
        threading.Thread(target=pump, args=(child.stderr, sys.stderr.buffer, StreamRedactor(secrets)), daemon=True),
    ]
    for thread in pumps:
        thread.start()
    try:
        status = child.wait()
    except BaseException:
        child.kill()
        child.wait()
        raise
    for thread in pumps:
        thread.join(timeout=5)
    return 128 - status if status < 0 else status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
