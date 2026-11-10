#!/usr/bin/env python3
"""Call Jarvis (local vLLM) holding one of the machine's 4 slot flocks.

Usage:
  jarvis_call.py PROMPT_FILE OUT_DIR [--max-tokens N] [--temperature T]
                 [--queue-timeout S] [--timeout S] [--url URL] [--lock-dir DIR]
                 [--snapshot PATH --repo PATH] [--detach]

Writes OUT_DIR/reply.json, content.md, reasoning.md, meta.json, exit_code, run.log.

  jarvis_call.py --wait OUT_DIR [--max-wait 45]
  jarvis_call.py --cancel OUT_DIR

Exit codes: 0 ok, 2 down, 3 model unavailable, 4 empty/truncated,
5 request/deadline/protocol, 6 queue expiry, 7 invalid inputs,
10 pending, 130 cancelled.
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import math
import os
import signal
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

DEFAULT_URL = os.environ.get("JARVIS_URL", "http://127.0.0.1:8088")
DEFAULT_LOCKDIR = os.path.join(
    os.environ.get("XDG_RUNTIME_DIR", "/run/user/{}".format(os.getuid())), "revue"
)
SYSTEM_PROMPT = (
    "Answer directly. Keep hidden reasoning brief; "
    "the whole reply must fit the token budget."
)
SLOT_COUNT = 4
MAX_OUTPUT_TOKENS = 32768
EXIT_OK, EXIT_DOWN, EXIT_MODEL_UNAVAIL = 0, 2, 3
EXIT_EMPTY_TRUNC, EXIT_REQ_ERROR, EXIT_QUEUE = 4, 5, 6
EXIT_INVALID, EXIT_PENDING, EXIT_CANCELLED = 7, 10, 130

# Process-scoped cancellation state
_pending_cancel: bool = False
_protected_active: bool = False


class CancelledError(BaseException):
    """SIGTERM/SIGINT received."""


class DeadlineError(BaseException):
    """Combined probe+request deadline expired."""


# --- helpers ---

def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _atomic_write(path: str, data: str) -> None:
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp_", suffix=".aw")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _proc_start_ticks(pid: int) -> Optional[int]:
    """Read starttime (field 22) from /proc/PID/stat."""
    try:
        with open("/proc/{}/stat".format(pid), "r") as f:
            data = f.read()
        idx = data.rfind(")")
        if idx < 0:
            return None
        fields = data[idx + 2:].split()
        return int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


def _pid_alive(pid: int) -> bool:
    """True only if pid exists and is not a zombie."""
    try:
        with open("/proc/{}/stat".format(pid), "r") as f:
            data = f.read()
        idx = data.rfind(")")
        if idx < 0:
            return False
        state = data[idx + 2:].split()[0]
        return state != "Z"
    except (OSError, IndexError):
        return False


# --- signal/deadline ---

def _install_signals() -> None:
    def _h(signum: int, frame: Any) -> None:
        if _protected_active:
            raise CancelledError("signal {}".format(signum))
        global _pending_cancel
        _pending_cancel = True
    signal.signal(signal.SIGTERM, _h)
    signal.signal(signal.SIGINT, _h)


def _set_deadline(seconds: float) -> None:
    def _h(signum: int, frame: Any) -> None:
        raise DeadlineError("deadline {:.1f}s exceeded".format(seconds))
    signal.signal(signal.SIGALRM, _h)
    signal.setitimer(signal.ITIMER_REAL, seconds)


def _clear_deadline() -> None:
    signal.setitimer(signal.ITIMER_REAL, 0)


# --- slot ---

def _acquire_slot(lockdir: str, queue_timeout: float) -> Tuple[Optional[int], Optional[int], float]:
    os.makedirs(lockdir, exist_ok=True)
    t0 = time.monotonic()
    deadline = t0 + queue_timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, None, time.monotonic() - t0
        for n in range(SLOT_COUNT):
            path = os.path.join(lockdir, "jarvis.{}.lock".format(n))
            fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd, n, time.monotonic() - t0
            except BlockingIOError:
                os.close(fd)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, None, time.monotonic() - t0
        time.sleep(min(0.05, remaining))


def _release_slot(fd: int) -> None:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


# --- probe ---

def _probe(url: str, timeout: float) -> Tuple[Optional[str], Optional[int], Optional[str]]:
    try:
        req = urllib.request.Request(url + "/v1/models")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
    except CancelledError:
        raise
    except DeadlineError:
        raise
    except Exception as e:
        return None, None, "down: {}".format(e)
    if not isinstance(data, dict):
        return None, None, "model unavailable: malformed response"
    entries = data.get("data")
    if not isinstance(entries, list):
        return None, None, "model unavailable: malformed models shape"
    for m in entries:
        if isinstance(m, dict) and m.get("id") == "jarvis":
            root = m.get("root")
            if not isinstance(root, str) or not root:
                return None, None, "model unavailable: empty root"
            return root, m.get("max_model_len"), None
    return None, None, "model unavailable: jarvis not found"


# --- request ---

def _do_request(url: str, prompt_text: str, max_tokens: int,
                temperature: float, remaining: float) -> Tuple[Optional[Any], Optional[str]]:
    body: Dict[str, Any] = {
        "model": "jarvis", "temperature": temperature,
        "max_tokens": max_tokens, "reasoning_effort": "low",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt_text},
        ],
    }
    req = urllib.request.Request(
        url + "/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=max(1.0, remaining)) as resp:
            raw = resp.read()
    except CancelledError:
        raise
    except DeadlineError:
        raise
    except urllib.error.HTTPError as e:
        return None, "http {}: {}".format(e.code, e.reason)
    except Exception as e:
        return None, "request failed: {}".format(e)
    try:
        reply = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        return None, "invalid JSON: {}".format(e)
    return reply, None


# --- response validation ---

def _validate_reply(reply: Any) -> Optional[str]:
    """Return error string if reply is malformed, None if acceptable."""
    if not isinstance(reply, dict):
        return "response not a dict"
    choices = reply.get("choices")
    if not isinstance(choices, list) or len(choices) == 0:
        return "no choices"
    ch = choices[0]
    if not isinstance(ch, dict):
        return "choice not a dict"
    msg = ch.get("message")
    if not isinstance(msg, dict):
        return "message not a dict"
    content = msg.get("content")
    if content is not None and not isinstance(content, str):
        return "content not a string"
    reasoning = msg.get("reasoning")
    if reasoning is not None and not isinstance(reasoning, str):
        return "reasoning not a string"
    reasoning_content = msg.get("reasoning_content")
    if reasoning_content is not None and not isinstance(reasoning_content, str):
        return "reasoning_content not a string"
    return None


def _normalize_str(val: Any) -> str:
    """Coerce to string; non-str/non-None -> empty string."""
    if isinstance(val, str):
        return val
    return ""


# --- run log ---

class _RunLog:
    def __init__(self, path: str) -> None:
        self._fd: Optional[int] = os.open(
            path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)

    def write(self, msg: str) -> None:
        if self._fd is None:
            return
        ts = time.strftime("%Y-%m-%dT%H:%M:%S")
        os.write(self._fd, "[{}] {}\n".format(ts, msg).encode("utf-8"))

    def close(self) -> None:
        if self._fd is not None:
            try:
                os.fsync(self._fd)
            except OSError:
                pass
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None


# --- core execution ---

def _execute(prompt_path: str, out_dir: str, url: str, lockdir: str,
             max_tokens: int, temperature: float, queue_timeout: float,
             timeout: float, snapshot_path: Optional[str],
             repo_path: Optional[str], log: _RunLog) -> int:
    t_total = time.monotonic()
    slot_fd: Optional[int] = None
    slot_num: Optional[int] = None
    queue_s = probe_s = request_s = 0.0
    post_attempts = 0
    model_root: Optional[str] = None
    max_model_len: Optional[int] = None
    reply: Any = None
    error: Optional[str] = None
    exit_code = EXIT_OK
    finish_reason: Optional[str] = None
    usage: Any = None
    snapshot_sha: Optional[str] = None
    snapshot_abs: Optional[str] = None

    # Phase tracking for partial durations on interruption
    phase = "queue"
    phase_start = t_total

    # Read prompt bytes ONCE inside protected try
    prompt_bytes: Optional[bytes] = None
    prompt_text: Optional[str] = None
    prompt_sha: Optional[str] = None

    try:
        global _protected_active, _pending_cancel
        _protected_active = True
        if _pending_cancel:
            raise CancelledError("pending cancel before execution")
        # Read prompt bytes once
        try:
            with open(prompt_path, "rb") as f:
                prompt_bytes = f.read()
        except OSError as e:
            error = "cannot read prompt: {}".format(e)
            log.write(error)
            exit_code = EXIT_INVALID
            phase = "done"
            raise SystemExit  # jump to finally

        prompt_sha = _sha256_bytes(prompt_bytes)
        try:
            prompt_text = prompt_bytes.decode("utf-8")
        except UnicodeDecodeError as e:
            error = "prompt not valid utf-8: {}".format(e)
            log.write(error)
            exit_code = EXIT_INVALID
            phase = "done"
            raise SystemExit

        # Validate snapshot BEFORE slot (pre-check)
        if snapshot_path and repo_path:
            snapshot_abs = os.path.abspath(snapshot_path)
            # Hash actual snapshot file bytes (not prompt bytes)
            try:
                with open(snapshot_path, "rb") as f:
                    snap_file_bytes = f.read()
            except OSError as e:
                error = "snapshot read error (pre-slot): {}".format(e)
                log.write(error)
                exit_code = EXIT_INVALID
                phase = "done"
                raise SystemExit
            snapshot_sha = _sha256_bytes(snap_file_bytes)
            try:
                from jarvis_packet import check_snapshot  # type: ignore
                snap = check_snapshot(Path(repo_path), Path(snapshot_path))
            except CancelledError:
                raise
            except DeadlineError:
                raise
            except ValueError as e:
                error = "stale snapshot (pre-slot): {}".format(e)
                log.write(error)
                exit_code = EXIT_INVALID
                phase = "done"
                raise SystemExit
            except Exception as e:
                error = "snapshot error (pre-slot): {}".format(e)
                log.write(error)
                exit_code = EXIT_INVALID
                phase = "done"
                raise SystemExit
            # Verify snapshot file stable after check_snapshot
            try:
                with open(snapshot_path, "rb") as f:
                    snap_bytes_after = f.read()
            except OSError as e:
                error = "snapshot re-read error (pre-slot): {}".format(e)
                log.write(error)
                exit_code = EXIT_INVALID
                phase = "done"
                raise SystemExit
            if _sha256_bytes(snap_bytes_after) != snapshot_sha:
                error = "stale snapshot (pre-slot): snapshot file changed during check"
                log.write(error)
                exit_code = EXIT_INVALID
                phase = "done"
                raise SystemExit
            if snap.get("prompt_sha256") != prompt_sha:
                error = "stale snapshot (pre-slot): prompt_sha256 mismatch"
                log.write(error)
                exit_code = EXIT_INVALID
                phase = "done"
                raise SystemExit

        # acquire slot
        phase = "queue"
        phase_start = time.monotonic()
        log.write("acquiring slot queue_timeout={:.0f}s".format(queue_timeout))
        slot_fd, slot_num, queue_s = _acquire_slot(lockdir, queue_timeout)
        if slot_fd is None:
            error = "queue expiry: no slot within {:.0f}s".format(queue_timeout)
            log.write(error)
            exit_code = EXIT_QUEUE
            phase = "done"
        else:
            log.write("slot {} acquired {:.1f}s".format(slot_num, queue_s))
            # single deadline bounds probe+request
            deadline = time.monotonic() + timeout
            _set_deadline(timeout)

            # probe
            phase = "probe"
            phase_start = time.monotonic()
            remaining = max(deadline - time.monotonic(), 0)
            probe_timeout = min(10.0, remaining) if remaining > 0 else 1.0
            model_root, max_model_len, probe_err = _probe(url, probe_timeout)
            probe_s = time.monotonic() - phase_start
            if probe_err:
                error = probe_err
                log.write("probe: {}".format(error))
                exit_code = EXIT_DOWN if probe_err.startswith("down") else EXIT_MODEL_UNAVAIL
                phase = "done"
            else:
                log.write("probe ok root={}".format(model_root))

                # Validate snapshot AFTER slot/probe, immediately before POST
                if snapshot_path and repo_path:
                    # Re-read snapshot file to check for changes
                    try:
                        with open(snapshot_path, "rb") as f:
                            snap_bytes_now = f.read()
                    except OSError as e:
                        error = "snapshot read error (post-slot): {}".format(e)
                        log.write(error)
                        exit_code = EXIT_INVALID
                        phase = "done"
                        raise SystemExit
                    snap_sha_now = _sha256_bytes(snap_bytes_now)
                    if snap_sha_now != snapshot_sha:
                        error = "stale snapshot (post-slot): snapshot file changed"
                        log.write(error)
                        exit_code = EXIT_INVALID
                        phase = "done"
                        raise SystemExit
                    # Revalidate full snapshot (dependencies, manifest, git)
                    try:
                        from jarvis_packet import check_snapshot as _cs  # type: ignore
                        _cs(Path(repo_path), Path(snapshot_path))
                    except CancelledError:
                        raise
                    except DeadlineError:
                        raise
                    except ValueError as e:
                        error = "stale snapshot (post-slot): {}".format(e)
                        log.write(error)
                        exit_code = EXIT_INVALID
                        phase = "done"
                        raise SystemExit
                    except Exception as e:
                        error = "snapshot error (post-slot): {}".format(e)
                        log.write(error)
                        exit_code = EXIT_INVALID
                        phase = "done"
                        raise SystemExit
                    # Also verify prompt bytes still match
                    try:
                        with open(prompt_path, "rb") as f:
                            prompt_bytes_now = f.read()
                    except OSError as e:
                        error = "prompt re-read error: {}".format(e)
                        log.write(error)
                        exit_code = EXIT_INVALID
                        phase = "done"
                        raise SystemExit
                    if _sha256_bytes(prompt_bytes_now) != prompt_sha:
                        error = "stale snapshot (post-slot): prompt changed after check"
                        log.write(error)
                        exit_code = EXIT_INVALID
                        phase = "done"
                        raise SystemExit

                # request
                if exit_code == EXIT_OK:
                    remaining = max(deadline - time.monotonic(), 0)
                    if remaining <= 0:
                        error = "deadline exceeded before request"
                        log.write(error)
                        exit_code = EXIT_REQ_ERROR
                        phase = "done"
                    else:
                        phase = "request"
                        phase_start = time.monotonic()
                        log.write("sending request")
                        post_attempts = 1
                        reply, req_err = _do_request(
                            url, prompt_text, max_tokens, temperature, remaining)
                        request_s = time.monotonic() - phase_start
                        if req_err:
                            error = req_err
                            log.write("request: {}".format(error))
                            exit_code = EXIT_REQ_ERROR
                            phase = "done"
                        else:
                            val_err = _validate_reply(reply)
                            if val_err:
                                error = "protocol: {}".format(val_err)
                                log.write(error)
                                exit_code = EXIT_REQ_ERROR
                                phase = "done"
                            else:
                                ch = reply["choices"][0]
                                msg = ch["message"]
                                finish_reason = ch.get("finish_reason")
                                usage = reply.get("usage")
                                content = msg.get("content") or ""
                                if finish_reason == "length" or not content.strip():
                                    error = "empty/truncated finish={}".format(finish_reason)
                                    log.write(error)
                                    exit_code = EXIT_EMPTY_TRUNC
                                    phase = "done"
                                elif finish_reason != "stop":
                                    error = "unexpected finish_reason={}".format(finish_reason)
                                    log.write(error)
                                    exit_code = EXIT_REQ_ERROR
                                    phase = "done"
                                else:
                                    log.write("ok {} chars".format(len(content)))
                                    phase = "done"

    except CancelledError:
        error = "cancelled"
        log.write("cancelled")
        exit_code = EXIT_CANCELLED
    except DeadlineError as e:
        error = "deadline: {}".format(e)
        log.write(error)
        exit_code = EXIT_REQ_ERROR
    except SystemExit:
        pass  # handled above via phase="done"
    except Exception as e:
        error = "internal: {}".format(e)
        log.write(error)
        exit_code = EXIT_REQ_ERROR
    finally:
        _clear_deadline()
        if slot_fd is not None:
            _release_slot(slot_fd)
            log.write("slot released")
        _protected_active = False

        # Partial durations on interruption: update active phase
        now = time.monotonic()
        if phase == "queue":
            queue_s = now - phase_start
        elif phase == "probe":
            probe_s = now - phase_start
        elif phase == "request":
            request_s = now - phase_start

        total_s = now - t_total

        # Build meta
        meta: Dict[str, Any] = {
            "status": ("cancelled" if exit_code == EXIT_CANCELLED
                       else "ok" if exit_code == EXIT_OK else "error"),
            "exit_code": exit_code, "pid": os.getpid(),
            "proc_start_time": _proc_start_ticks(os.getpid()),
            "slot": slot_num, "effort": "low",
            "model_root": model_root, "max_model_len": max_model_len,
            "finish_reason": finish_reason, "usage": usage,
            "queue_seconds": round(queue_s, 3),
            "probe_seconds": round(probe_s, 3),
            "request_seconds": round(request_s, 3),
            "total_seconds": round(total_s, 3),
            "prompt_sha256": prompt_sha,
            "snapshot_path": snapshot_abs,
            "snapshot_sha256": snapshot_sha,
            "content_sha256": "",
            "post_attempts": post_attempts, "error": error,
        }

        # Write outputs; robust finalizer - never crash on malformed reply
        content = ""
        reasoning = ""
        try:
            if reply is not None and isinstance(reply, dict):
                _atomic_write(os.path.join(out_dir, "reply.json"),
                              json.dumps(reply, indent=1, ensure_ascii=False))
                choices = reply.get("choices")
                if isinstance(choices, list) and len(choices) > 0:
                    ch = choices[0]
                    if isinstance(ch, dict):
                        msg = ch.get("message")
                        if isinstance(msg, dict):
                            content = _normalize_str(msg.get("content"))
                            reasoning = _normalize_str(
                                msg.get("reasoning") or msg.get("reasoning_content"))
            elif reply is not None:
                # reply is scalar/list - write raw JSON anyway
                _atomic_write(os.path.join(out_dir, "reply.json"),
                              json.dumps(reply, indent=1, ensure_ascii=False))
        except Exception as e:
            if exit_code == EXIT_OK:
                exit_code = EXIT_REQ_ERROR
                if error is None:
                    error = "reply.json write failed: {}".format(e)
            content = ""
            reasoning = ""

        # Ensure content and reasoning are strings (belt-and-suspenders)
        if not isinstance(content, str):
            content = ""
        if not isinstance(reasoning, str):
            reasoning = ""

        write_err = None
        try:
            _atomic_write(os.path.join(out_dir, "content.md"), content)
        except Exception as e:
            write_err = "content.md write failed: {}".format(e)
            if exit_code == EXIT_OK:
                exit_code = EXIT_REQ_ERROR
                if error is None:
                    error = write_err
        try:
            _atomic_write(os.path.join(out_dir, "reasoning.md"), reasoning)
        except Exception as e:
            write_err = "reasoning.md write failed: {}".format(e)
            if exit_code == EXIT_OK:
                exit_code = EXIT_REQ_ERROR
                if error is None:
                    error = write_err
        meta["content_sha256"] = _sha256_bytes(content.encode("utf-8"))
        meta.update(exit_code=exit_code, error=error,
                    status="cancelled" if exit_code == EXIT_CANCELLED else "ok" if exit_code == EXIT_OK else "error")

        try:
            _atomic_write(os.path.join(out_dir, "meta.json"),
                          json.dumps(meta, indent=1, ensure_ascii=False))
        except Exception as e:
            sys.stderr.write("FATAL: meta.json write failed: {}\n".format(e))
            sys.stderr.write("unresolved evidence: exit_code={}\n".format(exit_code))
            os._exit(EXIT_REQ_ERROR)
        try:
            _atomic_write(os.path.join(out_dir, "exit_code"), str(exit_code))
        except Exception as e:
            sys.stderr.write("FATAL: exit_code write failed: {}\n".format(e))
            sys.stderr.write("unresolved evidence: exit_code={}\n".format(exit_code))
            os._exit(EXIT_REQ_ERROR)

    return exit_code


# --- detach (fork-based) ---

def _do_detach(prompt_path: str, out_dir: str, url: str, lockdir: str,
               max_tokens: int, temperature: float, queue_timeout: float,
               timeout: float, snapshot_path: Optional[str],
               repo_path: Optional[str]) -> int:
    # Create parent directories if needed
    parent = os.path.dirname(os.path.abspath(out_dir))
    try:
        os.makedirs(parent, exist_ok=True)
    except OSError as e:
        sys.stderr.write("error: cannot create parent dir: {}\n".format(e))
        return EXIT_INVALID
    try:
        os.mkdir(out_dir)
    except FileExistsError:
        sys.stderr.write("error: output dir '{}' already exists\n".format(out_dir))
        return EXIT_INVALID
    except OSError as e:
        sys.stderr.write("error: cannot create output dir: {}\n".format(e))
        return EXIT_INVALID

    r_fd, w_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        # child
        os.close(r_fd)
        os.setsid()
        # Install signal handlers BEFORE publishing handshake
        _install_signals()
        # redirect stdio
        log_path = os.path.join(out_dir, "run.log")
        log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.dup2(log_fd, 1)
        os.dup2(log_fd, 2)
        os.close(log_fd)
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
        # write running meta FIRST
        my_pid = os.getpid()
        start_ticks = _proc_start_ticks(my_pid)
        snapshot_abs = os.path.abspath(snapshot_path) if snapshot_path else None
        running_meta: Dict[str, Any] = {
            "status": "running", "exit_code": None, "pid": my_pid,
            "proc_start_time": start_ticks, "slot": None, "effort": "low",
            "model_root": None, "max_model_len": None, "finish_reason": None,
            "usage": None, "queue_seconds": None, "probe_seconds": None,
            "request_seconds": None, "total_seconds": None,
            "prompt_sha256": None,
            "snapshot_path": snapshot_abs,
            "snapshot_sha256": None, "content_sha256": None,
            "post_attempts": 0, "error": None,
        }
        try:
            _atomic_write(os.path.join(out_dir, "meta.json"),
                          json.dumps(running_meta, indent=1, ensure_ascii=False))
        except Exception:
            pass
        # signal parent ready
        os.write(w_fd, b"\x01")
        os.close(w_fd)
        # execute core
        log = _RunLog(log_path)
        log.write("child start pid={}".format(my_pid))
        code = _execute(prompt_path, out_dir, url, lockdir, max_tokens,
                        temperature, queue_timeout, timeout,
                        snapshot_path, repo_path, log)
        log.write("child done exit={}".format(code))
        log.close()
        os._exit(code)
    # parent
    os.close(w_fd)
    data = os.read(r_fd, 1)
    os.close(r_fd)
    if not data:
        sys.stderr.write("error: child failed to initialize\n")
        return EXIT_REQ_ERROR
    print("DETACHED pid={} out={}".format(pid, out_dir))
    print("  poll: {} --wait {}".format(os.path.abspath(__file__), out_dir))
    return EXIT_OK


# --- wait ---

def _do_wait(out_dir: str, max_wait: float) -> int:
    ec_path = os.path.join(out_dir, "exit_code")
    meta_path = os.path.join(out_dir, "meta.json")
    log_path = os.path.join(out_dir, "run.log")

    # Validate metadata exists and is parseable
    if not os.path.exists(meta_path):
        sys.stderr.write("wait: no meta.json in {}\n".format(out_dir))
        return EXIT_INVALID
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            m = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        sys.stderr.write("wait: malformed meta.json: {}\n".format(e))
        return EXIT_INVALID
    if not isinstance(m, dict):
        sys.stderr.write("wait: meta.json not a dict\n")
        return EXIT_INVALID

    child_pid = m.get("pid")
    child_start = m.get("proc_start_time")
    if not isinstance(child_pid, int) or child_pid <= 1:
        sys.stderr.write("wait: invalid pid in meta\n")
        return EXIT_INVALID
    if not isinstance(child_start, int):
        sys.stderr.write("wait: invalid proc_start_time in meta\n")
        return EXIT_INVALID

    t_end = time.monotonic() + max_wait
    while time.monotonic() < t_end:
        # Check for terminal exit_code
        if os.path.exists(ec_path):
            try:
                with open(ec_path, "r") as f:
                    code = int(f.read().strip())
            except (ValueError, OSError):
                sys.stderr.write("wait: malformed exit_code file\n")
                return EXIT_REQ_ERROR
            # Verify meta is terminal and consistent
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    final_meta = json.load(f)
            except (json.JSONDecodeError, OSError):
                sys.stderr.write("wait: cannot read final meta\n")
                return EXIT_REQ_ERROR
            if not isinstance(final_meta, dict):
                sys.stderr.write("wait: final meta not a dict\n")
                return EXIT_REQ_ERROR
            final_status = final_meta.get("status")
            final_exit = final_meta.get("exit_code")
            # Reject false success: status must be terminal, exit_code must match
            if final_status == "running":
                sys.stderr.write("wait: meta still says running but exit_code exists\n")
                return EXIT_REQ_ERROR
            if final_exit != code:
                sys.stderr.write("wait: meta exit_code {} != file exit_code {}\n".format(
                    final_exit, code))
                return EXIT_REQ_ERROR
            if code == EXIT_OK and final_status != "ok":
                sys.stderr.write("wait: exit_code 0 but status='{}'\n".format(final_status))
                return EXIT_REQ_ERROR
            # Print meta
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    print(f.read())
            except OSError:
                pass
            if code != EXIT_OK and os.path.exists(log_path):
                try:
                    with open(log_path, "r", encoding="utf-8") as f:
                        sys.stderr.write(f.read()[-4000:])
                except OSError:
                    pass
            return code

        # Validate process identity each iteration (detect PID reuse)
        if not _pid_alive(child_pid):
            sys.stderr.write("unresolved: child pid {} dead without terminal\n".format(child_pid))
            if os.path.exists(log_path):
                try:
                    with open(log_path, "r", encoding="utf-8") as f:
                        sys.stderr.write(f.read()[-4000:])
                except OSError:
                    pass
            return EXIT_REQ_ERROR
        actual_start = _proc_start_ticks(child_pid)
        if actual_start is None:
            sys.stderr.write("unresolved: child pid {} gone\n".format(child_pid))
            return EXIT_REQ_ERROR
        if actual_start != child_start:
            sys.stderr.write("unresolved: pid {} reused (start mismatch)\n".format(child_pid))
            return EXIT_REQ_ERROR

        time.sleep(min(0.5, max(0, t_end - time.monotonic())))
    sys.stderr.write("PENDING: call --wait {} again\n".format(out_dir))
    return EXIT_PENDING


# --- cancel ---

def _do_cancel(out_dir: str) -> int:
    ec_path = os.path.join(out_dir, "exit_code")
    if os.path.exists(ec_path):
        return EXIT_OK  # already terminal
    meta_path = os.path.join(out_dir, "meta.json")
    if not os.path.exists(meta_path):
        sys.stderr.write("cancel: no meta.json\n")
        return EXIT_INVALID
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        sys.stderr.write("cancel: cannot read meta: {}\n".format(e))
        return EXIT_INVALID
    if not isinstance(meta, dict):
        sys.stderr.write("cancel: meta not a dict\n")
        return EXIT_INVALID
    pid = meta.get("pid")
    expected_start = meta.get("proc_start_time")
    if not isinstance(pid, int) or pid <= 1:
        sys.stderr.write("cancel: invalid pid\n")
        return EXIT_INVALID
    if not isinstance(expected_start, int):
        sys.stderr.write("cancel: invalid proc_start_time in meta\n")
        return EXIT_INVALID
    actual_start = _proc_start_ticks(pid)
    if actual_start is None:
        sys.stderr.write("cancel: pid {} gone\n".format(pid))
        return EXIT_OK
    if actual_start != expected_start:
        sys.stderr.write("cancel: pid {} identity mismatch\n".format(pid))
        return EXIT_INVALID
    try:
        os.kill(pid, signal.SIGTERM)
        print("cancel: SIGTERM sent to {}".format(pid))
        return EXIT_OK
    except OSError as e:
        if e.errno == errno.ESRCH:
            return EXIT_OK
        sys.stderr.write("cancel: kill failed: {}\n".format(e))
        return EXIT_REQ_ERROR


# --- main ---

def main(argv: Optional[list] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    # subcommands
    if argv and argv[0] == "--wait":
        if len(argv) < 2:
            sys.stderr.write("usage: --wait OUT_DIR [--max-wait N]\n")
            return EXIT_INVALID
        mw = 45.0
        if "--max-wait" in argv:
            try:
                mw = float(argv[argv.index("--max-wait") + 1])
            except (IndexError, ValueError):
                return EXIT_INVALID
        if mw <= 0 or not math.isfinite(mw):
            return EXIT_INVALID
        # Reject unknown args
        known_wait = {"--wait", "--max-wait"}
        for i, a in enumerate(argv):
            if a.startswith("-") and a not in known_wait:
                sys.stderr.write("wait: unknown argument '{}'\n".format(a))
                return EXIT_INVALID
            if a == "--max-wait" and i + 1 < len(argv):
                continue  # skip value
        return _do_wait(argv[1], mw)

    if argv and argv[0] == "--cancel":
        if len(argv) < 2:
            sys.stderr.write("usage: --cancel OUT_DIR\n")
            return EXIT_INVALID
        if len(argv) > 2:
            sys.stderr.write("cancel: unexpected extra arguments\n")
            return EXIT_INVALID
        if argv[1].startswith("-"):
            sys.stderr.write("cancel: unknown argument '{}'\n".format(argv[1]))
            return EXIT_INVALID
        return _do_cancel(argv[1])

    # parse
    parser = argparse.ArgumentParser(description="Call Jarvis with slot flock.")
    parser.add_argument("prompt", nargs="?", help="Prompt file")
    parser.add_argument("out", nargs="?", help="Output directory")
    parser.add_argument("--max-tokens", type=int, default=32768)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--queue-timeout", type=float, default=1200.0)
    parser.add_argument("--timeout", type=float, default=1200.0)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--lock-dir", default=DEFAULT_LOCKDIR)
    parser.add_argument("--effort", default="low")
    parser.add_argument("--detach", action="store_true")
    parser.add_argument("--snapshot", default=None)
    parser.add_argument("--repo", default=None)

    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return EXIT_OK if e.code == 0 else EXIT_INVALID

    if not args.prompt or not args.out:
        sys.stderr.write("error: PROMPT and OUT required\n")
        return EXIT_INVALID
    if args.effort != "low":
        sys.stderr.write("error: --effort must be 'low'\n")
        return EXIT_INVALID
    if args.max_tokens <= 0 or args.max_tokens > MAX_OUTPUT_TOKENS:
        sys.stderr.write("error: --max-tokens must be 1..{}\n".format(MAX_OUTPUT_TOKENS))
        return EXIT_INVALID
    if not math.isfinite(args.temperature) or args.temperature < 0:
        sys.stderr.write("error: --temperature must be non-negative finite\n")
        return EXIT_INVALID
    if not math.isfinite(args.queue_timeout) or args.queue_timeout <= 0:
        sys.stderr.write("error: --queue-timeout must be positive finite\n")
        return EXIT_INVALID
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        sys.stderr.write("error: --timeout must be positive finite\n")
        return EXIT_INVALID
    if not os.path.isfile(args.prompt):
        sys.stderr.write("error: prompt not found: {}\n".format(args.prompt))
        return EXIT_INVALID
    if (args.snapshot and not args.repo) or (args.repo and not args.snapshot):
        sys.stderr.write("error: --snapshot and --repo must be paired\n")
        return EXIT_INVALID

    if args.detach:
        return _do_detach(args.prompt, args.out, args.url, args.lock_dir,
                          args.max_tokens, args.temperature,
                          args.queue_timeout, args.timeout,
                          args.snapshot, args.repo)

    # foreground: create parent dirs, claim output dir atomically
    parent = os.path.dirname(os.path.abspath(args.out))
    try:
        os.makedirs(parent, exist_ok=True)
    except OSError as e:
        sys.stderr.write("error: cannot create parent dir: {}\n".format(e))
        return EXIT_INVALID
    try:
        os.mkdir(args.out)
    except FileExistsError:
        sys.stderr.write("error: output dir '{}' exists\n".format(args.out))
        return EXIT_INVALID
    except OSError as e:
        sys.stderr.write("error: cannot create output dir: {}\n".format(e))
        return EXIT_INVALID

    _install_signals()
    log = _RunLog(os.path.join(args.out, "run.log"))
    log.write("start pid={} prompt={}".format(os.getpid(), args.prompt))

    # Publish initial PID/start meta for --cancel and --wait during queue
    my_pid = os.getpid()
    start_ticks = _proc_start_ticks(my_pid)
    snapshot_abs = os.path.abspath(args.snapshot) if args.snapshot else None
    running_meta: Dict[str, Any] = {
        "status": "running", "exit_code": None, "pid": my_pid,
        "proc_start_time": start_ticks, "slot": None, "effort": "low",
        "model_root": None, "max_model_len": None, "finish_reason": None,
        "usage": None, "queue_seconds": None, "probe_seconds": None,
        "request_seconds": None, "total_seconds": None,
        "prompt_sha256": None,
        "snapshot_path": snapshot_abs,
        "snapshot_sha256": None, "content_sha256": None,
        "post_attempts": 0, "error": None,
    }
    try:
        _atomic_write(os.path.join(args.out, "meta.json"),
                      json.dumps(running_meta, indent=1, ensure_ascii=False))
    except Exception:
        pass

    code = _execute(args.prompt, args.out, args.url, args.lock_dir,
                    args.max_tokens, args.temperature,
                    args.queue_timeout, args.timeout,
                    args.snapshot, args.repo, log)
    log.write("done exit={}".format(code))
    log.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
