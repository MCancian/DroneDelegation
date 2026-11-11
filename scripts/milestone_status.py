#!/usr/bin/env python3
"""Read-only, informational milestone inventory using native gh and local Git.

Closure, PR merge state, checkout inclusion, and acceptance are independent.
This command never fetches, changes GitHub/Git state, or runs project checks.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TIMEOUT = 30
MAX_PAGES = 1000
PR_QUERY = """query($owner:String!, $name:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$name) {
    issue(number:$number) {
      closedByPullRequestsReferences(first:100, after:$after, includeClosedPrs:true) {
        nodes { number title url state merged mergedAt mergeCommit { oid }
                repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}"""


class Inventory:
    def __init__(self, checkout):
        self.checkout = str(Path(checkout).resolve())
        self.errors = []

    def error(self, context, message):
        self.errors.append({"context": context, "message": str(message).strip()[:500]})

    def run(self, args, input_text=None):
        try:
            result = subprocess.run(args, cwd=self.checkout, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=TIMEOUT, check=False, input=input_text,
                                    env=dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_OPTIONAL_LOCKS="0"))
            return result.returncode, result.stdout, result.stderr
        except (OSError, subprocess.TimeoutExpired) as exc:
            return None, "", str(exc)

    def git(self, *args, input_text=None):
        return self.run(["git", "--no-optional-locks", *args], input_text=input_text)

    def api(self, endpoint=None, fields=None):
        args = ["gh", "api"]
        if fields is None:
            args += [endpoint]
        else:
            args += ["graphql", "-f", "query=" + PR_QUERY]
            for name, value in fields.items():
                args += ["-F" if name == "number" else "-f", name + "=" + str(value)]
        code, output, diagnostic = self.run(args)
        context = endpoint or "linked pull requests for issue #" + str(fields["number"])
        if code != 0:
            self.error(context, diagnostic or "gh failed (exit %s)" % code)
        try:
            data = json.loads(output)
        except (ValueError, TypeError):
            if code == 0:
                self.error(context, "gh returned invalid JSON")
            return None, False
        if isinstance(data, dict) and data.get("errors"):
            self.error(context, json.dumps(data["errors"]))
            return data, False
        return data, code == 0

    def rest_pages(self, endpoint):
        rows = []
        for page in range(1, MAX_PAGES + 1):
            data, ok = self.api(endpoint + "&per_page=100&page=" + str(page))
            if not isinstance(data, list):
                if ok:
                    self.error(endpoint, "expected an array")
                return rows, False
            rows.extend(item for item in data if isinstance(item, dict))
            if any(not isinstance(item, dict) for item in data):
                self.error(endpoint, "invalid record in response")
                ok = False
            if not ok:
                return rows, False
            if len(data) < 100:
                return rows, True
        self.error(endpoint, "pagination limit exceeded")
        return rows, False

    def checkout_status(self):
        status = {"path": self.checkout, "head": None, "dirty": None,
                  "changed_paths": None, "shallow": None}
        code, root, diagnostic = self.git("rev-parse", "--show-toplevel")
        if code == 0:
            self.checkout = root.strip()
            status["path"] = self.checkout
        else:
            self.error("checkout root", diagnostic or "git failed")
        for key, args in (("head", ("rev-parse", "--verify", "HEAD")),
                          ("shallow", ("rev-parse", "--is-shallow-repository")),
                          ("changed_paths", ("status", "--porcelain=v1", "-z", "--untracked-files=all"))):
            code, output, diagnostic = self.git(*args)
            if code != 0:
                self.error("checkout " + key, diagnostic or "git failed")
                continue
            if key == "changed_paths":
                # Rename records contain two paths; count status records, not paths.
                entries = output.split("\0")
                count, index = 0, 0
                while index < len(entries) and entries[index]:
                    entry = entries[index]
                    count += 1
                    index += 2 if "R" in entry[:2] or "C" in entry[:2] else 1
                status[key] = count
                status["dirty"] = bool(count)
            elif key == "shallow":
                status[key] = {"true": True, "false": False}.get(output.strip())
            else:
                status[key] = output.strip()
        return status

    def inclusion(self, oid, checkout):
        result = {"status": "unknown", "reason": "merge commit unavailable"}
        if not isinstance(oid, str) or not re.fullmatch(r"[0-9a-fA-F]{40,64}", oid):
            return result
        if not checkout["head"]:
            result["reason"] = "checkout HEAD unavailable"
            return result
        # Batch mode distinguishes an ordinary missing object (exit 0, "missing")
        # from corrupt databases, timeouts, or other operational Git failures.
        code, object_info, diagnostic = self.git("cat-file", "--batch-check", input_text=oid + "\n")
        if code != 0:
            result["reason"] = "Git could not inspect the commit object"
            self.error("commit object " + oid, diagnostic or "git failed")
            return result
        if object_info.strip() == oid + " missing":
            result["reason"] = "commit object unavailable locally; no fetch performed"
            return result
        if len(object_info.split()) != 3 or object_info.split()[1] != "commit":
            result["reason"] = "merge object is not a commit"
            return result
        code, _, diagnostic = self.git("merge-base", "--is-ancestor", oid, checkout["head"])
        if code == 0:
            return {"status": "included", "reason": "commit is an ancestor of HEAD"}
        if code == 1 and checkout["shallow"] is False:
            return {"status": "not_included", "reason": "commit is not an ancestor of HEAD"}
        if code == 1:
            result["reason"] = "shallow or unknown history prevents an absence conclusion"
        else:
            result["reason"] = "Git could not determine ancestry"
            self.error("commit ancestry " + oid, diagnostic or "git failed")
        return result

    def pull_requests(self, repo, number, checkout):
        owner, name = repo.split("/")
        fields = {"owner": owner, "name": name, "number": number}
        rows, seen = [], set()
        for _ in range(MAX_PAGES):
            data, ok = self.api(fields=fields)
            try:
                connection = data["data"]["repository"]["issue"]["closedByPullRequestsReferences"]
                nodes, page_info = connection["nodes"], connection["pageInfo"]
                if not isinstance(nodes, list) or not isinstance(page_info, dict):
                    raise TypeError()
            except (KeyError, TypeError):
                if ok:
                    self.error("issue #%s linked pull requests" % number, "missing connection data")
                return rows, False
            for node in nodes:
                if not isinstance(node, dict):
                    self.error("issue #%s linked pull requests" % number, "missing pull request data")
                    ok = False
                    continue
                commit = node.get("mergeCommit") or {}
                oid = commit.get("oid") if isinstance(commit, dict) else None
                merged = node.get("merged")
                rows.append({"number": node.get("number"), "title": node.get("title"),
                             "url": node.get("url"), "repository": node["repository"].get("nameWithOwner") if isinstance(node.get("repository"), dict) else None,
                             "state": node.get("state"), "merged": merged if isinstance(merged, bool) else None,
                             "merged_at": node.get("mergedAt"), "merge_commit": oid,
                             "checkout_inclusion": self.inclusion(oid, checkout)})
            if not ok:
                return rows, False
            has_next = page_info.get("hasNextPage")
            if has_next is False:
                return rows, True
            cursor = page_info.get("endCursor")
            if has_next is not True or not cursor or cursor in seen:
                self.error("issue #%s linked pull requests" % number, "missing or repeated pagination cursor")
                return rows, False
            seen.add(cursor)
            fields["after"] = cursor
        self.error("issue #%s linked pull requests" % number, "pagination limit exceeded")
        return rows, False

    def report(self, selector, repo=None):
        checkout = self.checkout_status()
        report = {"informational": True, "repository": repo, "requested_milestone": selector,
                  "milestone": None, "resolution": "error", "checkout": checkout,
                  "issues_complete": False, "issues": [], "counts": None,
                  "acceptance": {"status": "unverified", "reason": "No acceptance checks or evidence verification performed."},
                  "errors": self.errors}
        if not repo:
            code, remote, diagnostic = self.git("remote", "get-url", "origin")
            if code != 0:
                self.error("repository", diagnostic or "origin remote unavailable; supply --repo")
                return report
            code, output, diagnostic = self.run(["gh", "repo", "view", remote.strip(), "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
            if code != 0:
                self.error("repository", diagnostic or "gh repository lookup failed")
                return report
            repo = output.strip()
            report["repository"] = repo
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
            self.error("repository", "expected OWNER/REPO")
            return report
        milestones, complete = self.rest_pages("repos/%s/milestones?state=all" % repo)
        number = int(selector) if selector.isdecimal() else None
        matches = [m for m in milestones if (m.get("number") == number if number is not None else m.get("title") == selector)]
        if not complete:
            # Even a match could have a duplicate title on an unread page.
            report["milestone_candidates"] = matches
            return report
        if len(matches) != 1:
            report["resolution"] = "not_found" if not matches else "ambiguous"
            report["milestone_candidates"] = matches
            self.error("milestone", "no matching milestone" if not matches else "multiple exact title matches; use a number")
            return report
        milestone = matches[0]
        if not isinstance(milestone.get("number"), int):
            self.error("milestone", "canonical milestone number unavailable")
            return report
        report["resolution"] = "matched"
        report["milestone"] = {key: milestone.get(key) for key in ("number", "title", "state", "html_url")}
        issues, report["issues_complete"] = self.rest_pages("repos/%s/issues?milestone=%s&state=all" % (repo, milestone["number"]))
        for issue in issues:
            if "pull_request" in issue:
                continue  # The issues endpoint also returns PRs assigned to this milestone.
            number = issue.get("number")
            prs, complete = (self.pull_requests(repo, number, checkout)
                             if isinstance(number, int) else ([], False))
            if not isinstance(number, int):
                self.error("issue", "issue number unavailable")
            report["issues"].append({"number": number, "title": issue.get("title"),
                                     "state": issue.get("state"), "url": issue.get("html_url"),
                                     "linked_prs_complete": complete, "linked_prs": prs,
                                     "acceptance": "unverified"})
        report["counts"] = {state: sum(i["state"] == state for i in report["issues"])
                            for state in ("open", "closed")}
        report["counts"]["unknown"] = sum(i["state"] not in ("open", "closed") for i in report["issues"])
        return report


def human_report(report):
    milestone = report["milestone"]
    lines = ["Milestone preflight (informational; acceptance unverified)"]
    if milestone:
        lines.append("%s #%s: %s [%s]" % (report["repository"], milestone["number"], milestone["title"], milestone["state"]))
        counts = report["counts"]
        lines.append("Issues: %s open, %s closed, %s unknown%s" % (
            counts["open"], counts["closed"], counts["unknown"], " (partial inventory)" if not report["issues_complete"] else ""))
    else:
        lines.append("Milestone %r: %s" % (report["requested_milestone"], report["resolution"]))
    checkout = report["checkout"]
    lines.append("Checkout: %s; HEAD %s; dirty %s (%s paths); shallow %s" % (
        checkout["path"], checkout["head"] or "unknown", checkout["dirty"], checkout["changed_paths"], checkout["shallow"]))
    for issue in report["issues"]:
        lines.append("  #%s [%s] %s; acceptance unverified" % (issue["number"], issue["state"] or "unknown", issue["title"]))
        if not issue["linked_prs"]:
            lines.append("    Linked implementation PRs: %s" % ("none returned" if issue["linked_prs_complete"] else "unknown"))
        for pr in issue["linked_prs"]:
            lines.append("    PR %s#%s [%s, merged=%s] commit %s: %s" % (
                pr["repository"], pr["number"], pr["state"] or "unknown", pr["merged"],
                pr["merge_commit"] or "unknown", pr["checkout_inclusion"]["status"]))
        if issue["linked_prs"] and not issue["linked_prs_complete"]:
            lines.append("    Linked PR inventory incomplete")
    for error in report["errors"]:
        lines.append("Error (%s): %s" % (error["context"], error["message"]))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--milestone", required=True, help="canonical number or exact title")
    parser.add_argument("--checkout", default=".", help="local Git checkout to inspect (read-only; default: current Git checkout)")
    parser.add_argument("--repo", help="OWNER/REPO; defaults to the checkout origin remote via gh repo view")
    parser.add_argument("--json", action="store_true", help="emit a JSON inventory")
    args = parser.parse_args(argv)
    inventory = Inventory(args.checkout)
    report = inventory.report(args.milestone, args.repo)
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else human_report(report))
    if args.json:
        for error in report["errors"]:
            print("Error (%s): %s" % (error["context"], error["message"]), file=sys.stderr)
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
