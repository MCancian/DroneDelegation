#!/usr/bin/env python3
"""End-to-end roundtrip tests: private fake HTTP + real packet CLI build/call/stage/apply."""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
PACKET_PY = SCRIPTS_DIR / "jarvis_packet.py"
CALL_PY = SCRIPTS_DIR / "jarvis_call.py"
TS_SYNTAX = SCRIPTS_DIR / "ts_syntax.mjs"
NODE = os.environ.get("JARVIS_NODE", "node")
HAS_NODE_MODULES = (SCRIPTS_DIR.parent / "node_modules" / "typescript").is_dir()


class FakeHandler(BaseHTTPRequestHandler):
    response_content = ""
    response_finish = "stop"

    def do_GET(self):
        if self.path == "/v1/models":
            body = json.dumps({"data": [{"id": "jarvis", "root": "private-fixture",
                                         "max_model_len": 262144}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except Exception:
            self.send_response(400)
            self.end_headers()
            return
        if req.get("model") != "jarvis" or req.get("reasoning_effort") != "low":
            self.send_response(400)
            self.end_headers()
            return
        reply = {"choices": [{"message": {"content": self.response_content},
                              "finish_reason": self.response_finish}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}
        body = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class RoundtripBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.repo = self.tmp_path / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init"], cwd=str(self.repo), capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], cwd=str(self.repo), capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "T"], cwd=str(self.repo), capture_output=True, check=True)
        (self.repo / ".gitignore").write_text("node_modules\n")
        scripts = self.repo / "scripts"
        scripts.mkdir()
        shutil.copy2(str(TS_SYNTAX), str(scripts / "ts_syntax.mjs"))
        real_nm = SCRIPTS_DIR.parent / "node_modules"
        if real_nm.is_dir():
            (self.repo / "node_modules").symlink_to(str(real_nm))
        docs = self.repo / "docs"
        docs.mkdir()
        (docs / "DESIGN.md").write_text("# Design\n\n## Target Module\n\nDetails.\n")
        (self.repo / "dep.ts").write_text("export const dep = 1;\n")
        tests_dir = self.repo / "tests"
        tests_dir.mkdir()
        (tests_dir / "target.ts").write_text("export const value = 1;\n")
        subprocess.run(["git", "add", "-A"], cwd=str(self.repo), capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=str(self.repo), capture_output=True, check=True)
        self.lock_dir = self.tmp_path / "locks"
        self.lock_dir.mkdir()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeHandler)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.srv_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.srv_thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.srv_thread.join(timeout=5)
        self.server.server_close()
        self.tmp.cleanup()

    def _build(self, packet_dir, allowed_files, deps=None, design_sections=None):
        manifest = {"task": "Update target", "allowed_files": allowed_files,
                    "contract": "Return complete file.", "dependencies": deps or ["dep.ts"],
                    "design_sections": design_sections or ["## Target Module"],
                    "issue_body": "Fix value."}
        mp = self.tmp_path / "manifest.json"
        mp.write_text(json.dumps(manifest))
        subprocess.run([sys.executable, "-B", str(PACKET_PY), "build", str(mp),
                        str(packet_dir), "--repo", str(self.repo)],
                       capture_output=True, timeout=15, check=True)

    def _call(self, packet_dir, request_dir):
        subprocess.run([sys.executable, "-B", str(CALL_PY), str(packet_dir / "prompt.md"),
                        str(request_dir), "--url", self.url, "--lock-dir", str(self.lock_dir),
                        "--timeout", "5", "--queue-timeout", "5",
                        "--snapshot", str(packet_dir / "snapshot.json"), "--repo", str(self.repo)],
                       capture_output=True, timeout=15, check=True)

    def _stage(self, request_dir, stage_dir):
        return subprocess.run([sys.executable, "-B", str(PACKET_PY), "stage",
                               str(request_dir), str(stage_dir), "--repo", str(self.repo)],
                              capture_output=True, timeout=15)

    def _apply(self, stage_dir):
        return subprocess.run([sys.executable, "-B", str(PACKET_PY), "apply",
                               str(stage_dir), "--repo", str(self.repo)],
                              capture_output=True, timeout=15)

    def _proto(self, files_dict, terminal=True):
        parts = []
        for path, body in files_dict.items():
            parts.append(f"<<<FILE {path}>>>\n{body}<<<END FILE {path}>>>\n")
        if terminal:
            parts.append("<<<END RESPONSE>>>\n")
        return "".join(parts)


@unittest.skipUnless(HAS_NODE_MODULES, "node_modules/typescript not available")
class TestRoundtrip(RoundtripBase):

    def test_1_success_full_ts(self):
        target = self.repo / "tests" / "target.ts"
        os.chmod(str(target), 0o755)
        subprocess.run(["git", "add", "-A"], cwd=str(self.repo), capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "chmod"], cwd=str(self.repo), capture_output=True, check=True)
        new_body = "export const value = 2;\n"
        FakeHandler.response_content = self._proto({"tests/target.ts": new_body})
        FakeHandler.response_finish = "stop"
        pkt = self.tmp_path / "pkt"
        req = self.tmp_path / "req"
        stg = self.tmp_path / "stg"
        self._build(pkt, ["tests/target.ts"])
        self._call(pkt, req)
        meta = json.loads((req / "meta.json").read_text())
        self.assertEqual(meta["exit_code"], 0)
        self.assertEqual(meta["model_root"], "private-fixture")
        self.assertEqual(meta["effort"], "low")
        self.assertEqual(meta["post_attempts"], 1)
        r = self._stage(req, stg)
        self.assertEqual(r.returncode, 0)
        r = self._apply(stg)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(target.read_text(), new_body)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)
        # slot locks reacquirable
        for n in range(4):
            fd = os.open(str(self.lock_dir / f"jarvis.{n}.lock"), os.O_RDWR | os.O_CREAT, 0o644)
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def test_2_truncated_missing_end(self):
        FakeHandler.response_content = "<<<FILE tests/target.ts>>>\nexport const value = 2;\n"
        FakeHandler.response_finish = "stop"
        pkt = self.tmp_path / "pkt"
        req = self.tmp_path / "req"
        stg = self.tmp_path / "stg"
        self._build(pkt, ["tests/target.ts"])
        self._call(pkt, req)
        self.assertEqual(json.loads((req / "meta.json").read_text())["exit_code"], 0)
        r = self._stage(req, stg)
        self.assertEqual(r.returncode, 7)
        self.assertEqual((self.repo / "tests" / "target.ts").read_text(), "export const value = 1;\n")
        v = json.loads((req / "validation.json").read_text())
        self.assertEqual(v["status"], "incomplete")

    def test_3_unsafe_traversal(self):
        FakeHandler.response_content = self._proto({"../escaped.ts": "export const x = 1;\n"})
        FakeHandler.response_finish = "stop"
        pkt = self.tmp_path / "pkt"
        req = self.tmp_path / "req"
        stg = self.tmp_path / "stg"
        self._build(pkt, ["tests/target.ts"])
        self._call(pkt, req)
        r = self._stage(req, stg)
        self.assertEqual(r.returncode, 7)
        self.assertEqual((self.repo / "tests" / "target.ts").read_text(), "export const value = 1;\n")
        self.assertFalse((self.tmp_path / "escaped.ts").exists())

    def test_4_dep_changed_before_apply(self):
        new_body = "export const value = 2;\n"
        FakeHandler.response_content = self._proto({"tests/target.ts": new_body})
        FakeHandler.response_finish = "stop"
        pkt = self.tmp_path / "pkt"
        req = self.tmp_path / "req"
        stg = self.tmp_path / "stg"
        self._build(pkt, ["tests/target.ts"])
        self._call(pkt, req)
        r = self._stage(req, stg)
        self.assertEqual(r.returncode, 0)
        # Intentionally change dep BEFORE apply
        (self.repo / "dep.ts").write_text("export const dep = 999;\n")
        r = self._apply(stg)
        self.assertEqual(r.returncode, 7)
        # target unchanged
        self.assertEqual((self.repo / "tests" / "target.ts").read_text(), "export const value = 1;\n")
        # dep has only the intentional change
        self.assertEqual((self.repo / "dep.ts").read_text(), "export const dep = 999;\n")

    def test_5_markdown_indented_ellipsis(self):
        md_body = "# Example\n\n    ...\n\nDone.\n"
        FakeHandler.response_content = self._proto({"docs/example.md": md_body})
        FakeHandler.response_finish = "stop"
        pkt = self.tmp_path / "pkt"
        req = self.tmp_path / "req"
        stg = self.tmp_path / "stg"
        self._build(pkt, ["docs/example.md"])
        self._call(pkt, req)
        r = self._stage(req, stg)
        self.assertEqual(r.returncode, 0)
        r = self._apply(stg)
        self.assertEqual(r.returncode, 0)
        self.assertEqual((self.repo / "docs" / "example.md").read_text(), md_body)

    def test_6_bare_ellipsis_markdown(self):
        md_body = "# Example\n\n...\n\nDone.\n"
        FakeHandler.response_content = self._proto({"docs/example.md": md_body})
        FakeHandler.response_finish = "stop"
        pkt = self.tmp_path / "pkt"
        req = self.tmp_path / "req"
        stg = self.tmp_path / "stg"
        self._build(pkt, ["docs/example.md"])
        self._call(pkt, req)
        r = self._stage(req, stg)
        self.assertEqual(r.returncode, 7)
        self.assertFalse((self.repo / "docs" / "example.md").exists())

    def test_7_code_indented_ellipsis(self):
        ts_body = "export const value = 1;\n    ...\n"
        FakeHandler.response_content = self._proto({"tests/target.ts": ts_body})
        FakeHandler.response_finish = "stop"
        pkt = self.tmp_path / "pkt"
        req = self.tmp_path / "req"
        stg = self.tmp_path / "stg"
        self._build(pkt, ["tests/target.ts"])
        self._call(pkt, req)
        r = self._stage(req, stg)
        self.assertEqual(r.returncode, 7)
        self.assertEqual((self.repo / "tests" / "target.ts").read_text(), "export const value = 1;\n")


if __name__ == "__main__":
    unittest.main()
