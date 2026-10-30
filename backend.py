"""Standalone CodeFlow backend.

The application deliberately keeps all user-program execution in short-lived
child processes.  FastAPI/uvicorn are used when present, while the same
handlers are available through the standard-library fallback server.
"""

from __future__ import annotations

import ast
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request as URLRequest, urlopen


BASE_DIR = Path(__file__).resolve().parent


def _load_dotenv() -> None:
    """Load CODEFLOW_* settings from a local .env file, if present.

    Environment variables already set take precedence (this never overrides
    them), so an explicit env var or platform setting wins over the file. This
    lets the AI key (and other tuning) be supplied by editing one file instead
    of rebuilding the start command with a secret inlined.
    """
    env_path = BASE_DIR / ".env"
    if not env_path.is_file():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip()
            # Strip a single pair of matching quotes.
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


_load_dotenv()
MAX_SOURCE_BYTES = 64 * 1024
MAX_STDIN_BYTES = 8 * 1024
MAX_REQUEST_BYTES = 128 * 1024
MAX_OUTPUT_BYTES = 16 * 1024
MAX_EVENTS = 500
MAX_VARIABLES = 100
MAX_STACK = 50
EXECUTION_TIMEOUT_SECONDS = 2.0
AI_TIMEOUT_SECONDS = 12.0
AI_MAX_RETRIES = 2
AI_BACKOFF_BASE = 1.5
MAX_AI_PROMPT_BYTES = 8 * 1024
MAX_AI_CONTEXT_ITEMS = 50
MAX_AI_ANSWER_BYTES = 16 * 1024
RESULT_FILE_LIMIT = 256 * 1024
RESULT_MARKER = "CodeFlow backend"


def _diagnostic(
    title: str,
    detail: str,
    *,
    line: int | None = None,
    column: int | None = None,
    kind: str = "error",
    **extra: Any,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "kind": kind,
        "title": title,
        "message": detail,
        "detail": detail,
    }
    if line is not None:
        item["line"] = line
    if column is not None:
        item["column"] = column
    item.update(extra)
    return item


SUPPORTED_LANGUAGES = {"python", "javascript", "java", "c", "cpp"}
LANGUAGE_ALIASES = {"js": "javascript", "c++": "cpp", "cxx": "cpp"}


def _stdin_of(payload: Any) -> str:
    """Program input supplied by the user, used for input()/cin/Scanner."""
    if not isinstance(payload, dict):
        return ""
    value = payload.get("stdin", "")
    if not isinstance(value, str):
        return ""
    return value[:MAX_STDIN_BYTES]


def _normalize_language(language: Any) -> str | None:
    if not isinstance(language, str):
        return None
    key = language.strip().lower()
    key = LANGUAGE_ALIASES.get(key, key)
    return key if key in SUPPORTED_LANGUAGES else None


def _validate_payload(payload: Any) -> tuple[str, str] | tuple[None, dict[str, Any]]:
    if not isinstance(payload, dict):
        return None, {"error": "Request body must be a JSON object."}
    language = _normalize_language(payload.get("language", "python"))
    source = payload.get("code", "")
    if language is None:
        return None, {"error": "language must be one of: python, javascript, java, c, cpp."}
    if not isinstance(source, str):
        return None, {"error": "code must be a string."}
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        return None, {
            "error": "Source exceeds the 64 KiB limit.",
            "limit": MAX_SOURCE_BYTES,
        }
    return language, source


def _split_output(value: str) -> list[str]:
    return value.splitlines() if value else []


def _read_limited(pipe: Any, limit: int) -> tuple[bytes, bool]:
    """Drain a child pipe without allowing unbounded output in this process."""
    data = bytearray()
    total = 0
    truncated = False
    while True:
        chunk = pipe.read(4096)
        if not chunk:
            break
        if len(data) < limit:
            remaining = limit - len(data)
            data.extend(chunk[:remaining])
        total += len(chunk)
        if total > limit:
            truncated = True
    return bytes(data), truncated


def _run_process(
    command: list[str],
    *,
    cwd: str,
    env: dict[str, str],
    timeout: float = EXECUTION_TIMEOUT_SECONDS,
    stdin_data: str | None = None,
    keep_stdin_open: bool = False,
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        return {
            "started": started,
            "returncode": None,
            "stdout": b"",
            "stderr": str(exc).encode("utf-8", "replace"),
            "stdout_truncated": False,
            "stderr_truncated": False,
            "spawn_error": str(exc),
        }

    if stdin_data is not None and process.stdin is not None:
        def feed() -> None:
            try:
                payload = stdin_data
                # When the pipe stays open, the last value must be terminated —
                # otherwise `cin >> n` keeps waiting to see whether the number
                # continues ("7" could still become "78") and looks like a block.
                if keep_stdin_open and not payload.endswith("\n"):
                    payload += "\n"
                process.stdin.write(payload.encode("utf-8"))
                process.stdin.flush()
                # Keeping the pipe open makes the next read block instead of
                # returning EOF, which is how we tell "needs more input" from
                # "finished with the input it had".
                if not keep_stdin_open:
                    process.stdin.close()
            except (OSError, ValueError):
                pass

        threading.Thread(target=feed, daemon=True).start()

    stdout_result: list[tuple[bytes, bool]] = []
    stderr_result: list[tuple[bytes, bool]] = []

    def drain(pipe: Any, destination: list[tuple[bytes, bool]]) -> None:
        destination.append(_read_limited(pipe, MAX_OUTPUT_BYTES))

    stdout_thread = threading.Thread(target=drain, args=(process.stdout, stdout_result), daemon=True)
    stderr_thread = threading.Thread(target=drain, args=(process.stderr, stderr_result), daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        process.wait()
    stdout_thread.join(timeout=1)
    stderr_thread.join(timeout=1)
    if process.stdout is not None:
        process.stdout.close()
    if process.stderr is not None:
        process.stderr.close()
    stdout = stdout_result[0] if stdout_result else (b"", False)
    stderr = stderr_result[0] if stderr_result else (b"", False)
    return {
        "started": started,
        "duration_ms": round((time.monotonic() - started) * 1000, 2),
        "returncode": process.returncode,
        "stdout": stdout[0],
        "stderr": stderr[0],
        "stdout_truncated": stdout[1],
        "stderr_truncated": stderr[1],
        "timed_out": timed_out,
    }


def _decode(value: bytes) -> str:
    return value.decode("utf-8", "replace")


def _bounded_text(value: str, limit: int = MAX_OUTPUT_BYTES) -> tuple[str, bool]:
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value, False
    return encoded[:limit].decode("utf-8", "replace"), True


PYTHON_RUNNER = r'''
import json
import math
import os
import re
import sys
import traceback

SOURCE_PATH = sys.argv[1]
RESULT_PATH = sys.argv[2]
SOURCE_NAME = "codeflow_user.py"
MAX_EVENTS = int(os.environ.get("CODEFLOW_MAX_EVENTS", "500"))
MAX_VARIABLES = int(os.environ.get("CODEFLOW_MAX_VARIABLES", "100"))
MAX_STACK = int(os.environ.get("CODEFLOW_MAX_STACK", "50"))
MAX_VALUE = 800


class LimitedText:
    def __init__(self, limit):
        self.limit = limit
        self.value = []
        self.size = 0
        self.truncated = False
        # Buffered output lines. CPython's print() writes the text and the
        # `end` string in two separate calls, so we accumulate and emit one
        # clean `stdout` trace event per completed output line instead of
        # polluting the timeline with a stray newline step.
        self._buf = ""
        self._meta = (1, "<module>", {}, list(stack[-MAX_STACK:]))

    def _record_frame(self):
        # Walk up the stack for the first frame belonging to the user's own
        # source file (print()/libraries sit between it and this write).
        frame = sys._getframe(1)
        while frame is not None:
            if frame.f_code.co_filename == SOURCE_NAME:
                self._meta = (
                    frame.f_lineno,
                    frame.f_code.co_name,
                    snapshot(frame.f_locals),
                    list(stack[-MAX_STACK:]),
                )
                return
            frame = frame.f_back

    def _emit(self, text):
        if len(events) >= MAX_EVENTS:
            return
        line, function, variables, call_stack = self._meta
        events.append({
            "sequence": len(events),
            "type": "stdout",
            "line": line,
            "function": function,
            "output": text,
            "variables": variables,
            "call_stack": call_stack,
        })

    def write(self, text):
        text = str(text)
        remaining = self.limit - self.size
        if remaining > 0:
            self.value.append(text[:remaining])
            self.size += min(len(text), remaining)
        if len(text) > remaining:
            self.truncated = True
        # Record a trace event for each completed output line so the voice
        # lesson (and the per-event output panel) can attribute printed text to
        # the line that produced it.
        if text and len(events) < MAX_EVENTS:
            self._record_frame()
            self._buf += text
            while "\n" in self._buf and len(events) < MAX_EVENTS:
                line_text, self._buf = self._buf.split("\n", 1)
                self._emit(line_text + "\n")
        return len(text)

    def flush_stdout_events(self):
        # Emit any output still buffered when the program ends (e.g. print()
        # with end="" leaves text with no trailing newline).
        if self._buf and len(events) < MAX_EVENTS:
            self._emit(self._buf)
            self._buf = ""

    def flush(self):
        return None

    def isatty(self):
        return False

    def getvalue(self):
        return "".join(self.value)


def safe_value(value, depth=0):
    if depth > 3:
        return "<nested>"
    if value is None or isinstance(value, (bool, int, float, str)):
        # JSON has no Infinity or NaN. Python happily writes them, and the
        # browser's JSON.parse then rejects the whole response — one
        # `float("-inf")` in an otherwise fine program killed the entire trace
        # (and with it the animation). Send them as text instead.
        if isinstance(value, float) and not math.isfinite(value):
            if math.isnan(value):
                return "nan"
            return "inf" if value > 0 else "-inf"
        if isinstance(value, str) and len(value) > MAX_VALUE:
            return value[:MAX_VALUE] + "…"
        return value
    if isinstance(value, (list, tuple, set)):
        return [safe_value(item, depth + 1) for item in list(value)[:30]]
    if isinstance(value, dict):
        return {str(key)[:80]: safe_value(item, depth + 1) for key, item in list(value.items())[:30]}
    # An object's attributes are its state. Reporting "<__main__.Counter
    # object>" gave the animated stage nothing to draw for a class-based
    # program, and the variables panel nothing to read.
    try:
        attributes = getattr(value, "__dict__", None)
    except Exception:
        attributes = None
    if isinstance(attributes, dict) and depth < 3:
        fields = {}
        for name, item in list(attributes.items())[:12]:
            if str(name).startswith("_"):
                continue
            fields[str(name)[:40]] = safe_value(item, depth + 1)
        if fields:
            return fields
    try:
        text = re.sub(r" at 0x[0-9a-fA-F]+", "", repr(value))
    except Exception:
        text = "<unrepresentable>"
    return text[:MAX_VALUE]


def snapshot(values):
    result = {}
    for key, value in list(values.items())[:MAX_VARIABLES]:
        if not str(key).startswith("__"):
            result[str(key)] = safe_value(value)
    return result


events = []
stack = []
events_truncated = False
pending_exceptions = set()


def trace(frame, event, arg):
    global events_truncated
    if frame.f_code.co_filename != SOURCE_NAME:
        return trace
    function = frame.f_code.co_name
    frame_key = id(frame)
    if event == "call":
        if len(stack) < MAX_STACK:
            stack.append(function)
    elif event == "line":
        # A line event means the frame kept running, so any pending exception
        # was handled rather than propagating out of it.
        pending_exceptions.discard(frame_key)
    if event in ("call", "line", "return", "exception"):
        line = frame.f_lineno
        # The module-level call fires before any source line exists, so it
        # reports f_lineno 0 and would render as "line 0" in the UI.
        skip = event == "call" and line <= 0
        if skip:
            pass
        elif len(events) < MAX_EVENTS:
            item = {
                "sequence": len(events),
                "type": event,
                "line": line,
                "function": function,
                "variables": snapshot(frame.f_locals),
                "call_stack": list(stack[-MAX_STACK:]),
            }
            if event == "exception" and isinstance(arg, tuple) and len(arg) > 1:
                item["exception"] = str(arg[1])[:MAX_VALUE]
                pending_exceptions.add(frame_key)
            if event == "return":
                if frame_key in pending_exceptions:
                    item["unwound"] = True
                    item["return_value"] = None
                else:
                    item["return_value"] = safe_value(arg)
            events.append(item)
        else:
            events_truncated = True
    if event == "return":
        pending_exceptions.discard(frame_key)
        if stack:
            stack.pop()
    return trace


stdout_capture = LimitedText(16384)
stderr_capture = LimitedText(16384)
real_stdout = sys.stdout
real_stderr = sys.stderr
sys.stdout = stdout_capture
sys.stderr = stderr_capture
namespace = {"__name__": "__main__"}
metadata = {
    "status": "completed",
    "diagnostics": [],
    "events": events,
    "variables": {},
    "call_stack": [],
    "events_truncated": False,
}
try:
    with open(SOURCE_PATH, "r", encoding="utf-8") as source_file:
        source = source_file.read()
    try:
        compiled = compile(source, SOURCE_NAME, "exec")
    except SyntaxError as exc:
        metadata["status"] = "error"
        metadata["diagnostics"] = [{
            "kind": "syntax",
            "title": "SyntaxError",
            "message": str(exc.msg),
            "detail": str(exc.msg),
            "line": exc.lineno,
            "column": exc.offset,
            "end_line": getattr(exc, "end_lineno", None),
            "end_column": getattr(exc, "end_offset", None),
        }]
    else:
        sys.settrace(trace)
        try:
            exec(compiled, namespace, namespace)
        except BaseException as exc:
            metadata["status"] = "error"
            frames = traceback.extract_tb(exc.__traceback__)
            user_frame = next((item for item in reversed(frames) if item.filename == SOURCE_NAME), None)
            metadata["diagnostics"] = [{
                "kind": "runtime",
                "title": type(exc).__name__,
                "message": str(exc) or type(exc).__name__,
                "detail": str(exc) or type(exc).__name__,
                "line": user_frame.lineno if user_frame else None,
                "column": None,
            }]
        finally:
            sys.settrace(None)
finally:
    stdout_capture.flush_stdout_events()
    sys.stdout = real_stdout
    sys.stderr = real_stderr
metadata["events"] = events
metadata["events_truncated"] = events_truncated
metadata["variables"] = snapshot(namespace)
metadata["call_stack"] = list(stack[-MAX_STACK:])
metadata["stdout"] = stdout_capture.getvalue()
metadata["stderr"] = stderr_capture.getvalue()
metadata["stdout_truncated"] = stdout_capture.truncated
metadata["stderr_truncated"] = stderr_capture.truncated
with open(RESULT_PATH, "w", encoding="utf-8") as result_file:
    json.dump(metadata, result_file, ensure_ascii=False)
'''


def _python_result_from_child(child: dict[str, Any], result_path: Path) -> dict[str, Any]:
    stdout = _decode(child["stdout"])
    stderr = _decode(child["stderr"])
    if child.get("timed_out"):
        return {
            "status": "timeout",
            "language": "python",
            "output": _split_output(stdout),
            "stdout": stdout,
            "stderr": stderr,
            "variables": {},
            "events": [],
            "call_stack": [],
            "diagnostics": [_diagnostic(
                "Execution timed out",
                f"Python execution exceeded the {EXECUTION_TIMEOUT_SECONDS:g}-second limit.",
                kind="timeout",
            )],
        }
    metadata: dict[str, Any] = {}
    try:
        if result_path.exists() and result_path.stat().st_size <= RESULT_FILE_LIMIT:
            metadata = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        metadata = {}
    if not metadata:
        message = stderr.strip() or "Python worker did not return a result."
        return {
            "status": "error",
            "language": "python",
            "output": _split_output(stdout),
            "stdout": stdout,
            "stderr": stderr,
            "variables": {},
            "events": [],
            "call_stack": [],
            "diagnostics": [_diagnostic("Python worker error", message)],
        }
    diagnostics = metadata.get("diagnostics") or []
    stdout = metadata.get("stdout", stdout)
    stderr = metadata.get("stderr", stderr)
    stdout, stdout_text_truncated = _bounded_text(stdout)
    stderr, stderr_text_truncated = _bounded_text(stderr)
    if child.get("returncode") not in (0, None) and not diagnostics:
        diagnostics = [_diagnostic("Python worker error", stderr.strip() or "The worker exited unexpectedly.")]
    return {
        "status": metadata.get("status", "error"),
        "language": "python",
        "output": _split_output(stdout),
        "stdout": stdout,
        "stderr": stderr,
        "variables": metadata.get("variables", {}),
        "events": metadata.get("events", []),
        "trace": metadata.get("events", []),
        "call_stack": metadata.get("call_stack", []),
        "diagnostics": diagnostics,
        "limits": {
            "source_bytes": MAX_SOURCE_BYTES,
            "output_bytes": MAX_OUTPUT_BYTES,
            "events": MAX_EVENTS,
            "stdout_truncated": bool(child.get("stdout_truncated") or metadata.get("stdout_truncated") or stdout_text_truncated),
            "stderr_truncated": bool(child.get("stderr_truncated") or metadata.get("stderr_truncated") or stderr_text_truncated),
            "events_truncated": bool(metadata.get("events_truncated")),
        },
    }


def execute_python(source: str, stdin_text: str = "") -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="codeflow-python-") as workdir:
        work = Path(workdir)
        source_path = work / "source.py"
        result_path = work / "result.json"
        source_path.write_text(source, encoding="utf-8")
        env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONIOENCODING": "utf-8",
            "CODEFLOW_MAX_EVENTS": str(MAX_EVENTS),
            "CODEFLOW_MAX_VARIABLES": str(MAX_VARIABLES),
            "CODEFLOW_MAX_STACK": str(MAX_STACK),
        }
        child = _run_process(
            [sys.executable, "-I", "-S", "-c", PYTHON_RUNNER, str(source_path), str(result_path)],
            cwd=workdir,
            env=env,
            stdin_data=stdin_text if stdin_text else "",
        )
        result = _python_result_from_child(child, result_path)
        result["duration_ms"] = round((time.monotonic() - child["started"]) * 1000, 2)
        return result




def _node_command() -> str | None:
    return shutil.which("node") or shutil.which("nodejs")


def execute_javascript(source: str, stdin_text: str = "") -> dict[str, Any]:
    """JavaScript: run under Node with an inspector session recording every line."""
    node = _node_command()
    if not node:
        return _unsupported("javascript", "Node.js is not installed or is not available on PATH.")
    tracer = BASE_DIR / "js_tracer.js"
    if not tracer.exists():
        return _unsupported("javascript", "The JavaScript tracer (js_tracer.js) is missing from this installation.")
    with tempfile.TemporaryDirectory(prefix="codeflow-javascript-") as workdir:
        work = Path(workdir)
        source_path = work / "source.js"
        result_path = work / "trace.json"
        source_path.write_text(source, encoding="utf-8")
        env = {"PATH": os.environ.get("PATH", ""), "NODE_NO_WARNINGS": "1", "CODEFLOW_MAX_EVENTS": str(MAX_EVENTS)}
        child = _run_process(
            [node, str(tracer), str(source_path), str(result_path)],
            cwd=workdir,
            env=env,
            timeout=DEBUG_RUN_TIMEOUT_SECONDS,
            stdin_data=stdin_text,
        )
        stdout = _decode(child["stdout"])
        stderr = _decode(child["stderr"])
        events, truncated = _read_trace(result_path)

        if child.get("timed_out"):
            return _empty_result("javascript", "timeout", [_diagnostic(
                "Execution timed out",
                f"JavaScript execution exceeded the {DEBUG_RUN_TIMEOUT_SECONDS:g}-second limit.",
                kind="timeout",
            )], output=_split_output(stdout), stdout=stdout, events=events, trace=events)

        payload: dict[str, Any] = {}
        try:
            if result_path.exists() and result_path.stat().st_size <= RESULT_FILE_LIMIT:
                loaded = json.loads(result_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    payload = loaded
        except (OSError, ValueError, json.JSONDecodeError):
            payload = {}

        if not payload:
            return _empty_result("javascript", "error", [_diagnostic(
                "Node worker error",
                stderr.strip()[:800] or "Node.js did not return a trace.",
                kind="runtime",
            )], output=_split_output(stdout), stdout=stdout, stderr=stderr)

        program_output = payload.get("stdout") if isinstance(payload.get("stdout"), str) else stdout
        program_errors = payload.get("stderr") if isinstance(payload.get("stderr"), str) else ""
        truncated = truncated or bool(payload.get("truncated"))

        diagnostics: list[dict[str, Any]] = []
        failure = payload.get("error")
        if isinstance(failure, dict):
            diagnostics.append(_diagnostic(
                str(failure.get("title") or "Error"),
                str(failure.get("message") or "The program stopped with an error."),
                line=failure.get("line") if isinstance(failure.get("line"), int) else None,
                kind=str(failure.get("kind") or "runtime"),
            ))

        variables, stack = _tail_variables(events)
        result = _empty_result(
            "javascript",
            "completed" if not diagnostics else "error",
            diagnostics,
            output=_split_output(program_output),
            stdout=program_output,
            stderr=program_errors or stderr,
            variables=variables,
            events=events,
            trace=events,
            call_stack=stack,
        )
        result["limits"]["events_truncated"] = truncated or len(events) >= MAX_EVENTS
        return result


COMPILE_TIMEOUT_SECONDS = 30.0
DEBUG_RUN_TIMEOUT_SECONDS = 20.0
# Compiled languages read stdin from a file, so a program waiting for input gets
# EOF immediately and then runs on with uninitialised values until the full
# 20-second limit. When the source reads input we use a much shorter window: a
# program that is still running after it has had time to print its prompt is
# waiting for input, not computing. Returning early keeps the terminal
# interactive instead of showing a bogus "execution timed out".
INPUT_WAIT_PROBE_SECONDS = 2.0
NATIVE_COMPILERS = {"c": ("clang", "gcc"), "cpp": ("clang++", "g++")}
NATIVE_EXTENSIONS = {"c": ".c", "cpp": ".cpp"}
NATIVE_STANDARDS = {"c": "-std=c11", "cpp": "-std=c++17"}

_INPUT_READ_PATTERNS = {
    "python": r"\binput\s*\(",
    "javascript": r"\breadline\b|\bprompt\s*\(|\bprocess\.stdin\b",
    "java": r"\bScanner\b|\bSystem\.in\b|\bBufferedReader\b|\breadLine\s*\(",
    "c": r"\bscanf\s*\(|\bgetchar\s*\(|\bgets\s*\(|\bfgets\s*\(|\bgetline\s*\(|\bfread\s*\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*stdin",
    "cpp": r"\bcin\b|\bscanf\s*\(|\bgetchar\s*\(|\bgets\s*\(|\bfgets\s*\(|\bgetline\s*\(|\bstd::cin\b",
}


def _source_reads_input(source: str, language: str) -> bool:
    """Whether the program is likely to block on stdin.

    Used only to choose a shorter timeout and to label a run as "waiting for
    input" instead of a 20-second timeout — never to refuse to run anything.
    """
    pattern = _INPUT_READ_PATTERNS.get(language)
    if not pattern:
        return False
    try:
        return re.search(pattern, source or "") is not None
    except re.error:
        return False

_JAVA_TRACER_DIR: str | None = None
_JAVA_TRACER_LOCK = threading.Lock()

# C++ compile-flag variants to probe for, in order. Some sandboxes ship a C++
# compiler without libstdc++ headers, or only libc++ — probe once, then reuse.
_CPP_FLAG_VARIANTS: tuple[tuple[str, ...], ...] = (
    (),
    ("-stdlib=libc++",),
    ("-stdlib=libstdc++",),
)
_CPP_FLAGS_CACHE: dict[str, tuple[str, ...] | None] = {}
_CPP_FLAGS_LOCK = threading.Lock()


def _cpp_compile_flags(compiler: str) -> tuple[str, ...] | None:
    """Return the C++ stdlib flags that actually compile <iostream> here, or None.

    Result is cached per compiler, so the probe runs at most once per process.
    """
    with _CPP_FLAGS_LOCK:
        if compiler in _CPP_FLAGS_CACHE:
            return _CPP_FLAGS_CACHE[compiler]
    result: tuple[str, ...] | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="codeflow-cppflags-") as workdir:
            src = Path(workdir) / "probe.cpp"
            src.write_text(
                "#include <iostream>\n#include <string>\n#include <vector>\n"
                "int main(){ std::vector<std::string> v{\"ok\"}; std::cout << v[0]; return 0; }\n",
                encoding="utf-8",
            )
            for extra in _CPP_FLAG_VARIANTS:
                res = _run_process(
                    [compiler, "-fsyntax-only", *extra, str(src)],
                    cwd=workdir, env=os.environ.copy(), timeout=30,
                )
                if res.get("returncode") == 0:
                    result = extra
                    break
    except Exception:
        result = None
    with _CPP_FLAGS_LOCK:
        _CPP_FLAGS_CACHE[compiler] = result
    return result


def _native_extra_flags(language: str, compiler: str) -> list[str]:
    """Extra compile/flags needed to make the language build in this environment."""
    if language == "cpp":
        return list(_cpp_compile_flags(compiler) or ())
    return []


def _first_available(candidates: tuple[str, ...]) -> str | None:
    for candidate in candidates:
        path = shutil.which(candidate)
        if path:
            return path
    return None


def _lldb_debugger() -> str | None:
    """Locate an LLDB driver. Some images ship only versioned names (lldb-14 …)."""
    lldb = shutil.which("lldb")
    if lldb:
        return lldb
    for name in ("lldb-20", "lldb-19", "lldb-18", "lldb-17", "lldb-16", "lldb-15", "lldb-14"):
        path = shutil.which(name)
        if path:
            return path
    return None


def _ensure_lldb_server_names() -> None:
    """Create the exact lldb-server-<version> names lldb looks for.

    The driver locates its server next to its own binary (not via PATH), and many
    images ship the server only as lldb-server-18 while lldb-18.1.3 asks for
    lldb-server-18.1.3 — producing 'unable to locate lldb-server-18.1.3'.
    Cross-link the servers we do have under every name the driver may want.
    """
    try:
        server_paths: list[str] = []
        for pattern in ("/usr/lib/llvm-*/bin/lldb-server*", "/usr/bin/lldb-server*",
                        "/usr/local/bin/lldb-server*", "/opt/*/bin/lldb-server*"):
            server_paths.extend(sorted(glob.glob(pattern)))
        if not server_paths:
            return
        names: set[str] = {"lldb-server"}
        targets: list[str] = []
        for path in server_paths:
            real = os.path.realpath(path)
            if os.path.isfile(real):
                if real not in targets:
                    targets.append(real)
                names.add(os.path.basename(path))
        if not targets:
            return
        lldb = _lldb_debugger()
        if lldb:
            try:
                res = _run_process([lldb, "--version"], env=os.environ.copy(), timeout=20)
                match = re.search(r"(\d+\.\d+\.\d+)", _decode(res["stdout"]) + _decode(res["stderr"]))
                if match:
                    names.add("lldb-server-" + match.group(1))
            except Exception:
                pass
        directories = {os.path.dirname(p) for p in server_paths}
        directories.update({"/usr/bin", "/usr/local/bin"})
        if lldb:
            directories.add(os.path.dirname(lldb))
        for directory in directories:
            for name in sorted(names):
                if not name.startswith("lldb-server"):
                    continue
                link = os.path.join(directory, name)
                if os.path.lexists(link):
                    continue
                major = None
                match = re.match(r"lldb-server-(\d+)", name)
                if match:
                    major = match.group(1)
                chosen = None
                if major:
                    for target in targets:
                        if re.search(rf"(llvm-{major}(?:\.\d+)*/|lldb-server-{major}(?:\.\d+)*$)", target):
                            chosen = target
                            break
                if chosen is None:
                    chosen = targets[0]
                try:
                    os.symlink(chosen, link)
                except OSError:
                    pass
    except Exception:
        pass


def _lldb_server_path() -> str | None:
    """Path to a real lldb-server executable, for LLDB_DEBUGSERVER_PATH.

    On Linux x86-64 the driver resolves the server relative to its own shared
    library and that lookup can fail even when the server sits right next to it
    ('unable to locate lldb-server-18.1.3'). LLDB_DEBUGSERVER_PATH overrides the
    search entirely, so hand it the first genuine server binary we can find.
    """
    for pattern in ("/usr/lib/llvm-*/bin/lldb-server-*.", "/usr/lib/llvm-*/bin/lldb-server",
                    "/usr/local/llvm*/bin/lldb-server", "/opt/*/bin/lldb-server"):
        for path in sorted(glob.glob(pattern)):
            real = os.path.realpath(path)
            if os.path.isfile(real) and os.access(real, os.X_OK):
                return real
    return None


def _native_compiler(language: str) -> str | None:
    """First available compiler for the language that can actually compile it.

    Some sandboxes ship clang++ without the libstdc++ headers while g++ has them,
    so binary presence alone is not enough for C++ — probe and prefer one that works.
    """
    found = [path for name in NATIVE_COMPILERS[language] if (path := shutil.which(name))]
    if language != "cpp":
        return found[0] if found else None
    for path in found:
        if _cpp_compile_flags(path) is not None:
            return path
    return found[0] if found else None


def _quote(value: str) -> str:
    return '"' + value.replace('"', '\\"') + '"'


def _empty_result(language: str, status: str, diagnostics: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": status,
        "language": language,
        "output": [],
        "stdout": "",
        "stderr": "",
        "variables": {},
        "events": [],
        "trace": [],
        "call_stack": [],
        "diagnostics": diagnostics,
        "limits": {"source_bytes": MAX_SOURCE_BYTES, "output_bytes": MAX_OUTPUT_BYTES, "events": MAX_EVENTS},
    }
    result.update(extra)
    return result


def _unsupported(language: str, detail: str) -> dict[str, Any]:
    return _empty_result(
        language,
        "unsupported",
        [_diagnostic("Toolchain unavailable", detail, kind="unsupported")],
        supported=False,
    )


def _waiting_for_input(language: str, program_output: str, events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The program printed its prompt and stopped, so it needs more input.

    Status "waiting" (plus the ``waiting_for_input`` flag) tells the client to
    keep the session alive and show the prompt — the same contract Python
    already gets for free from its EOFError.
    """
    result = _empty_result(
        language,
        "waiting",
        [],
        output=_split_output(program_output),
        stdout=program_output,
        events=events or [],
        trace=events or [],
    )
    result["waiting_for_input"] = True
    return result


def _parse_compile_errors(text: str, language: str) -> list[dict[str, Any]]:
    """Turn gcc/clang/javac output into located diagnostics."""
    diagnostics: list[dict[str, Any]] = []
    pattern = re.compile(
        r"^(?P<file>[^\s:]+):(?P<line>\d+):(?:(?P<column>\d+):)?\s*(?:fatal\s+)?error:\s*(?P<message>.+)$",
        re.MULTILINE,
    )
    for match in pattern.finditer(text):
        diagnostics.append(_diagnostic(
            "CompileError",
            match.group("message").strip(),
            line=int(match.group("line")),
            column=int(match.group("column")) if match.group("column") else None,
            kind="syntax",
        ))
        if len(diagnostics) >= 5:
            break
    if diagnostics:
        return diagnostics
    cleaned = text.strip()
    return [_diagnostic(
        "Compilation failed",
        cleaned[:800] or f"The {language} compiler rejected this source.",
        kind="syntax",
    )]


def _read_text(path: Path, limit: int = MAX_OUTPUT_BYTES) -> str:
    try:
        if path.exists() and path.stat().st_size <= limit:
            return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        pass
    return ""


def _read_trace(path: Path) -> tuple[list[dict[str, Any]], bool]:
    try:
        if path.exists() and path.stat().st_size <= RESULT_FILE_LIMIT:
            payload = json.loads(path.read_text(encoding="utf-8"))
            events = payload.get("events") if isinstance(payload, dict) else None
            if isinstance(events, list):
                return [event for event in events if isinstance(event, dict)], bool(payload.get("truncated"))
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    return [], False


def _tail_variables(events: list[dict[str, Any]]) -> tuple[dict[str, Any], list[Any]]:
    for event in reversed(events):
        variables = event.get("variables")
        if isinstance(variables, dict) and variables:
            return variables, event.get("call_stack") or []
    return {}, []


def execute_native(source: str, language: str, stdin_text: str = "") -> dict[str, Any]:
    """C and C++: compile with debug info, then step the binary under lldb."""
    compiler = _native_compiler(language)
    if not compiler:
        return _unsupported(language, f"No {language} compiler (clang or gcc) was found on PATH.")
    debugger = _lldb_debugger()
    if not debugger:
        # No LLDB in this environment: fall back to a plain compile-and-run so the
        # program still executes and prints output — just without line-by-line stepping.
        return _compile_and_run_native(language, source, stdin_text, compiler)
    tracer = BASE_DIR / "lldb_tracer.py"
    if not tracer.exists():
        return _compile_and_run_native(language, source, stdin_text, compiler)

    # lldb feeds stdin from a *file*, so a program that needs input never blocks:
    # it reads EOF immediately and carries on with uninitialised values, usually
    # until the 20-second limit. Probe input-reading programs in a plain run
    # first: if one blocks, the session is waiting for input; if it finishes, the
    # input was enough and the traced run below can go ahead.
    if _source_reads_input(source, language):
        probe = _compile_and_run_native(language, source, stdin_text, compiler, probe_only=True)
        if probe is not None:
            return probe

    with tempfile.TemporaryDirectory(prefix=f"codeflow-{language}-") as workdir:
        work = Path(workdir)
        source_path = work / ("main" + NATIVE_EXTENSIONS[language])
        executable = work / "program"
        source_path.write_text(source, encoding="utf-8")

        compile_command = [
            compiler, "-g", "-O0", NATIVE_STANDARDS[language],
            *_native_extra_flags(language, compiler),
            "-o", str(executable), str(source_path),
        ]
        compiled = _run_process(
            compile_command, cwd=workdir, env=os.environ.copy(), timeout=COMPILE_TIMEOUT_SECONDS,
        )
        compile_text = _decode(compiled["stderr"]) + _decode(compiled["stdout"])
        if compiled.get("returncode") != 0:
            return _empty_result(language, "error", _parse_compile_errors(compile_text, language),
                                 stderr=_decode(compiled["stderr"])[:MAX_OUTPUT_BYTES])

        stdout_path = work / "stdout.txt"
        stderr_path = work / "stderr.txt"
        trace_path = work / "trace.json"
        stdin_path = work / "stdin.txt"
        stdin_path.write_text(stdin_text, encoding="utf-8")
        commands = [
            "settings set target.output-path " + _quote(str(stdout_path)),
            "settings set target.error-path " + _quote(str(stderr_path)),
            "settings set target.input-path " + _quote(str(stdin_path)),
            # Skip the personality(ADDR_NO_RANDOMIZE) syscall blocked by some sandboxes.
            "settings set target.disable-aslr false",
            "command script import " + _quote(str(tracer)),
            "codeflow_trace " + _quote(str(source_path)) + " " + _quote(str(trace_path)),
        ]
        debugger_command = [debugger, "--batch", "--no-lldbinit"]
        for command in commands:
            debugger_command += ["-o", command]
        debugger_command += ["--", str(executable)]

        # The driver looks for its server next to itself: make sure the exact
        # lldb-server-<version> name exists before launching.
        _ensure_lldb_server_names()

        # Give the driver (and the server it spawns) the full environment plus the
        # LLVM trees on PATH / LD_LIBRARY_PATH so liblldb and a versioned
        # lldb-server are both findable.
        lldb_env = os.environ.copy()
        lldb_env["CODEFLOW_MAX_EVENTS"] = str(MAX_EVENTS)
        llvm_dirs: list[str] = []
        for pattern in ("/usr/lib/llvm-*/bin", "/usr/local/llvm*/bin"):
            llvm_dirs.extend(sorted(glob.glob(pattern)))
        if llvm_dirs:
            lldb_env["PATH"] = os.pathsep.join([d for d in dict.fromkeys(llvm_dirs) if d] + [lldb_env.get("PATH", "")])
            extra_lib = []
            for pattern in ("/usr/lib/llvm-*/lib", "/usr/local/llvm*/lib"):
                extra_lib.extend(sorted(glob.glob(pattern)))
            if extra_lib:
                existing = lldb_env.get("LD_LIBRARY_PATH", "")
                lldb_env["LD_LIBRARY_PATH"] = os.pathsep.join(extra_lib + ([existing] if existing else []))

        # On Linux x86-64 the driver cannot always resolve its own shared-library
        # location, so it never finds the lldb-server sitting right next to it
        # ("unable to locate lldb-server"). LLDB supports an explicit override —
        # LLDB_DEBUGSERVER_PATH — read at launch time; point it at the real server
        # binary when one exists. (Documented for exactly this purpose by the
        # Android NDK/LLDB docs.)
        server_path = _lldb_server_path()
        if server_path:
            lldb_env["LLDB_DEBUGSERVER_PATH"] = server_path

        child = _run_process(
            debugger_command,
            cwd=workdir,
            env=lldb_env,
            timeout=DEBUG_RUN_TIMEOUT_SECONDS,
        )
        debugger_log = _decode(child["stdout"]) + _decode(child["stderr"])
        program_output = _read_text(stdout_path)
        program_errors = _read_text(stderr_path)
        events, truncated = _read_trace(trace_path)

        if child.get("timed_out"):
            return _empty_result(language, "timeout", [_diagnostic(
                "Execution timed out",
                f"{language} execution exceeded the {DEBUG_RUN_TIMEOUT_SECONDS:g}-second limit.",
                kind="timeout",
            )], output=_split_output(program_output), stdout=program_output, events=events, trace=events)

        # The debugger itself failed (e.g. "unable to locate lldb-server"): never fail
        # the language because of the tracer — re-run without debugging so the program
        # still executes and shows output.
        # The debugger itself failed (e.g. "unable to locate lldb-server", or its
        # embedded Python could not import the tracer): never fail the language
        # because of the tracer — re-run without debugging so the program still
        # executes and shows output.
        debugger_broken = re.search(
            r"(?im)^\s*error:|traceback|no module named|importerror|scripting bridge",
            debugger_log,
        )
        if not events and not program_output and debugger_broken:
            fallback = _compile_and_run_native(language, source, stdin_text, compiler)
            log_tail = debugger_log.strip()[-300:]
            # Replace the helper's generic note with the specific debugger failure.
            diags = [d for d in fallback.get("diagnostics", [])
                     if "Stepping unavailable" not in str(d.get("title", ""))]
            diags.append(_diagnostic(
                "Stepping unavailable (debugger failed)",
                "The debugger could not run the program on this server, so it was executed without line-by-line stepping."
                + (f" Debugger log: {log_tail}" if log_tail else ""),
                kind="unsupported",
            ))
            fallback["diagnostics"] = diags
            return fallback

        diagnostics: list[dict[str, Any]] = []
        crash = re.search(r"stop reason = (signal SIG\w+|EXC_BAD_ACCESS|EXC_BAD_INSTRUCTION)", debugger_log)
        if crash:
            diagnostics.append(_diagnostic(
                "Runtime crash",
                f"The program stopped on {crash.group(1)}.",
                kind="runtime",
            ))
        elif "exited with status = " in debugger_log:
            status_match = re.search(r"exited with status = (\d+)", debugger_log)
            if status_match and status_match.group(1) != "0" and not events:
                diagnostics.append(_diagnostic(
                    "Program exited abnormally",
                    f"The program exited with status {status_match.group(1)}.",
                    kind="runtime",
                ))
        if not events and not diagnostics:
            diagnostics.append(_diagnostic(
                "Nothing to step through",
                "The program ran to completion but contained no executable lines to trace.",
                kind="unsupported",
            ))

        variables, stack = _tail_variables(events)
        result = _empty_result(
            language,
            "completed" if not any(d.get("kind") != "unsupported" for d in diagnostics) else "error",
            diagnostics,
            output=_split_output(program_output),
            stdout=program_output,
            stderr=program_errors,
            variables=variables,
            events=events,
            trace=events,
            call_stack=stack,
        )
        result["limits"]["events_truncated"] = truncated or len(events) >= MAX_EVENTS
        return result


def _compile_and_run_native(
    language: str,
    source: str,
    stdin_text: str,
    compiler: str,
    probe_only: bool = False,
) -> dict[str, Any] | None:
    """Compile and run C/C++ without a debugger (no line-by-line stepping).

    Used when LLDB is unavailable — e.g. the published sandbox has a compiler but not the
    debugger. The program still runs and its output is returned, so the language works; the
    user simply does not get a step-by-step trace for it here.

    With ``probe_only`` it answers a single question — "is this program blocked waiting for
    input?" — and returns None when it is not.
    """
    with tempfile.TemporaryDirectory(prefix=f"codeflow-{language}-") as workdir:
        work = Path(workdir)
        source_path = work / ("main" + NATIVE_EXTENSIONS[language])
        executable = work / "program"
        source_path.write_text(source, encoding="utf-8")

        compiled = _run_process(
            [compiler, NATIVE_STANDARDS[language], "-O0",
             *_native_extra_flags(language, compiler),
             "-o", str(executable), str(source_path)],
            cwd=workdir, env=os.environ.copy(), timeout=COMPILE_TIMEOUT_SECONDS,
        )
        compile_text = _decode(compiled["stderr"]) + _decode(compiled["stdout"])
        if compiled.get("returncode") != 0:
            return _empty_result(
                language, "error", _parse_compile_errors(compile_text, language),
                stderr=_decode(compiled["stderr"])[:MAX_OUTPUT_BYTES],
            )

        reads_input = _source_reads_input(source, language)
        if reads_input:
            # Keep stdin open so the next read blocks: a program that still has
            # input left finishes, one that needs more waits here and is cut off
            # by the short probe. That is the only reliable "needs input" signal
            # — with a closed pipe the program just reads EOF and runs on with
            # uninitialised values.
            run = _run_process(
                [str(executable)], cwd=workdir, env=os.environ.copy(),
                timeout=INPUT_WAIT_PROBE_SECONDS, stdin_data=stdin_text,
                keep_stdin_open=True,
            )
            if run.get("timed_out"):
                return _waiting_for_input(language, _decode(run["stdout"]))
            if probe_only:
                return None
        else:
            run = _run_process(
                [str(executable)], cwd=workdir, env=os.environ.copy(),
                timeout=DEBUG_RUN_TIMEOUT_SECONDS, stdin_data=stdin_text,
            )
        program_output = _decode(run["stdout"])
        program_errors = _decode(run["stderr"])
        diagnostics: list[dict[str, Any]] = []
        status = "completed"
        if run.get("timed_out"):
            diagnostics.append(_diagnostic(
                "Execution timed out",
                f"{language} execution exceeded the {DEBUG_RUN_TIMEOUT_SECONDS:g}-second limit.",
                kind="timeout",
            ))
            status = "error"
        elif run.get("returncode") not in (0, None):
            diagnostics.append(_diagnostic(
                "Program exited abnormally",
                f"The program exited with status {run.get('returncode')}.",
                kind="runtime",
            ))
            status = "error"
        # Informational only: the program ran, but line-by-line stepping is off without LLDB.
        diagnostics.append(_diagnostic(
            "Stepping unavailable (no debugger)",
            "LLDB is not installed here, so line-by-line stepping is disabled — the final program output is still shown.",
            kind="unsupported",
        ))
        return _empty_result(
            language,
            status,
            diagnostics,
            output=_split_output(program_output),
            stdout=program_output,
            stderr=program_errors,
            variables={},
            events=[],
            trace=[],
            call_stack=[],
        )


def _java_class_name(source: str) -> str:
    match = re.search(r"^\s*public\s+(?:final\s+|abstract\s+)?class\s+(\w+)", source, re.MULTILINE)
    if match:
        return match.group(1)
    match = re.search(r"^\s*(?:final\s+|abstract\s+)?class\s+(\w+)", source, re.MULTILINE)
    return match.group(1) if match else "Main"


def _java_tracer_dir() -> str | None:
    """Compile the JDI tracer once per backend process and reuse it."""
    global _JAVA_TRACER_DIR
    with _JAVA_TRACER_LOCK:
        if _JAVA_TRACER_DIR and Path(_JAVA_TRACER_DIR).is_dir():
            return _JAVA_TRACER_DIR
        compiler = shutil.which("javac")
        source = BASE_DIR / "CodeFlowTracer.java"
        if not compiler or not source.exists():
            return None
        target = Path(tempfile.mkdtemp(prefix="codeflow-jdi-"))
        compiled = _run_process(
            [compiler, "-d", str(target), str(source)],
            cwd=str(target),
            env=os.environ.copy(),
            timeout=COMPILE_TIMEOUT_SECONDS,
        )
        if compiled.get("returncode") != 0:
            return None
        _JAVA_TRACER_DIR = str(target)
        return _JAVA_TRACER_DIR


def execute_java(source: str, stdin_text: str = "") -> dict[str, Any]:
    compiler = shutil.which("javac")
    runtime = shutil.which("java")
    if not compiler or not runtime:
        return _unsupported("java", "A JDK (javac and java) was not found on PATH.")
    tracer = _java_tracer_dir()
    if not tracer:
        return _unsupported("java", "The Java debugger helper could not be compiled.")

    with tempfile.TemporaryDirectory(prefix="codeflow-java-") as workdir:
        work = Path(workdir)
        class_name = _java_class_name(source)
        source_path = work / f"{class_name}.java"
        source_path.write_text(source, encoding="utf-8")

        compiled = _run_process(
            [compiler, "-g", "-d", str(work), str(source_path)],
            cwd=workdir,
            env=os.environ.copy(),
            timeout=COMPILE_TIMEOUT_SECONDS,
        )
        compile_text = _decode(compiled["stderr"]) + _decode(compiled["stdout"])
        if compiled.get("returncode") != 0:
            return _empty_result("java", "error", _parse_compile_errors(compile_text, "java"),
                                 stderr=_decode(compiled["stderr"])[:MAX_OUTPUT_BYTES])

        trace_path = work / "trace.json"
        stdin_path = work / "stdin.txt"
        stdin_path.write_text(stdin_text, encoding="utf-8")
        reads_input = _source_reads_input(source, "java")
        if reads_input:
            # Same reasoning as the C/C++ path: the tracer hands the program a
            # closed stdin file, so probe with a real open pipe to see whether it
            # is still waiting for values.
            probe = _run_process(
                [runtime, "-cp", str(work), class_name],
                cwd=workdir,
                env={"PATH": os.environ.get("PATH", "")},
                timeout=INPUT_WAIT_PROBE_SECONDS,
                stdin_data=stdin_text,
                keep_stdin_open=True,
            )
            if probe.get("timed_out"):
                return _waiting_for_input("java", _decode(probe["stdout"]))
        child = _run_process(
            [runtime, "-cp", tracer, "CodeFlowTracer", str(work), class_name, str(trace_path), str(stdin_path)],
            cwd=workdir,
            env={"PATH": os.environ.get("PATH", ""), "CODEFLOW_MAX_EVENTS": str(MAX_EVENTS)},
            timeout=INPUT_WAIT_PROBE_SECONDS if reads_input else DEBUG_RUN_TIMEOUT_SECONDS,
        )
        program_output = _decode(child["stdout"])
        program_errors = _decode(child["stderr"])
        events, truncated = _read_trace(trace_path)

        if child.get("timed_out") and reads_input:
            return _waiting_for_input("java", program_output, events)

        if child.get("timed_out"):
            return _empty_result("java", "timeout", [_diagnostic(
                "Execution timed out",
                f"Java execution exceeded the {DEBUG_RUN_TIMEOUT_SECONDS:g}-second limit.",
                kind="timeout",
            )], output=_split_output(program_output), stdout=program_output, events=events, trace=events)

        diagnostics: list[dict[str, Any]] = []
        thrown = re.search(r"Exception in thread \"[^\"]*\" ([\w.$]+)(?::\s*(.*))?", program_errors)
        if thrown:
            diagnostics.append(_diagnostic(
                thrown.group(1).split(".")[-1] or "RuntimeException",
                (thrown.group(2) or thrown.group(1)).strip() or "The program threw an exception.",
                kind="runtime",
            ))
        if not events and not diagnostics:
            diagnostics.append(_diagnostic(
                "No trace produced",
                program_errors.strip()[:800] or "The Java debugger did not report any executed lines.",
                kind="runtime",
            ))

        variables, stack = _tail_variables(events)
        result = _empty_result(
            "java",
            "completed" if not diagnostics else "error",
            diagnostics,
            output=_split_output(program_output),
            stdout=program_output,
            stderr=program_errors,
            variables=variables,
            events=events,
            trace=events,
            call_stack=stack,
        )
        result["limits"]["events_truncated"] = truncated or len(events) >= MAX_EVENTS
        return result


def execute_payload(payload: Any) -> tuple[dict[str, Any], int]:
    validated = _validate_payload(payload)
    if validated[0] is None:
        return validated[1], HTTPStatus.BAD_REQUEST
    language, source = validated
    stdin_text = _stdin_of(payload)
    if language == "python":
        result = execute_python(source, stdin_text)
    elif language == "javascript":
        result = execute_javascript(source, stdin_text)
    elif language == "java":
        result = execute_java(source, stdin_text)
    else:
        result = execute_native(source, language, stdin_text)
    result.setdefault("request", {"language": language})
    return result, HTTPStatus.OK


def verify_payload(payload: Any) -> tuple[dict[str, Any], int]:
    validated = _validate_payload(payload)
    if validated[0] is None:
        return validated[1], HTTPStatus.BAD_REQUEST
    language, source = validated
    if language == "python":
        try:
            ast.parse(source, filename="codeflow_user.py", mode="exec")
        except SyntaxError as exc:
            diagnostic = _diagnostic(
                "SyntaxError",
                str(exc.msg),
                line=exc.lineno,
                column=exc.offset,
                kind="syntax",
                end_line=getattr(exc, "end_lineno", None),
                end_column=getattr(exc, "end_offset", None),
            )
            return {"valid": False, "language": language, "errors": [diagnostic], "diagnostics": [diagnostic]}, HTTPStatus.OK
        return {"valid": True, "language": language, "errors": [], "diagnostics": []}, HTTPStatus.OK

    if language in {"c", "cpp"}:
        compiler = _native_compiler(language)
        if not compiler:
            diagnostic = _diagnostic("Compiler unavailable", f"No {language} compiler was found on PATH.", kind="unsupported")
            return {"valid": False, "supported": False, "language": language, "errors": [diagnostic], "diagnostics": [diagnostic]}, HTTPStatus.OK
        with tempfile.TemporaryDirectory(prefix="codeflow-verify-") as workdir:
            path = Path(workdir) / ("source" + NATIVE_EXTENSIONS[language])
            path.write_text(source, encoding="utf-8")
            # Syntax-only: this never links or runs the program.
            child = _run_process(
                [compiler, "-fsyntax-only", NATIVE_STANDARDS[language],
                 *_native_extra_flags(language, compiler), str(path)],
                cwd=workdir, env={"PATH": os.environ.get("PATH", "")},
                timeout=COMPILE_TIMEOUT_SECONDS,
            )
        if child.get("returncode") == 0:
            return {"valid": True, "supported": True, "language": language, "errors": [], "diagnostics": []}, HTTPStatus.OK
        text = _decode(child["stderr"]) + _decode(child["stdout"])
        diagnostics = _parse_compile_errors(text, language)
        return {"valid": False, "supported": True, "language": language, "errors": diagnostics, "diagnostics": diagnostics}, HTTPStatus.OK

    if language == "java":
        compiler = shutil.which("javac")
        if not compiler:
            diagnostic = _diagnostic("Java unavailable", "A JDK (javac) was not found on PATH.", kind="unsupported")
            return {"valid": False, "supported": False, "language": language, "errors": [diagnostic], "diagnostics": [diagnostic]}, HTTPStatus.OK
        with tempfile.TemporaryDirectory(prefix="codeflow-verify-") as workdir:
            path = Path(workdir) / f"{_java_class_name(source)}.java"
            path.write_text(source, encoding="utf-8")
            child = _run_process(
                [compiler, "-g", "-d", workdir, str(path)],
                cwd=workdir, env=os.environ.copy(), timeout=COMPILE_TIMEOUT_SECONDS,
            )
        if child.get("returncode") == 0:
            return {"valid": True, "supported": True, "language": language, "errors": [], "diagnostics": []}, HTTPStatus.OK
        text = _decode(child["stderr"]) + _decode(child["stdout"])
        diagnostics = _parse_compile_errors(text, language)
        return {"valid": False, "supported": True, "language": language, "errors": diagnostics, "diagnostics": diagnostics}, HTTPStatus.OK

    node = _node_command()
    if not node:
        diagnostic = _diagnostic("JavaScript unavailable", "Node.js is not installed or is not available on PATH.", kind="unsupported")
        return {"valid": False, "supported": False, "language": language, "errors": [diagnostic], "diagnostics": [diagnostic]}, HTTPStatus.OK
    # Node --check parses without running the program.
    with tempfile.TemporaryDirectory(prefix="codeflow-verify-") as workdir:
        path = Path(workdir) / "source.js"
        path.write_text(source, encoding="utf-8")
        child = _run_process([node, "--check", str(path)], cwd=workdir, env={"PATH": os.environ.get("PATH", "")})
    if child.get("returncode") == 0:
        return {"valid": True, "supported": True, "language": language, "errors": [], "diagnostics": []}, HTTPStatus.OK
    text = _decode(child["stderr"]) or _decode(child["stdout"])
    line = None
    column = None
    import re
    match = re.search(r":(\d+)(?::(\d+))?", text)
    if match:
        line = int(match.group(1))
        column = int(match.group(2)) if match.group(2) else None
    diagnostic = _diagnostic("JavaScript syntax error", text.strip() or "Node.js rejected the source.", line=line, column=column, kind="syntax")
    return {"valid": False, "supported": True, "language": language, "errors": [diagnostic], "diagnostics": [diagnostic]}, HTTPStatus.OK


def _ai_http_detail(exc: HTTPError) -> str:
    """A readable reason from a provider error response.

    Both OpenAI and Gemini wrap failures as {"error": {"message": ...}}, and a
    quota error names the reset window ("Please retry in 3h4m"). Falling back to
    str(exc) produced "HTTP Error 400: Bad Request" and told the user nothing.
    """
    try:
        raw = exc.read(4000).decode("utf-8", "replace")
    except Exception:
        raw = ""
    try:
        parsed = json.loads(raw)
        # Gemini's OpenAI-compatible endpoint wraps the envelope in a one-item
        # list, so the dict shape alone is not enough.
        if isinstance(parsed, list) and parsed:
            parsed = parsed[0]
        if isinstance(parsed, dict):
            error = parsed.get("error")
            message = error.get("message") if isinstance(error, dict) else error
            if isinstance(message, str) and message.strip():
                return " ".join(message.split())[:400]
    except (ValueError, TypeError):
        pass
    # An HTML error page (Google's frontend returns one on a malformed request).
    text = re.sub(r"<[^>]+>", " ", raw)
    text = " ".join(text.split())
    if text:
        return text[:200]
    return f"HTTP {exc.code} {exc.reason or ''}".strip()


def _ai_endpoint(base_url: str) -> str | None:
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        return None
    base = base_url.rstrip("/")
    return base if base.endswith("/chat/completions") else base + "/chat/completions"


def _proposed_code(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not isinstance(value.get("code"), str):
        return None
    if len(value["code"].encode("utf-8")) > MAX_SOURCE_BYTES:
        return None
    result = {"code": value["code"]}
    normalized = _normalize_language(value.get("language"))
    if normalized:
        result["language"] = normalized
    if isinstance(value.get("explanation"), str):
        result["explanation"] = value["explanation"][:2000]
    return result


def _ai_error(
    title: str,
    detail: str,
    *,
    configured: bool,
    status: str = "error",
    kind: str = "provider",
) -> dict[str, Any]:
    return {
        "status": status,
        "provider_status": "error" if status == "error" else "not-configured",
        "configuration_status": "invalid" if kind == "configuration" else "configured",
        "configured": configured,
        "answer": None,
        "response": None,
        "diagnostics": [_diagnostic(title, detail, kind=kind)],
    }


def _structured_ai_content(content: Any) -> tuple[str, dict[str, Any]]:
    """Decode and validate the JSON object returned in message.content."""
    if isinstance(content, dict):
        decoded = content
    elif isinstance(content, str):
        text = content.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            if len(lines) >= 3 and lines[-1].strip() == "```":
                body = lines[1:-1]
                if body and body[0].strip().lower() in {"json", "jsonc"}:
                    body = body[1:]
                text = "\n".join(body).strip()
        try:
            decoded = json.loads(text)
        except (TypeError, ValueError, json.JSONDecodeError):
            # Fallback: treat the raw model text as the answer so the panel never looks dead.
            return text, {}
    else:
        raise ValueError("AI message content was not a JSON object.")
    if not isinstance(decoded, dict):
        raise ValueError("AI message content must be a JSON object.")
    answer = decoded.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        raise ValueError("AI response must contain a non-empty answer string.")
    if len(answer.encode("utf-8")) > MAX_AI_ANSWER_BYTES:
        raise ValueError("AI answer exceeded the response limit.")
    proposed_value = decoded.get("proposed_code")
    proposed = None
    if proposed_value is not None:
        proposed = _proposed_code(proposed_value)
        if proposed is None:
            raise ValueError("AI proposed_code must contain valid bounded code.")
    return answer.strip(), {"proposed_code": proposed} if proposed is not None else {}


def ai_payload(payload: Any) -> tuple[dict[str, Any], int]:
    if not isinstance(payload, dict):
        return {"error": "Request body must be a JSON object."}, HTTPStatus.BAD_REQUEST
    prompt = payload.get("prompt", "")
    language = payload.get("language", "python")
    source = payload.get("code", "")
    diagnostics = payload.get("diagnostics", [])
    selected_event = payload.get("selected_event")
    if not isinstance(prompt, str) or not isinstance(language, str) or not isinstance(source, str):
        return {"error": "prompt, language, and code must be strings."}, HTTPStatus.BAD_REQUEST
    if _normalize_language(language) is None:
        return {"error": "language must be one of: python, javascript, java, c, cpp."}, HTTPStatus.BAD_REQUEST
    if not isinstance(diagnostics, list) or len(diagnostics) > MAX_AI_CONTEXT_ITEMS:
        return {"error": f"diagnostics must be a list of at most {MAX_AI_CONTEXT_ITEMS} items."}, HTTPStatus.BAD_REQUEST
    if any(not isinstance(item, dict) for item in diagnostics):
        return {"error": "diagnostics items must be JSON objects."}, HTTPStatus.BAD_REQUEST
    if selected_event is not None and not isinstance(selected_event, dict):
        return {"error": "selected_event must be a JSON object or null."}, HTTPStatus.BAD_REQUEST
    if len(prompt.encode("utf-8")) > MAX_AI_PROMPT_BYTES:
        return {"error": "prompt exceeds the 8 KiB limit."}, HTTPStatus.BAD_REQUEST
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        return {"error": "Source exceeds the 64 KiB limit."}, HTTPStatus.BAD_REQUEST
    api_key = os.environ.get("CODEFLOW_AI_API_KEY", "").strip()
    if not api_key:
        return {
            "status": "not-configured",
            "provider_status": "not-configured",
            "configuration_status": "missing",
            "configured": False,
            "answer": None,
            "response": None,
            "message": "AI is not configured. Set CODEFLOW_AI_API_KEY to enable an OpenAI-compatible provider.",
            "diagnostics": [_diagnostic("AI not configured", "No CODEFLOW_AI_API_KEY is present.", kind="configuration")],
        }, HTTPStatus.OK
    endpoint = _ai_endpoint(os.environ.get("CODEFLOW_AI_BASE_URL", "https://api.openai.com/v1"))
    # A comma-separated list, tried in order. Free provider tiers run out per
    # model, so a fallback keeps the tutor alive when the first one is capped.
    models = [name.strip() for name in os.environ.get("CODEFLOW_AI_MODEL", "gpt-4o-mini").split(",") if name.strip()]
    if not endpoint or not models:
        return _ai_error(
            "Invalid AI configuration",
            "Set CODEFLOW_AI_BASE_URL to an HTTP(S) URL and CODEFLOW_AI_MODEL to a model name.",
            configured=False,
            kind="configuration",
        ), HTTPStatus.OK
    normalized_language = "javascript" if language.lower() == "js" else language.lower()
    context = {
        "language": normalized_language,
        "code": source,
        "diagnostics": diagnostics,
        "selected_event": selected_event,
        "prompt": prompt,
    }
    messages = [
        {
            "role": "system",
            "content": (
                "You are CodeFlow, a concise programming tutor. Use only the supplied execution evidence. "
                "Return only a JSON object with a non-empty string field `answer`. You may include an optional "
                "`proposed_code` object with `code`, optional `language`, and optional `explanation`. "
                "Never claim to have executed code or invent runtime values."
            ),
        },
        {
            "role": "user",
            "content": f"Mode: {payload.get('mode', 'chat')}\nContext:\n{json.dumps(context, ensure_ascii=False)}",
        },
    ]
    # The most informative failure seen across models/attempts. A provider can
    # answer 429 on one attempt and a malformed 400 on the next (a proxy hiccup,
    # an HTML error page); reporting whichever came *last* hid the real cause —
    # "quota exceeded, retry in 3h" was shown as "400 Bad Request".
    best: tuple[int, str] | None = None

    def remember(detail: str, code: int | None) -> None:
        nonlocal best
        # A real provider verdict beats a transport hiccup; among equals the
        # first one wins, so a later HTML 400 cannot mask an earlier 429.
        rank = 2 if code in (400, 401, 403, 404, 429) else (1 if code is not None else 0)
        if best is None or rank > best[0]:
            best = (rank, detail)

    for model in models:
        body = json.dumps({"model": model, "messages": messages, "temperature": 0.2}).encode("utf-8")
        attempt = 0
        while attempt <= AI_MAX_RETRIES:
            try:
                request = URLRequest(endpoint, data=body, method="POST", headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"})
                with urlopen(request, timeout=AI_TIMEOUT_SECONDS) as response:
                    raw = response.read(MAX_OUTPUT_BYTES * 8 + 1)
                if len(raw) > MAX_OUTPUT_BYTES * 8:
                    raise ValueError("AI response exceeded the response limit.")
                decoded = json.loads(raw.decode("utf-8"))
                if not isinstance(decoded, dict):
                    raise ValueError("AI response was not a JSON object.")
                choices = decoded.get("choices")
                if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
                    raise ValueError("AI response did not contain choices.")
                message = choices[0].get("message")
                content = message.get("content") if isinstance(message, dict) else None
                answer, structured = _structured_ai_content(content)
                result: dict[str, Any] = {
                    "status": "ok",
                    "provider_status": "remote",
                    "configuration_status": "configured",
                    "configured": True,
                    "model": model,
                    "answer": answer,
                    "response": answer,
                }
                result.update(structured)
                return result, HTTPStatus.OK
            except HTTPError as exc:
                detail = _ai_http_detail(exc)
                remember(detail, exc.code)
                # A capped model or an unknown one will not recover by retrying.
                if exc.code in (400, 404, 429):
                    break
                if 500 <= exc.code < 600 and attempt < AI_MAX_RETRIES:
                    attempt += 1
                    time.sleep(min(AI_BACKOFF_BASE * (2 ** attempt), 6.0))
                    continue
                break
            except (URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
                remember(str(exc)[:400] or type(exc).__name__, None)
                break

    detail = best[1] if best else "No provider response."
    return {
        "status": "error",
        "provider_status": "error",
        "configuration_status": "configured",
        "configured": True,
        "answer": None,
        "response": None,
        "message": "The AI provider could not answer: " + detail,
        "diagnostics": [_diagnostic("AI provider error", detail[:500], kind="provider")],
    }, HTTPStatus.OK


def _cpp_headers_available() -> bool:
    """True only if a C++ compiler can actually compile a real <iostream> program here.

    Some sandboxes ship clang++/g++ binaries WITHOUT the libstdc++ headers, so
    checking the binary alone lies — this actually compiles (via the cached
    flag-variant probe) to be sure.
    """
    for compiler in ("clang++", "g++"):
        path = shutil.which(compiler)
        if path and _cpp_compile_flags(path) is not None:
            return True
    return False


def _lldb_toolchain_probe() -> dict[str, Any]:
    """Report what LLDB pieces actually exist on this machine (for /api/health)."""
    info: dict[str, Any] = {}
    lldb = _lldb_debugger()
    info["lldb"] = lldb
    info["lldb_realpath"] = os.path.realpath(lldb) if lldb else None
    servers: list[str] = []
    for pattern in ("/usr/lib/llvm-*/bin/lldb-server*", "/usr/bin/lldb-server*", "/usr/local/bin/lldb-server*", "/opt/*/bin/lldb-server*"):
        servers.extend(sorted(glob.glob(pattern)))
    info["lldb_servers"] = servers
    info["lldb_server_details"] = [
        {
            "path": p,
            "realpath": os.path.realpath(p),
            "is_file": os.path.isfile(p),
            "executable": os.access(p, os.X_OK),
        }
        for p in servers
    ]
    info["lldb_server_on_path"] = bool(shutil.which("lldb-server"))
    info["lldb_server_override"] = _lldb_server_path()
    # Can the server binary actually execute here? A missing shared library still
    # leaves the file present and executable, but the spawn then fails.
    server_check = None
    for path in servers:
        real = os.path.realpath(path)
        if os.path.isfile(real) and os.access(real, os.X_OK):
            try:
                res = _run_process([real, "--version"], cwd="/tmp", env=os.environ.copy(), timeout=15)
                server_check = {
                    "path": real,
                    "returncode": res.get("returncode"),
                    "stdout": _decode(res.get("stdout", b"")).strip()[:200],
                    "stderr": _decode(res.get("stderr", b"")).strip()[:200],
                }
            except Exception as exc:
                server_check = {"path": real, "error": str(exc)[:200]}
            break
    info["server_check"] = server_check
    if lldb:
        try:
            res = _run_process([lldb, "--version"], env=os.environ.copy(), timeout=20)
            info["version_output"] = (_decode(res["stdout"]) + _decode(res["stderr"])).strip()[:200]
        except Exception:
            info["version_output"] = None
    return info


def health_payload() -> dict[str, Any]:
    toolchain = _lldb_toolchain_probe()
    return {
        "status": "ok",
        "service": RESULT_MARKER,
        "python": sys.version.split()[0],
        "fastapi": FASTAPI_AVAILABLE,
        "node_available": bool(_node_command()),
        "ai_configured": bool(os.environ.get("CODEFLOW_AI_API_KEY", "").strip()),
        "languages": {
            "python": True,
            "javascript": bool(_node_command()),
            "java": bool(shutil.which("javac") and shutil.which("java")),
            "c": _native_compiler("c") is not None,
            "cpp": _native_compiler("cpp") is not None and _cpp_headers_available(),
            "stepping": bool(toolchain["lldb"]) and bool(toolchain["lldb_servers"] or toolchain["lldb_server_on_path"]),
        },
        "toolchain": toolchain,
        "limits": {
            "source_bytes": MAX_SOURCE_BYTES,
            "output_bytes": MAX_OUTPUT_BYTES,
            "events": MAX_EVENTS,
            "timeout_seconds": EXECUTION_TIMEOUT_SECONDS,
        },
    }


def _safe_static_path(relative: str) -> Path | None:
    candidate = (BASE_DIR / relative).resolve()
    try:
        candidate.relative_to(BASE_DIR)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


# When CODEFLOW_SERVER=stdlib is set (the published / single-port host), skip the heavy
# FastAPI + Starlette + Pydantic import entirely. The threaded stdlib server implements the
# same API + static surface and boots in a fraction of a second, so cold starts are fast and
# the app opens quickly. Local development keeps FastAPI when this flag is absent.
_FORCE_STDLIB = os.environ.get("CODEFLOW_SERVER", "").strip().lower() in {"stdlib", "simple", "http"}
if _FORCE_STDLIB:
    FASTAPI_AVAILABLE = False
else:
    try:
        from fastapi import FastAPI, Request
        from fastapi.responses import FileResponse, JSONResponse, Response

        FASTAPI_AVAILABLE = True
    except ImportError:
        FASTAPI_AVAILABLE = False


if FASTAPI_AVAILABLE:
    app = FastAPI(title="CodeFlow", version="1.0.0")

    async def _fastapi_json(request: Request) -> tuple[dict[str, Any] | None, JSONResponse | None]:
        body = await request.body()
        if len(body) > MAX_REQUEST_BYTES:
            return None, JSONResponse({"error": "Request body exceeds the 128 KiB limit."}, status_code=413)
        try:
            value = json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, JSONResponse({"error": "Request body must be valid JSON."}, status_code=400)
        return value, None

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return health_payload()

    @app.post("/api/execute")
    async def execute(request: Request) -> Response:
        payload, error = await _fastapi_json(request)
        if error:
            return error
        result, status = execute_payload(payload)
        return JSONResponse(result, status_code=status)

    @app.post("/api/verify")
    async def verify(request: Request) -> Response:
        payload, error = await _fastapi_json(request)
        if error:
            return error
        result, status = verify_payload(payload)
        return JSONResponse(result, status_code=status)

    @app.post("/api/ai")
    async def ai(request: Request) -> Response:
        payload, error = await _fastapi_json(request)
        if error:
            return error
        result, status = ai_payload(payload)
        return JSONResponse(result, status_code=status)

    @app.get("/")
    async def index() -> Response:
        return FileResponse(BASE_DIR / "index.html", headers={"Cache-Control": "no-store"})

    @app.get("/{asset_path:path}")
    async def static_asset(asset_path: str) -> Response:
        path = _safe_static_path(asset_path)
        if path is None:
            return JSONResponse({"error": "Not found"}, status_code=404)
        return FileResponse(path, headers={"Cache-Control": "no-store"})
else:
    app = None


class CodeFlowHandler(BaseHTTPRequestHandler):
    """Small fallback HTTP server using exactly the same endpoint functions."""

    server_version = "CodeFlow/1.0"

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        # The query string is stripped before routing: without this, a
        # cache-busting URL like `/?v=2` missed the root check and 404'd.
        route = self.path.split("?", 1)[0]
        if route == "/api/health":
            self._send_json(health_payload())
            return
        relative = "index.html" if route in ("", "/") else route.lstrip("/")
        path = _safe_static_path(relative)
        if path is None:
            self._send_json({"error": "Not found"}, 404)
            return
        data = path.read_bytes()
        content_type = "text/html; charset=utf-8" if path.suffix == ".html" else "text/plain; charset=utf-8"
        if path.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif path.suffix == ".js":
            content_type = "application/javascript; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        # A cached index.html is the difference between "five languages" and
        # "only Python in the dropdown" after an update.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/api/execute", "/api/verify", "/api/ai"}:
            self._send_json({"error": "Not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length > MAX_REQUEST_BYTES:
            self._send_json({"error": "Request body exceeds the 128 KiB limit."}, 413)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json({"error": "Request body must be valid JSON."}, 400)
            return
        function: Callable[[Any], tuple[dict[str, Any], int]] = {
            "/api/execute": execute_payload,
            "/api/verify": verify_payload,
            "/api/ai": ai_payload,
        }[self.path]
        result, status = function(payload)
        self._send_json(result, int(status))

    def log_message(self, format: str, *args: Any) -> None:
        return None


def serve(host: str = "127.0.0.1", port: int = 8010) -> None:
    server = ThreadingHTTPServer((host, port), CodeFlowHandler)
    print(f"CodeFlow backend listening on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    # Render and other managed hosts provide PORT and require binding on all
    # interfaces. Local development keeps the safer loopback default and uses
    # 8010 so it does not collide with another app on port 8000.
    _ensure_lldb_server_names()
    host = os.environ.get("CODEFLOW_HOST") or ("0.0.0.0" if (os.environ.get("RENDER") or os.environ.get("PORT")) else "127.0.0.1")
    port = int(os.environ.get("PORT") or os.environ.get("CODEFLOW_PORT", "8010"))
    if FASTAPI_AVAILABLE:
        try:
            import uvicorn
        except ImportError:
            serve(host, port)
            return
        uvicorn.run(app, host=host, port=port)
    else:
        serve(host, port)


if __name__ == "__main__":
    main()
