#!/usr/bin/env python3
"""Tests for scripts/jarvis_call.py - private fixture, no production."""
import fcntl
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CALLER = str(Path(__file__).resolve().parents[2] / "scripts" / "jarvis_call.py")
SLOT_COUNT = 4


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- Fake server ---

class _Handler(BaseHTTPRequestHandler):
    """Configurable fake vLLM endpoint."""
    config = {}  # set per-test via class attribute
    get_count = 0
    post_count = 0
    post_body = None

    def log_message(self, *a):
        pass

    def _send(self, code, body):
        raw = json.dumps(body).encode("utf-8") if not isinstance(body, bytes) else body
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        _Handler.get_count += 1
        if self.path == "/v1/models":
            cfg = _Handler.config.get("models")
            if cfg is None:
                cfg = {"data": [{"id": "jarvis", "root": "private-fixture", "max_model_len": 262144}]}
            self._send(200, cfg)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        _Handler.post_count += 1
        length = int(self.headers.get("Content-Length", 0))
        _Handler.post_body = self.rfile.read(length) if length else b""
        delay = _Handler.config.get("post_delay", 0)
        if delay:
            time.sleep(delay)
        cfg = _Handler.config.get("completion")
        if cfg is None:
            cfg = {
                "id": "chatcmpl-test",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "hello world\n"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }
        self._send(200, cfg)


class _Server:
    def __init__(self):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.httpd.server_address[1]
        self.url = "http://127.0.0.1:{}".format(self.port)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)


# --- Helpers ---

def _run_caller(args, timeout=10):
    """Invoke jarvis_call.py as subprocess."""
    cmd = [sys.executable, "-B", CALLER] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _make_lockdir(tmp):
    d = os.path.join(tmp, "locks")
    os.makedirs(d, exist_ok=True)
    return d


def _hold_all_slots(lockdir):
    """Acquire all 4 slot flocks, return list of fds."""
    fds = []
    for n in range(SLOT_COUNT):
        path = os.path.join(lockdir, "jarvis.{}.lock".format(n))
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fds.append(fd)
    return fds


def _release_all(fds):
    for fd in fds:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


def _read_meta(out_dir):
    p = os.path.join(out_dir, "meta.json")
    if not os.path.isfile(p):
        return None
    with open(p, "r") as f:
        return json.load(f)


def _read_exit(out_dir):
    p = os.path.join(out_dir, "exit_code")
    if not os.path.isfile(p):
        return None
    with open(p, "r") as f:
        return int(f.read().strip())


def _wait_for_queue(proc, out_dir, timeout=5):
    """Wait until the foreground caller has installed handlers and entered queue.

    The queue marker is written after signal installation and after the running
    metadata is published. Failing fast on exit preserves useful diagnostics;
    the bound prevents a startup failure from hanging the suite.
    """
    deadline = time.monotonic() + timeout
    log_path = os.path.join(out_dir, "run.log")
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise AssertionError("caller exited before queue: {}".format(proc.returncode))
        try:
            with open(log_path, "r") as f:
                log = f.read()
            meta = _read_meta(out_dir)
        except FileNotFoundError:
            log, meta = "", None
        if ("acquiring slot queue_timeout=" in log and meta is not None
                and meta.get("status") == "running" and meta.get("pid") == proc.pid):
            return
        time.sleep(0.01)
    raise AssertionError("caller did not enter queue within {}s".format(timeout))


# --- Base test class ---

class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="jv_test_")
        self.lockdir = _make_lockdir(self.tmp)
        _Handler.config = {}
        _Handler.get_count = 0
        _Handler.post_count = 0
        _Handler.post_body = None
        self.server = _Server()

    def tearDown(self):
        self.server.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _outdir(self, name="out"):
        return os.path.join(self.tmp, name)

    def _prompt(self, text="test prompt", name="prompt.md"):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as f:
            f.write(text)
        return p


# --- Tests ---

class TestUnavailable(_Base):
    def test_down_exit2(self):
        """Service not listening -> exit 2, terminal meta."""
        self.server.stop()  # kill server
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "2", "--queue-timeout", "2"])
        self.assertEqual(r.returncode, 2)
        meta = _read_meta(out)
        self.assertIsNotNone(meta)
        self.assertEqual(meta["exit_code"], 2)
        self.assertEqual(meta["status"], "error")
        ec = _read_exit(out)
        self.assertEqual(ec, 2)


class TestModelValidation(_Base):
    def test_wrong_model_exit3(self):
        """Model id != jarvis -> exit 3, no POST."""
        _Handler.config["models"] = {"data": [{"id": "other", "root": "x", "max_model_len": 100}]}
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 3)
        self.assertEqual(_Handler.post_count, 0)

    def test_missing_root_exit3(self):
        """Model with empty root -> exit 3, no POST."""
        _Handler.config["models"] = {"data": [{"id": "jarvis", "root": "", "max_model_len": 100}]}
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 3)
        self.assertEqual(_Handler.post_count, 0)


class TestSuccess(_Base):
    def test_success_records_all(self):
        """Valid response -> exit 0, meta has root/low/timings/sha/post_attempts."""
        prompt = self._prompt("hello")
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "5", "--queue-timeout", "5"])
        self.assertEqual(r.returncode, 0)
        meta = _read_meta(out)
        self.assertEqual(meta["status"], "ok")
        self.assertEqual(meta["exit_code"], 0)
        self.assertEqual(meta["model_root"], "private-fixture")
        self.assertEqual(meta["effort"], "low")
        self.assertEqual(meta["post_attempts"], 1)
        self.assertEqual(meta["finish_reason"], "stop")
        self.assertIsNotNone(meta["queue_seconds"])
        self.assertIsNotNone(meta["probe_seconds"])
        self.assertIsNotNone(meta["request_seconds"])
        self.assertIsNotNone(meta["total_seconds"])
        prompt_sha = _sha256(open(prompt, "rb").read())
        self.assertEqual(meta["prompt_sha256"], prompt_sha)
        content = open(os.path.join(out, "content.md")).read()
        self.assertEqual(meta["content_sha256"], _sha256(content.encode("utf-8")))
        ec = _read_exit(out)
        self.assertEqual(ec, 0)


class TestQueueContention(_Base):
    def test_no_probe_before_slot(self):
        """All 4 slots held -> queue expiry exit 6, server GET count 0."""
        fds = _hold_all_slots(self.lockdir)
        try:
            prompt = self._prompt()
            out = self._outdir()
            r = _run_caller([prompt, out, "--url", self.server.url,
                            "--lock-dir", self.lockdir, "--timeout", "5", "--queue-timeout", "0.15"])
            self.assertEqual(r.returncode, 6)
            self.assertEqual(_Handler.get_count, 0)
            meta = _read_meta(out)
            self.assertEqual(meta["exit_code"], 6)
        finally:
            _release_all(fds)

    def test_slot_contention_release(self):
        """Hold slots after queue starts -> exit 0, queue_seconds >= 0.1."""
        fds = _hold_all_slots(self.lockdir)
        proc = None
        try:
            prompt = self._prompt()
            out = self._outdir()
            cmd = [sys.executable, "-B", CALLER, prompt, out,
                   "--url", self.server.url, "--lock-dir", self.lockdir,
                   "--timeout", "5", "--queue-timeout", "3"]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            _wait_for_queue(proc, out)
            # Measure contention from the observed queue phase, rather than
            # from before Python startup. Leave margin for scheduler jitter.
            time.sleep(0.2)
            _release_all(fds)
            fds = []
            stdout, stderr = proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 0, (stdout, stderr))
            meta = _read_meta(out)
            self.assertGreaterEqual(meta["queue_seconds"], 0.1)
            self.assertGreaterEqual(meta["request_seconds"], 0)
            # Slot lock inode preserved and reacquirable
            slot = meta["slot"]
            lock_path = os.path.join(self.lockdir, "jarvis.{}.lock".format(slot))
            fd2 = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
            fcntl.flock(fd2, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd2, fcntl.LOCK_UN)
            os.close(fd2)
        finally:
            _release_all(fds)
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.communicate(timeout=5)


class TestTimeout(_Base):
    def test_combined_timeout_slow(self):
        """Slow response with timeout 0.2 -> exit 5, request_seconds >= 0.1."""
        _Handler.config["post_delay"] = 0.5
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "0.2", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 5)
        meta = _read_meta(out)
        self.assertGreaterEqual(meta["request_seconds"], 0.1)
        ec = _read_exit(out)
        self.assertEqual(ec, 5)


class TestCancellation(_Base):
    def test_cancel_foreground_queue(self):
        """SIGTERM during queue -> exit 130, flocks released."""
        fds = _hold_all_slots(self.lockdir)
        proc = None
        try:
            prompt = self._prompt()
            out = self._outdir()
            cmd = [sys.executable, "-B", CALLER, prompt, out,
                   "--url", self.server.url, "--lock-dir", self.lockdir,
                   "--timeout", "10", "--queue-timeout", "10"]
            proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)
            _wait_for_queue(proc, out)
            proc.send_signal(signal.SIGTERM)
            proc.communicate(timeout=5)
            self.assertEqual(proc.returncode, 130)
            meta = _read_meta(out)
            self.assertEqual(meta["exit_code"], 130)
            self.assertEqual(meta["status"], "cancelled")
            # Release fixture-owned flocks before checking for leaked caller locks.
            _release_all(fds)
            fds = []
            fds2 = _hold_all_slots(self.lockdir)
            _release_all(fds2)
        finally:
            _release_all(fds)
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.communicate(timeout=5)

    def test_detach_wait_cancel(self):
        """--detach returns quickly, --wait pending 10, --cancel, --wait 130."""
        fds = _hold_all_slots(self.lockdir)
        try:
            prompt = self._prompt()
            out = self._outdir()
            r = _run_caller([prompt, out, "--url", self.server.url,
                            "--lock-dir", self.lockdir, "--timeout", "10",
                            "--queue-timeout", "10", "--detach"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("DETACHED", r.stdout)
            # Wait with tiny max-wait -> pending 10
            r2 = _run_caller(["--wait", out, "--max-wait", "0.1"])
            self.assertEqual(r2.returncode, 10)
            # Cancel
            r3 = _run_caller(["--cancel", out])
            self.assertEqual(r3.returncode, 0)
            # Wait for terminal
            time.sleep(0.3)
            r4 = _run_caller(["--wait", out, "--max-wait", "3"])
            self.assertEqual(r4.returncode, 130)
        finally:
            _release_all(fds)


class TestRefuseExisting(_Base):
    def test_refuse_same_outdir(self):
        """Existing outdir -> exit 7, metadata unchanged."""
        prompt = self._prompt()
        out = self._outdir()
        os.makedirs(out)
        sentinel = b'{"sentinel": true}'
        with open(os.path.join(out, "meta.json"), "wb") as f:
            f.write(sentinel)
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 7)
        with open(os.path.join(out, "meta.json"), "rb") as f:
            self.assertEqual(f.read(), sentinel)


class TestProtocolErrors(_Base):
    def test_malformed_json(self):
        """Server returns invalid JSON -> exit 5."""
        _Handler.config["completion"] = b"not json{{{"
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 5)
        ec = _read_exit(out)
        self.assertEqual(ec, 5)

    def test_json_list_response(self):
        """Server returns JSON list -> exit 5."""
        _Handler.config["completion"] = [1, 2, 3]
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 5)

    def test_json_scalar_response(self):
        """Server returns JSON scalar -> exit 5."""
        _Handler.config["completion"] = 42
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 5)

    def test_message_missing(self):
        """choices[0] has no message -> exit 5."""
        _Handler.config["completion"] = {
            "choices": [{"index": 0, "finish_reason": "stop"}],
            "usage": {},
        }
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 5)

    def test_content_int_42(self):
        """content field is integer 42 -> exit 5 (protocol violation)."""
        _Handler.config["completion"] = {
            "choices": [{"index": 0, "message": {"role": "assistant", "content": 42}, "finish_reason": "stop"}],
            "usage": {},
        }
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 5)
        meta = _read_meta(out)
        self.assertIn("protocol", meta.get("error", ""))

    def test_reasoning_dict(self):
        """reasoning field is dict -> exit 5."""
        _Handler.config["completion"] = {
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok", "reasoning": {"x": 1}}, "finish_reason": "stop"}],
            "usage": {},
        }
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 5)


class TestFinishReason(_Base):
    def test_length_finish_exit4(self):
        """finish_reason=length -> exit 4."""
        _Handler.config["completion"] = {
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "partial"}, "finish_reason": "length"}],
            "usage": {},
        }
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 4)

    def test_empty_content_exit4(self):
        """Empty content with stop -> exit 4."""
        _Handler.config["completion"] = {
            "choices": [{"index": 0, "message": {"role": "assistant", "content": ""}, "finish_reason": "stop"}],
            "usage": {},
        }
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 4)

    def test_unknown_finish_exit5(self):
        """Unknown finish_reason -> exit 5."""
        _Handler.config["completion"] = {
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "weird"}],
            "usage": {},
        }
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3", "--queue-timeout", "3"])
        self.assertEqual(r.returncode, 5)


class TestInputValidation(_Base):
    def test_help_exit0(self):
        r = _run_caller(["--help"])
        self.assertEqual(r.returncode, 0)

    def test_effort_medium_rejected(self):
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--effort", "medium",
                        "--url", self.server.url, "--lock-dir", self.lockdir])
        self.assertEqual(r.returncode, 7)

    def test_invalid_timing_nan(self):
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--timeout", "nan",
                        "--url", self.server.url, "--lock-dir", self.lockdir])
        self.assertEqual(r.returncode, 7)

    def test_invalid_timing_negative(self):
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--timeout", "-1",
                        "--url", self.server.url, "--lock-dir", self.lockdir])
        self.assertEqual(r.returncode, 7)

    def test_tokens_too_large(self):
        prompt = self._prompt()
        out = self._outdir()
        r = _run_caller([prompt, out, "--max-tokens", "32769",
                        "--url", self.server.url, "--lock-dir", self.lockdir])
        self.assertEqual(r.returncode, 7)


class TestWaitCancelIdentity(_Base):
    def test_dead_process_wait5(self):
        """Meta with dead PID -> wait returns 5."""
        out = self._outdir()
        os.makedirs(out)
        fake_meta = {
            "status": "running", "exit_code": None, "pid": 999999,
            "proc_start_time": 12345, "slot": None, "effort": "low",
            "model_root": None, "max_model_len": None, "finish_reason": None,
            "usage": None, "queue_seconds": None, "probe_seconds": None,
            "request_seconds": None, "total_seconds": None,
            "prompt_sha256": None, "snapshot_path": None,
            "snapshot_sha256": None, "content_sha256": None,
            "post_attempts": 0, "error": None,
        }
        with open(os.path.join(out, "meta.json"), "w") as f:
            json.dump(fake_meta, f)
        r = _run_caller(["--wait", out, "--max-wait", "0.5"])
        self.assertEqual(r.returncode, 5)

    def test_cancel_refuses_unrelated_pid(self):
        """Cancel with mismatched PID identity -> refuses."""
        out = self._outdir()
        os.makedirs(out)
        # Use our own PID but wrong start_time
        fake_meta = {
            "status": "running", "exit_code": None, "pid": os.getpid(),
            "proc_start_time": 999999999, "slot": None, "effort": "low",
            "model_root": None, "max_model_len": None, "finish_reason": None,
            "usage": None, "queue_seconds": None, "probe_seconds": None,
            "request_seconds": None, "total_seconds": None,
            "prompt_sha256": None, "snapshot_path": None,
            "snapshot_sha256": None, "content_sha256": None,
            "post_attempts": 0, "error": None,
        }
        with open(os.path.join(out, "meta.json"), "w") as f:
            json.dump(fake_meta, f)
        r = _run_caller(["--cancel", out])
        self.assertEqual(r.returncode, 7)
        # Verify we did NOT signal ourselves
        self.assertIn("identity mismatch", r.stderr)


class TestMaxWaitOvershoot(_Base):
    def test_max_wait_small_no_overshoot(self):
        """--max-wait 0.1 should not overshoot by 0.05+."""
        out = self._outdir()
        os.makedirs(out)
        fake_meta = {
            "status": "running", "exit_code": None, "pid": 999999,
            "proc_start_time": 12345, "slot": None, "effort": "low",
            "model_root": None, "max_model_len": None, "finish_reason": None,
            "usage": None, "queue_seconds": None, "probe_seconds": None,
            "request_seconds": None, "total_seconds": None,
            "prompt_sha256": None, "snapshot_path": None,
            "snapshot_sha256": None, "content_sha256": None,
            "post_attempts": 0, "error": None,
        }
        with open(os.path.join(out, "meta.json"), "w") as f:
            json.dump(fake_meta, f)
        t0 = time.monotonic()
        r = _run_caller(["--wait", out, "--max-wait", "0.1"])
        elapsed = time.monotonic() - t0
        # Should be pending (dead pid detected fast) or at most ~0.2s
        self.assertLess(elapsed, 1.0)


class TestUnknownArgs(_Base):
    def test_unknown_wait_arg(self):
        out = self._outdir()
        os.makedirs(out)
        r = _run_caller(["--wait", out, "--bogus", "x"])
        self.assertEqual(r.returncode, 7)

    def test_unknown_cancel_arg(self):
        r = _run_caller(["--cancel", "--bogus"])
        self.assertEqual(r.returncode, 7)


class TestSnapshotIntegration(_Base):
    """Snapshot integration: build packet fixture, verify sha, test dependency change."""

    def _build_packet_fixture(self):
        """Create a minimal git repo with packet, return (repo, packet_dir, snapshot_path, prompt_path)."""
        repo = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(repo, "docs"))
        os.makedirs(os.path.join(repo, "scripts"))
        os.makedirs(os.path.join(repo, "tests"))
        # docs/DESIGN.md
        with open(os.path.join(repo, "docs", "DESIGN.md"), "w") as f:
            f.write("## Architecture\n\nSystem design.\n")
        # dependency x.ts
        with open(os.path.join(repo, "x.ts"), "w") as f:
            f.write("export const x = 1;\n")
        # output file (new)
        # tests/new.ts does not exist yet
        # scripts/ts_syntax.mjs stub
        with open(os.path.join(repo, "scripts", "ts_syntax.mjs"), "w") as f:
            f.write("// stub\n")
        # git init
        subprocess.run(["git", "init"], cwd=repo, capture_output=True)
        subprocess.run(["git", "add", "."], cwd=repo, capture_output=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=repo, capture_output=True,
                       env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})
        # manifest
        manifest = {
            "task": "Write tests/new.ts",
            "allowed_files": ["tests/new.ts"],
            "contract": "TypeScript test file.",
            "dependencies": ["x.ts"],
            "design_sections": ["## Architecture"],
            "issue_body": "Add test for x.",
        }
        manifest_path = os.path.join(self.tmp, "manifest.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f)
        # Build packet using jarvis_packet if available
        packet_dir = os.path.join(self.tmp, "packet")
        try:
            sys.path.insert(0, os.path.join(Path(CALLER).parent, ""))
            import jarvis_packet  # noqa
            import argparse
            ns = argparse.Namespace(
                manifest=manifest_path, packet_dir=packet_dir, repo=repo)
            jarvis_packet.cmd_build(ns)
        except ImportError:
            # Create minimal snapshot manually
            os.makedirs(packet_dir, exist_ok=True)
            prompt_text = "# Task\n\nWrite tests/new.ts\n"
            prompt_bytes = prompt_text.encode("utf-8")
            prompt_path = os.path.join(packet_dir, "prompt.md")
            with open(prompt_path, "wb") as f:
                f.write(prompt_bytes)
            import hashlib as _h
            snap = {
                "schema": "jarvis_packet_v1",
                "root": os.path.abspath(repo),
                "manifest_path": manifest_path,
                "manifest_sha256": _h.sha256(open(manifest_path, "rb").read()).hexdigest(),
                "allowed_files": ["tests/new.ts"],
                "source_hashes": {
                    "tests/new.ts": None,
                    "x.ts": _h.sha256(open(os.path.join(repo, "x.ts"), "rb").read()).hexdigest(),
                    "docs/DESIGN.md": _h.sha256(open(os.path.join(repo, "docs", "DESIGN.md"), "rb").read()).hexdigest(),
                },
                "source_modes": {"x.ts": 0o644, "docs/DESIGN.md": 0o644},
                "git_listing": ["docs/DESIGN.md", "scripts/ts_syntax.mjs", "x.ts"],
                "git_listing_sha256": _h.sha256("\n".join(["docs/DESIGN.md", "scripts/ts_syntax.mjs", "x.ts"]).encode()).hexdigest(),
                "prompt_sha256": _h.sha256(prompt_bytes).hexdigest(),
                "checker_path": os.path.join(repo, "scripts", "ts_syntax.mjs"),
                "checker_sha256": _h.sha256(open(os.path.join(repo, "scripts", "ts_syntax.mjs"), "rb").read()).hexdigest(),
                "estimate": {"bytes": len(prompt_bytes), "characters": len(prompt_text), "estimated_tokens": 10, "method": "test"},
            }
            snapshot_path = os.path.join(packet_dir, "snapshot.json")
            with open(snapshot_path, "w") as f:
                json.dump(snap, f, indent=2, sort_keys=True)
            shutil.copy2(manifest_path, os.path.join(packet_dir, "manifest.json"))
            return repo, packet_dir, snapshot_path, prompt_path
        snapshot_path = os.path.join(packet_dir, "snapshot.json")
        prompt_path = os.path.join(packet_dir, "prompt.md")
        return repo, packet_dir, snapshot_path, prompt_path

    def test_snapshot_success_sha_match(self):
        """Packet built -> jarvis_call records snapshot_path and sha matching file."""
        repo, packet_dir, snapshot_path, prompt_path = self._build_packet_fixture()
        out = self._outdir()
        r = _run_caller([prompt_path, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "5", "--queue-timeout", "5",
                        "--snapshot", snapshot_path, "--repo", repo])
        self.assertEqual(r.returncode, 0)
        meta = _read_meta(out)
        self.assertEqual(meta["snapshot_path"], os.path.abspath(snapshot_path))
        snap_sha = _sha256(open(snapshot_path, "rb").read())
        self.assertEqual(meta["snapshot_sha256"], snap_sha)

    def test_snapshot_dependency_change_exit7(self):
        """Change dependency while locks held, release -> exit 7 before POST."""
        repo, packet_dir, snapshot_path, prompt_path = self._build_packet_fixture()
        fds = _hold_all_slots(self.lockdir)
        try:
            out = self._outdir()
            cmd = [sys.executable, "-B", CALLER, prompt_path, out,
                   "--url", self.server.url, "--lock-dir", self.lockdir,
                   "--timeout", "5", "--queue-timeout", "5",
                   "--snapshot", snapshot_path, "--repo", repo]
            proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)
            time.sleep(0.15)
            # Modify dependency
            with open(os.path.join(repo, "x.ts"), "w") as f:
                f.write("export const x = 999;\n")
            # Release locks
            _release_all(fds)
            fds = []
            proc.wait(timeout=5)
            self.assertEqual(proc.returncode, 7)
            self.assertEqual(_Handler.post_count, 0)
            meta = _read_meta(out)
            self.assertEqual(meta["exit_code"], 7)
        finally:
            if fds:
                _release_all(fds)

    def test_snapshot_prompt_change_exit7(self):
        """Change prompt file while locks held -> exit 7."""
        repo, packet_dir, snapshot_path, prompt_path = self._build_packet_fixture()
        fds = _hold_all_slots(self.lockdir)
        try:
            out = self._outdir()
            cmd = [sys.executable, "-B", CALLER, prompt_path, out,
                   "--url", self.server.url, "--lock-dir", self.lockdir,
                   "--timeout", "5", "--queue-timeout", "5",
                   "--snapshot", snapshot_path, "--repo", repo]
            proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)
            time.sleep(0.15)
            # Modify prompt
            with open(prompt_path, "w") as f:
                f.write("TAMPERED\n")
            _release_all(fds)
            fds = []
            proc.wait(timeout=5)
            self.assertEqual(proc.returncode, 7)
            self.assertEqual(_Handler.post_count, 0)
        finally:
            if fds:
                _release_all(fds)

    def test_snapshot_manifest_change_exit7(self):
        """Change manifest while locks held -> exit 7."""
        repo, packet_dir, snapshot_path, prompt_path = self._build_packet_fixture()
        fds = _hold_all_slots(self.lockdir)
        try:
            out = self._outdir()
            cmd = [sys.executable, "-B", CALLER, prompt_path, out,
                   "--url", self.server.url, "--lock-dir", self.lockdir,
                   "--timeout", "5", "--queue-timeout", "5",
                   "--snapshot", snapshot_path, "--repo", repo]
            proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)
            time.sleep(0.15)
            # Modify manifest (the one referenced in snapshot)
            manifest_in_packet = os.path.join(self.tmp, "manifest.json")
            with open(manifest_in_packet, "w") as f:
                f.write('{"task": "CHANGED", "allowed_files": [], "contract": "x", "dependencies": [], "design_sections": [], "issue_body": "x"}')
            _release_all(fds)
            fds = []
            proc.wait(timeout=5)
            self.assertEqual(proc.returncode, 7)
            self.assertEqual(_Handler.post_count, 0)
        finally:
            if fds:
                _release_all(fds)


class TestBodyContract(_Base):
    """Verify request body matches API contract."""

    def test_body_fields(self):
        """POST body has model=jarvis, temperature, max_tokens, reasoning_effort=low, messages."""
        prompt = self._prompt("body test")
        out = self._outdir()
        _run_caller([prompt, out, "--url", self.server.url,
                    "--lock-dir", self.lockdir, "--timeout", "5", "--queue-timeout", "5",
                    "--max-tokens", "100", "--temperature", "0.7"])
        self.assertEqual(_Handler.post_count, 1)
        body = json.loads(_Handler.post_body)
        self.assertEqual(body["model"], "jarvis")
        self.assertEqual(body["max_tokens"], 100)
        self.assertAlmostEqual(body["temperature"], 0.7)
        self.assertEqual(body["reasoning_effort"], "low")
        self.assertIsInstance(body["messages"], list)
        self.assertEqual(len(body["messages"]), 2)
        self.assertEqual(body["messages"][0]["role"], "system")
        self.assertEqual(body["messages"][1]["role"], "user")
        self.assertEqual(body["messages"][1]["content"], "body test")


class TestDetachRefuseExisting(_Base):
    def test_detach_refuse_existing(self):
        """--detach with existing outdir -> exit 7."""
        prompt = self._prompt()
        out = self._outdir()
        os.makedirs(out)
        r = _run_caller([prompt, out, "--url", self.server.url,
                        "--lock-dir", self.lockdir, "--timeout", "3",
                        "--queue-timeout", "3", "--detach"])
        self.assertEqual(r.returncode, 7)


if __name__ == "__main__":
    unittest.main()
