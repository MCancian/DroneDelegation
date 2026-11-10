#!/usr/bin/env python3
"""Tests for lifecycle repairs: envelope repair and early cancellation race."""

import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts"
)


class TestEnvelopeRepair(unittest.TestCase):
    """Test --repair-envelope flag behavior via CLI subprocess."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.repo = os.path.join(self.tmpdir, "repo")
        os.makedirs(self.repo)
        subprocess.run(["git", "init"], cwd=self.repo, capture_output=True)
        docs_dir = os.path.join(self.repo, "docs")
        os.makedirs(docs_dir)
        with open(os.path.join(docs_dir, "DESIGN.md"), "w") as f:
            f.write("# Design\n\n## Section\n\nContent.\n")
        with open(os.path.join(self.repo, "target.py"), "w") as f:
            f.write("x = 1\n")
        with open(os.path.join(self.repo, "dep.py"), "w") as f:
            f.write("y = 2\n")
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        subprocess.run(["git", "add", "."], cwd=self.repo, capture_output=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=self.repo,
                       capture_output=True, env=env)

        manifest = {
            "task": "test task",
            "allowed_files": ["target.py"],
            "contract": "test contract",
            "dependencies": ["dep.py"],
            "design_sections": ["## Section"],
            "issue_body": "test issue",
        }
        manifest_path = os.path.join(self.tmpdir, "manifest.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f)

        self.packet_dir = os.path.join(self.tmpdir, "packet")
        subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "jarvis_packet.py"), "build",
             manifest_path, self.packet_dir, "--repo", self.repo],
            capture_output=True, check=True,
        )

        self.canonical_body = (
            "<<<FILE target.py>>>\nx = 42\n<<<END FILE target.py>>>\n"
            "<<<END RESPONSE>>>\n"
        )
        self.canonical_bytes = self.canonical_body.encode("utf-8")

        self.request_dir = os.path.join(self.tmpdir, "request")
        os.makedirs(self.request_dir)
        self._write_request(self.canonical_bytes)

    def _write_request(self, content_bytes):
        content_sha = hashlib.sha256(content_bytes).hexdigest()
        snapshot_path = os.path.join(self.packet_dir, "snapshot.json")
        snapshot_sha = hashlib.sha256(Path(snapshot_path).read_bytes()).hexdigest()
        prompt_sha = hashlib.sha256(
            Path(os.path.join(self.packet_dir, "prompt.md")).read_bytes()
        ).hexdigest()
        meta = {
            "snapshot_path": snapshot_path,
            "snapshot_sha256": snapshot_sha,
            "prompt_sha256": prompt_sha,
            "status": "ok",
            "exit_code": 0,
            "effort": "low",
            "model_root": "test-model",
            "finish_reason": "stop",
            "post_attempts": 1,
            "content_sha256": content_sha,
        }
        with open(os.path.join(self.request_dir, "meta.json"), "w") as f:
            json.dump(meta, f)
        with open(os.path.join(self.request_dir, "content.md"), "wb") as f:
            f.write(content_bytes)
        reply = {
            "choices": [{
                "message": {"content": content_bytes.decode("utf-8")},
                "finish_reason": "stop",
            }]
        }
        with open(os.path.join(self.request_dir, "reply.json"), "w") as f:
            json.dump(reply, f)
        with open(os.path.join(self.request_dir, "exit_code"), "w") as f:
            f.write("0")

    def _stage(self, stage_dir, repair=False):
        cmd = [sys.executable, os.path.join(SCRIPTS_DIR, "jarvis_packet.py"), "stage",
               self.request_dir, stage_dir, "--repo", self.repo]
        if repair:
            cmd.append("--repair-envelope")
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10)

    def _apply(self, stage_dir):
        cmd = [sys.executable, os.path.join(SCRIPTS_DIR, "jarvis_packet.py"), "apply",
               stage_dir, "--repo", self.repo]
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10)

    def test_default_canonical_stage_success(self):
        """Default stage with canonical content succeeds, no repair record."""
        stage_dir = os.path.join(self.tmpdir, "stage_canonical")
        result = self._stage(stage_dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(
            os.path.exists(os.path.join(stage_dir, "response-repair.json"))
        )

    def test_default_no_final_lf_rejects(self):
        """Default stage rejects content without final LF (exit 7), worktree unchanged."""
        no_lf_body = self.canonical_body.rstrip("\n")
        no_lf_bytes = no_lf_body.encode("utf-8")
        self._write_request(no_lf_bytes)
        stage_dir = os.path.join(self.tmpdir, "stage_no_lf")
        result = self._stage(stage_dir)
        self.assertEqual(result.returncode, 7)
        with open(os.path.join(self.repo, "target.py")) as f:
            self.assertEqual(f.read(), "x = 1\n")

    def test_repair_envelope_appends_lf(self):
        """--repair-envelope appends final LF when content ends with END RESPONSE but no LF."""
        no_lf_body = self.canonical_body.rstrip("\n")
        no_lf_bytes = no_lf_body.encode("utf-8")
        self._write_request(no_lf_bytes)
        stage_dir = os.path.join(self.tmpdir, "stage_repair")
        result = self._stage(stage_dir, repair=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        repair_path = os.path.join(stage_dir, "response-repair.json")
        self.assertTrue(os.path.exists(repair_path))
        repair = json.loads(Path(repair_path).read_text())
        self.assertEqual(
            repair["operation"],
            "Append final LF after complete <<<END RESPONSE>>> delimiter",
        )
        # Original content bytes unchanged
        actual_content = Path(os.path.join(self.request_dir, "content.md")).read_bytes()
        self.assertEqual(actual_content, no_lf_bytes)
        # Repair record has correct hashes
        self.assertEqual(
            repair["original_content_sha256"],
            hashlib.sha256(no_lf_bytes).hexdigest(),
        )
        self.assertEqual(
            repair["repaired_content_sha256"],
            hashlib.sha256(self.canonical_bytes).hexdigest(),
        )

    def test_repair_envelope_already_canonical_noop(self):
        """--repair-envelope on already canonical content is no-op, no repair record."""
        stage_dir = os.path.join(self.tmpdir, "stage_repair_noop")
        result = self._stage(stage_dir, repair=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(
            os.path.exists(os.path.join(stage_dir, "response-repair.json"))
        )

    def test_repair_envelope_missing_end_response_rejects(self):
        """--repair-envelope still rejects if END RESPONSE delimiter is missing."""
        body = "<<<FILE target.py>>>\nx = 42\n<<<END FILE target.py>>>\n"
        body_bytes = body.encode("utf-8")
        self._write_request(body_bytes)
        stage_dir = os.path.join(self.tmpdir, "stage_no_end")
        result = self._stage(stage_dir, repair=True)
        self.assertEqual(result.returncode, 7)

    def test_repair_envelope_truncated_body_rejects(self):
        """--repair-envelope still rejects truncated file body (missing END FILE)."""
        body = "<<<FILE target.py>>>\nx = 42\n<<<END RESPONSE>>>"
        body_bytes = body.encode("utf-8")
        self._write_request(body_bytes)
        stage_dir = os.path.join(self.tmpdir, "stage_truncated")
        result = self._stage(stage_dir, repair=True)
        self.assertEqual(result.returncode, 7)

    def test_repair_envelope_extra_trailing_prose_rejects(self):
        """--repair-envelope still rejects extra trailing prose after END RESPONSE."""
        body = (
            "<<<FILE target.py>>>\nx = 42\n<<<END FILE target.py>>>\n"
            "<<<END RESPONSE>>>\nextra prose\n"
        )
        body_bytes = body.encode("utf-8")
        self._write_request(body_bytes)
        stage_dir = os.path.join(self.tmpdir, "stage_prose")
        result = self._stage(stage_dir, repair=True)
        self.assertEqual(result.returncode, 7)

    def test_apply_preserves_repaired_body_exact_lf(self):
        """Apply after repair succeeds and preserves exact LF in output file."""
        no_lf_body = self.canonical_body.rstrip("\n")
        no_lf_bytes = no_lf_body.encode("utf-8")
        self._write_request(no_lf_bytes)
        stage_dir = os.path.join(self.tmpdir, "stage_apply")
        result = self._stage(stage_dir, repair=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self._apply(stage_dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(os.path.join(self.repo, "target.py")) as f:
            self.assertEqual(f.read(), "x = 42\n")

    def test_modify_repair_log_after_stage_rejects_worktree_unchanged(self):
        """Tampering response-repair.json after staging causes apply to reject."""
        no_lf_body = self.canonical_body.rstrip("\n")
        no_lf_bytes = no_lf_body.encode("utf-8")
        self._write_request(no_lf_bytes)
        stage_dir = os.path.join(self.tmpdir, "stage_tamper")
        result = self._stage(stage_dir, repair=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        repair_path = os.path.join(stage_dir, "response-repair.json")
        with open(repair_path, "w") as f:
            f.write("tampered\n")
        result = self._apply(stage_dir)
        self.assertEqual(result.returncode, 7)
        with open(os.path.join(self.repo, "target.py")) as f:
            self.assertEqual(f.read(), "x = 1\n")

    def test_summary_reports_incomplete_one_and_one_handedit(self):
        """Summary reports incomplete=1 and one hand_edit after repair staging."""
        no_lf_body = self.canonical_body.rstrip("\n")
        no_lf_bytes = no_lf_body.encode("utf-8")
        self._write_request(no_lf_bytes)
        # First stage without repair -> incomplete
        stage_dir1 = os.path.join(self.tmpdir, "stage_sum1")
        result = self._stage(stage_dir1)
        self.assertEqual(result.returncode, 7)
        # Second stage with repair -> ok
        stage_dir2 = os.path.join(self.tmpdir, "stage_sum2")
        result = self._stage(stage_dir2, repair=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Summary
        result = subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "jarvis_packet.py"), "summary",
             self.request_dir],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Incomplete: 1", result.stdout)
        self.assertIn("response envelope", result.stdout)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class TestEarlyCancellation(unittest.TestCase):
    """Test early cancellation race fix via subprocess isolation."""

    def test_cancel_before_execute_yields_130(self):
        """SIGTERM before _execute yields exit 130 with meta, terminal, no HTTP/slot."""
        tmpdir = tempfile.mkdtemp()
        try:
            out_dir = os.path.join(tmpdir, "out")
            os.makedirs(out_dir)
            lock_dir = os.path.join(tmpdir, "locks")
            os.makedirs(lock_dir)
            prompt_path = os.path.join(tmpdir, "prompt.txt")
            with open(prompt_path, "w") as f:
                f.write("test prompt")

            script = textwrap.dedent(f"""\
                import sys, os, signal
                sys.path.insert(0, {SCRIPTS_DIR!r})
                import jarvis_call as jc
                jc._install_signals()
                os.kill(os.getpid(), signal.SIGTERM)
                log = jc._RunLog(os.path.join({out_dir!r}, "run.log"))
                code = jc._execute(
                    {prompt_path!r}, {out_dir!r},
                    "http://127.0.0.1:1", {lock_dir!r},
                    100, 0.2, 5.0, 5.0, None, None, log
                )
                log.close()
                with open(os.path.join({out_dir!r}, "exit_code"), "w") as f:
                    f.write(str(code))
                sys.exit(code)
            """)
            result = subprocess.run(
                [sys.executable, "-c", script],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 130, f"stderr: {result.stderr}")
            meta_path = os.path.join(out_dir, "meta.json")
            self.assertTrue(os.path.exists(meta_path))
            meta = json.loads(Path(meta_path).read_text())
            self.assertEqual(meta["exit_code"], 130)
            self.assertEqual(meta["post_attempts"], 0)
            self.assertEqual(meta["status"], "cancelled")
            ec_path = os.path.join(out_dir, "exit_code")
            self.assertTrue(os.path.exists(ec_path))
            self.assertEqual(Path(ec_path).read_text().strip(), "130")
            lock_files = [f for f in os.listdir(lock_dir) if f.endswith(".lock")]
            self.assertEqual(len(lock_files), 0)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_double_cancel_finalizer_records_first_130(self):
        """Second SIGTERM during finalizer does not overwrite first cancel's 130."""
        tmpdir = tempfile.mkdtemp()
        try:
            out_dir = os.path.join(tmpdir, "out")
            os.makedirs(out_dir)
            lock_dir = os.path.join(tmpdir, "locks")
            os.makedirs(lock_dir)
            prompt_path = os.path.join(tmpdir, "prompt.txt")
            with open(prompt_path, "w") as f:
                f.write("test prompt")

            script = textwrap.dedent(f"""\
                import sys, os, signal
                sys.path.insert(0, {SCRIPTS_DIR!r})
                import jarvis_call as jc

                original_aw = jc._atomic_write
                def patched_aw(path, data):
                    if path.endswith("meta.json"):
                        os.kill(os.getpid(), signal.SIGTERM)
                    return original_aw(path, data)
                jc._atomic_write = patched_aw

                jc._install_signals()
                os.kill(os.getpid(), signal.SIGTERM)

                log = jc._RunLog(os.path.join({out_dir!r}, "run.log"))
                code = jc._execute(
                    {prompt_path!r}, {out_dir!r},
                    "http://127.0.0.1:1", {lock_dir!r},
                    100, 0.2, 5.0, 5.0, None, None, log
                )
                log.close()
                with open(os.path.join({out_dir!r}, "exit_code"), "w") as f:
                    f.write(str(code))
                sys.exit(code)
            """)
            result = subprocess.run(
                [sys.executable, "-c", script],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 130, f"stderr: {result.stderr}")
            meta_path = os.path.join(out_dir, "meta.json")
            self.assertTrue(os.path.exists(meta_path))
            meta = json.loads(Path(meta_path).read_text())
            self.assertEqual(meta["exit_code"], 130)
            self.assertEqual(meta["status"], "cancelled")
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
