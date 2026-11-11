"""Hermetic CLI checks: fake gh responses and private real Git checkouts."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "milestone_status.py"
spec = importlib.util.spec_from_file_location("milestone_status", SCRIPT)
status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(status)


def milestone(number=9, title="M9", state="open"):
    return {"number": number, "title": title, "state": state, "html_url": "https://example.test/milestone/9"}


def issue(number=1, state="open"):
    return {"number": number, "title": "Implement capability", "state": state, "html_url": "https://example.test/issues/%s" % number}


def connection(nodes=(), more=False, cursor=None):
    return {"data": {"repository": {"issue": {"closedByPullRequestsReferences": {
        "nodes": list(nodes), "pageInfo": {"hasNextPage": more, "endCursor": cursor}}}}}}


def pr(oid=None, merged=True):
    return {"number": 20, "title": "Implementation", "url": "https://example.test/pull/20",
            "state": "MERGED" if merged else "OPEN", "merged": merged, "mergedAt": None,
            "mergeCommit": {"oid": oid} if oid else None,
            "repository": {"nameWithOwner": "owner/repo"}}


class MilestoneStatusTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("remote", "add", "origin", "https://github.com/owner/repo.git")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.test")
        (self.repo / "tracked").write_text("first\n")
        self.git("add", "tracked")
        self.git("commit", "-qm", "initial")
        self.head = self.git("rev-parse", "HEAD").strip()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        fake = self.bin / "gh"
        fake.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args[:2] == ["repo", "view"]:
    key = "repo"
elif args[:2] == ["api", "graphql"]:
    fields = [args[i+1] for i, a in enumerate(args[:-1]) if a in ("-f", "-F")]
    values = dict(item.split("=", 1) for item in fields)
    key = "graphql:" + values["number"] + ":" + values.get("after", "")
    assert "closedByPullRequestsReferences" in values["query"]
    assert "includeClosedPrs:true" in values["query"]
else:
    key = args[1]
plan = json.load(open(os.environ["FAKE_GH_PLAN"]))
response = plan.get(key, {"code": 1, "error": "Unexpected request: " + key})
if "data" in response: print(json.dumps(response["data"]))
if "text" in response: print(response["text"])
if "error" in response: print(response["error"], file=sys.stderr)
sys.exit(response.get("code", 0))
''')
        fake.chmod(0o755)
        self.plan = {
            "repo": {"text": "owner/repo"},
            "repos/owner/repo/milestones?state=all&per_page=100&page=1": {"data": [milestone()]},
            "repos/owner/repo/issues?milestone=9&state=all&per_page=100&page=1": {"data": [issue()]},
            "graphql:1:": {"data": connection()},
        }

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.repo, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              check=True, timeout=10).stdout

    def cli(self, selector="9", checkout=None, json_output=True, repo_override=True, default_checkout=False):
        plan_path = self.root / "plan.json"
        plan_path.write_text(json.dumps(self.plan))
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                   FAKE_GH_PLAN=str(plan_path))
        args = [sys.executable, "-B", str(SCRIPT), "--milestone", selector]
        if not default_checkout:
            args += ["--checkout", str(checkout or self.repo)]
        if repo_override:
            args += ["--repo", "owner/repo"]
        if json_output:
            args += ["--json"]
        result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, timeout=30, cwd=self.repo)
        return result, json.loads(result.stdout) if json_output else result.stdout

    def test_number_exact_title_and_default_repo(self):
        for selector in ("9", "M9"):
            with self.subTest(selector=selector):
                result, report = self.cli(selector, repo_override=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(report["milestone"]["number"], 9)
                self.assertEqual(report["resolution"], "matched")
                self.assertEqual(report["counts"], {"open": 1, "closed": 0, "unknown": 0})
                self.assertEqual(report["acceptance"]["status"], "unverified")
                self.assertEqual(report["checkout"]["head"], self.head)

    def test_default_checkout_and_generic_mentions_are_not_implementation_links(self):
        self.plan["repos/owner/repo/issues?milestone=9&state=all&per_page=100&page=1"]["data"][0]["body"] = "See owner/repo#20 and https://example.test/pull/20 for context."
        result, report = self.cli(default_checkout=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["checkout"]["path"], str(self.repo))
        self.assertEqual(report["issues"][0]["linked_prs"], [])
        self.assertTrue(report["issues"][0]["linked_prs_complete"])

    def test_unmatched_and_ambiguous_are_not_empty(self):
        result, report = self.cli("m9")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["resolution"], "not_found")
        self.assertIsNone(report["counts"])
        self.plan["repos/owner/repo/milestones?state=all&per_page=100&page=1"]["data"].append(milestone(10))
        result, report = self.cli("M9")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["resolution"], "ambiguous")
        self.assertEqual(len(report["milestone_candidates"]), 2)

    def test_empty_and_all_closed_are_informational_unverified(self):
        endpoint = "repos/owner/repo/issues?milestone=9&state=all&per_page=100&page=1"
        for rows in ([], [issue(state="closed")]):
            self.plan[endpoint] = {"data": rows}
            result, report = self.cli()
            self.assertEqual(result.returncode, 0)
            self.assertTrue(report["issues_complete"])
            self.assertEqual(report["counts"]["open"], 0)
            self.assertEqual(report["acceptance"]["status"], "unverified")
            self.assertEqual(report["counts"]["closed"], len(rows))

    def test_merge_inclusion_missing_objects_and_dirty_tree_are_separate(self):
        # A real existing commit outside HEAD's history gives a definitive absence
        # only because this fixture has complete history.
        orphan = self.git("commit-tree", "HEAD^{tree}", "-m", "unrelated").strip()
        self.plan["graphql:1:"] = {"data": connection([pr(self.head), pr(orphan), pr("f" * 40), pr(merged=False)])}
        (self.repo / "tracked").write_text("edited\n")
        (self.repo / "untracked").write_text("new\n")
        result, report = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["checkout"]["dirty"])
        self.assertEqual(report["checkout"]["changed_paths"], 2)
        self.assertEqual(report["issues"][0]["state"], "open")
        prs = report["issues"][0]["linked_prs"]
        self.assertEqual([p["checkout_inclusion"]["status"] for p in prs],
                         ["included", "not_included", "unknown", "unknown"])
        self.assertFalse(prs[-1]["merged"])
        self.assertEqual(report["issues"][0]["acceptance"], "unverified")

    def test_shallow_history_cannot_prove_absence(self):
        (self.repo / "tracked").write_text("second\n")
        self.git("commit", "-qam", "second")
        shallow = self.root / "shallow"
        subprocess.run(["git", "clone", "-q", "--depth", "1", self.repo.as_uri(), str(shallow)],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.git("config", "user.name", "Fixture", cwd=shallow)
        self.git("config", "user.email", "fixture@example.test", cwd=shallow)
        orphan = self.git("commit-tree", "HEAD^{tree}", "-m", "unrelated", cwd=shallow).strip()
        self.plan["graphql:1:"] = {"data": connection([pr(orphan), pr(self.head)])}
        result, report = self.cli(checkout=shallow)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["checkout"]["shallow"])
        self.assertEqual([p["checkout_inclusion"]["status"] for p in report["issues"][0]["linked_prs"]], ["unknown", "unknown"])

    def test_pagination_rest_and_graphql_and_pr_filtering(self):
        self.plan["repos/owner/repo/milestones?state=all&per_page=100&page=1"] = {
            "data": [milestone(n, "Other") for n in range(100, 200)]}
        self.plan["repos/owner/repo/milestones?state=all&per_page=100&page=2"] = {"data": [milestone()]}
        endpoint = "repos/owner/repo/issues?milestone=9&state=all&per_page=100&page="
        self.plan[endpoint + "1"] = {"data": [issue()] + [dict(issue(n), pull_request={}) for n in range(2, 101)]}
        self.plan[endpoint + "2"] = {"data": [issue(101, "closed")]}
        self.plan["graphql:1:"] = {"data": connection([pr(self.head)], True, "next")}
        self.plan["graphql:1:next"] = {"data": connection([pr()])}
        self.plan["graphql:101:"] = {"data": connection()}
        result, report = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([i["number"] for i in report["issues"]], [1, 101])
        self.assertEqual(len(report["issues"][0]["linked_prs"]), 2)
        self.assertTrue(report["issues"][0]["linked_prs_complete"])

    def test_issue_page_failure_retains_partial_report_and_fails(self):
        endpoint = "repos/owner/repo/issues?milestone=9&state=all&per_page=100&page="
        self.plan[endpoint + "1"] = {"data": [issue()] + [dict(issue(n), pull_request={}) for n in range(2, 101)]}
        self.plan[endpoint + "2"] = {"code": 1, "error": "permission denied"}
        result, report = self.cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["resolution"], "matched")
        self.assertFalse(report["issues_complete"])
        self.assertEqual(report["counts"]["open"], 1)
        self.assertEqual(report["issues"][0]["number"], 1)
        self.assertIn("permission denied", report["errors"][0]["message"])

    def test_graphql_error_and_incomplete_pagination_retain_rows(self):
        for response in (
            {"data": connection([pr(self.head)], True, None)},
            {"data": dict(connection([pr(self.head)]), errors=[{"message": "partial access"}]), "code": 1},
        ):
            with self.subTest(response=response):
                self.plan["graphql:1:"] = response
                result, report = self.cli()
                self.assertEqual(result.returncode, 1)
                self.assertFalse(report["issues"][0]["linked_prs_complete"])
                self.assertEqual(report["issues"][0]["linked_prs"][0]["checkout_inclusion"]["status"], "included")

    def test_milestone_page_failure_does_not_misreport_unmatched(self):
        self.plan["repos/owner/repo/milestones?state=all&per_page=100&page=1"] = {
            "data": [milestone()] + [milestone(n) for n in range(100, 199)]}
        self.plan["repos/owner/repo/milestones?state=all&per_page=100&page=2"] = {"code": 1, "error": "offline"}
        result, report = self.cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["resolution"], "error")
        self.assertEqual(report["milestone_candidates"][0]["number"], 9)

    def test_missing_nullable_metadata_and_graphql_connection(self):
        self.plan["graphql:1:"] = {"data": connection([{"number": 20, "repository": None, "mergeCommit": None}])}
        result, report = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(report["issues"][0]["linked_prs"][0]["merged"])
        self.assertEqual(report["issues"][0]["linked_prs"][0]["checkout_inclusion"]["status"], "unknown")
        self.plan["graphql:1:"] = {"data": {"data": {"repository": None}}}
        result, report = self.cli()
        self.assertEqual(result.returncode, 1)
        self.assertFalse(report["issues"][0]["linked_prs_complete"])

    def test_git_object_operational_failure_is_error_but_retains_unknown(self):
        inventory = status.Inventory(self.repo)
        with patch.object(inventory, "git", return_value=(128, "", "fatal: object database is corrupt")):
            result = inventory.inclusion(self.head, {"head": self.head, "shallow": False})
        self.assertEqual(result["status"], "unknown")
        self.assertIn("corrupt", inventory.errors[0]["message"])

    def test_malformed_nested_pr_metadata_retains_valid_rows(self):
        self.plan["graphql:1:"] = {"data": connection([pr(self.head), dict(pr(), repository="unexpected")])}
        result, report = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(report["issues"][0]["linked_prs"]), 2)
        self.assertIsNone(report["issues"][0]["linked_prs"][1]["repository"])

    def test_subdirectory_checkout_reports_git_root(self):
        subdirectory = self.repo / "nested"
        subdirectory.mkdir()
        result, report = self.cli(checkout=subdirectory)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["checkout"]["path"], str(self.repo))
        self.assertEqual(report["checkout"]["head"], self.head)

    def test_human_output_and_bounded_transport_diagnostics(self):
        result, output = self.cli(json_output=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("informational; acceptance unverified", output)
        self.assertIn("#1 [open]", output)
        inventory = status.Inventory(self.repo)
        with patch.object(status.subprocess, "run", side_effect=subprocess.TimeoutExpired("gh", 30)) as run:
            data, complete = inventory.api("repos/owner/repo/milestones?state=all")
        self.assertIsNone(data)
        self.assertFalse(complete)
        self.assertEqual(run.call_args.kwargs["timeout"], 30)
        self.assertEqual(run.call_args.kwargs["env"]["GIT_NO_LAZY_FETCH"], "1")
        self.assertEqual(run.call_args.kwargs["env"]["GIT_OPTIONAL_LOCKS"], "0")
        self.assertLessEqual(len(inventory.errors[0]["message"]), 500)


if __name__ == "__main__":
    unittest.main()
