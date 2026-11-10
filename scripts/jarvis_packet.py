#!/usr/bin/env python3
"""Jarvis packet builder, checker, stager, and applier.

Commands:
  build MANIFEST PACKET_DIR --repo ROOT
  check SNAPSHOT --repo ROOT
  stage REQUEST_DIR STAGE_DIR --repo ROOT
  apply STAGE_DIR --repo ROOT
  summary REQUEST_DIR... [--hand-edits JSON_FILE]

Exit code 7 for expected rejections (validation failures).
No tracebacks for expected rejections.

Stage contract (preferred):
  REQUEST_DIR/meta.json must contain:
    snapshot_path: absolute path to original packet snapshot.json
    snapshot_sha256: sha256 of that file's bytes
    prompt_sha256: must match snapshot's prompt_sha256
    status: "ok"
    exit_code: 0
    effort: "low"
    model_root: nonempty string
    finish_reason: "stop"
    post_attempts: 1
    content_sha256: sha256 of content.md bytes
  REQUEST_DIR/content.md: raw model output (required)
  REQUEST_DIR/reply.json: raw API response (required)
  REQUEST_DIR/exit_code: file containing "0" (required)

  Stage validates all inputs BEFORE any writes.
  Stage writes only to STAGE_DIR (must be outside repo root).
  Stage manifest records all hashes for apply-time revalidation.

Syntax validation uses trusted scripts/ts_syntax.mjs from the CURRENT repo,
not any returned replacement. Staged checker file is never executed.
"""

import argparse
import ast
import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

EXIT_REJECT = 7

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def safe_relpath(p: str, label: str = "path") -> str:
    """Validate and canonicalize a relative path. Raises ValueError on unsafe."""
    if not isinstance(p, str):
        raise ValueError(f"{label}: not a string: {p!r}")
    if not p:
        raise ValueError(f"{label}: empty path")
    if "\x00" in p:
        raise ValueError(f"{label}: NUL byte in path: {p!r}")
    for ch in p:
        if ord(ch) < 32 or ord(ch) == 127:
            raise ValueError(f"{label}: control character in path: {p!r}")
    if ":" in p:
        raise ValueError(f"{label}: colon (Windows drive?) not allowed: {p!r}")
    if "\\" in p:
        raise ValueError(f"{label}: backslash not allowed: {p!r}")
    if p.startswith("/"):
        raise ValueError(f"{label}: absolute path not allowed: {p!r}")
    parts = p.split("/")
    for part in parts:
        if part == "":
            raise ValueError(f"{label}: empty segment in {p!r}")
        if part == ".":
            raise ValueError(f"{label}: dot segment in {p!r}")
        if part == "..":
            raise ValueError(f"{label}: traversal in {p!r}")
        if part == ".git":
            raise ValueError(f"{label}: .git segment not allowed: {p!r}")
        if part == "node_modules":
            raise ValueError(f"{label}: node_modules segment not allowed: {p!r}")
    normalized = "/".join(parts)
    if normalized != p:
        raise ValueError(f"{label}: non-canonical path: {p!r} (normalized: {normalized!r})")
    return normalized


def check_no_symlink_in_chain(path: Path, root: Path, label: str = "path") -> None:
    """Ensure no component of path (relative to root) is a symlink.
    Checks components BEFORE resolve to preserve symlink evidence."""
    try:
        rel = path.relative_to(root)
    except ValueError:
        return
    current = root
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"{label}: symlink component in chain: {current}")


def check_root_components_no_symlink(path: Path, label: str = "path") -> None:
    """Check all ancestor components of path for symlinks BEFORE resolve."""
    current = path
    while current != current.parent:
        if current.is_symlink():
            raise ValueError(f"{label}: symlink in ancestor chain: {current}")
        current = current.parent


def is_outside_root(path: Path, root: Path) -> bool:
    """Check if path is outside root (after resolve)."""
    try:
        path.resolve().relative_to(root.resolve())
        return False
    except ValueError:
        return True


def run_git_ls_files(root: Path) -> list:
    """Run git ls-files and return sorted list of paths."""
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=str(root),
        capture_output=True,
    )
    if result.returncode != 0:
        raise ValueError(f"git ls-files failed: {result.stderr.decode(errors='replace')}")
    raw = result.stdout
    if not raw:
        return []
    entries = raw.split(b"\x00")
    paths = sorted(e.decode("utf-8", errors="surrogateescape") for e in entries if e)
    return paths


def extract_design_section(design_text: str, heading: str) -> str:
    """Extract content under an exact heading until next heading of same/lower level."""
    lines = design_text.split("\n")
    heading_level = 0
    for ch in heading:
        if ch == "#":
            heading_level += 1
        else:
            break
    if heading_level == 0:
        raise ValueError(f"design_sections: not a valid heading: {heading!r}")

    start_idx = None
    for i, line in enumerate(lines):
        if line.rstrip() == heading.rstrip():
            start_idx = i
            break
    if start_idx is None:
        raise ValueError(f"design_sections: heading not found in docs/DESIGN.md: {heading!r}")

    end_idx = len(lines)
    for i in range(start_idx + 1, len(lines)):
        line = lines[i]
        if line.startswith("#"):
            level = 0
            for ch in line:
                if ch == "#":
                    level += 1
                else:
                    break
            if level <= heading_level:
                end_idx = i
                break

    section_lines = lines[start_idx:end_idx]
    return "\n".join(section_lines)


def validate_no_prefix_collisions(paths: list, label: str = "paths") -> None:
    """Reject if any path is a prefix (ancestor directory) of another."""
    path_set = set(paths)
    for p in paths:
        parts = p.split("/")
        for i in range(1, len(parts)):
            ancestor = "/".join(parts[:i])
            if ancestor in path_set:
                raise ValueError(f"{label}: prefix collision: {ancestor!r} is prefix of {p!r}")


# ---------------------------------------------------------------------------
# Manifest validation
# ---------------------------------------------------------------------------


def validate_manifest(manifest: dict, root: Path) -> None:
    """Validate manifest schema v1. Raises ValueError on failure."""
    if not isinstance(manifest, dict):
        raise ValueError("manifest: must be a JSON object")

    task = manifest.get("task")
    if not isinstance(task, str) or not task.strip():
        raise ValueError("manifest.task: must be a nonempty string")

    allowed = manifest.get("allowed_files")
    if not isinstance(allowed, list) or len(allowed) == 0:
        raise ValueError("manifest.allowed_files: must be a nonempty list")
    seen = set()
    canon_allowed = []
    for f in allowed:
        if not isinstance(f, str):
            raise ValueError(f"manifest.allowed_files: non-string entry: {f!r}")
        canon = safe_relpath(f, "allowed_files entry")
        if canon in seen:
            raise ValueError(f"manifest.allowed_files: duplicate: {canon!r}")
        seen.add(canon)
        canon_allowed.append(canon)
    validate_no_prefix_collisions(canon_allowed, "manifest.allowed_files")

    contract = manifest.get("contract")
    if not isinstance(contract, str) or not contract.strip():
        raise ValueError("manifest.contract: must be a nonempty string")

    deps = manifest.get("dependencies")
    if not isinstance(deps, list):
        raise ValueError("manifest.dependencies: must be a list")
    seen_deps = set()
    for d in deps:
        if not isinstance(d, str):
            raise ValueError(f"manifest.dependencies: non-string entry: {d!r}")
        canon = safe_relpath(d, "dependency")
        if canon in seen_deps:
            raise ValueError(f"manifest.dependencies: duplicate: {canon!r}")
        seen_deps.add(canon)
        dep_path = root / canon
        if not dep_path.exists():
            raise ValueError(f"manifest.dependencies: does not exist: {canon!r}")
        if dep_path.is_symlink():
            raise ValueError(f"manifest.dependencies: is a symlink: {canon!r}")
        if not dep_path.is_file():
            raise ValueError(f"manifest.dependencies: not a regular file: {canon!r}")

    sections = manifest.get("design_sections")
    if not isinstance(sections, list) or len(sections) == 0:
        raise ValueError("manifest.design_sections: must be a nonempty list")
    design_path = root / "docs" / "DESIGN.md"
    if not design_path.exists():
        raise ValueError("manifest.design_sections: docs/DESIGN.md not found")
    design_text = design_path.read_text(encoding="utf-8")
    for sec in sections:
        if not isinstance(sec, str):
            raise ValueError(f"manifest.design_sections: non-string entry: {sec!r}")
        extract_design_section(design_text, sec)

    issue_body = manifest.get("issue_body")
    if not isinstance(issue_body, str) or not issue_body.strip():
        raise ValueError("manifest.issue_body: must be a nonempty string")

    eh = manifest.get("expected_hashes")
    if eh is not None:
        if not isinstance(eh, dict):
            raise ValueError("manifest.expected_hashes: must be an object or null")
        for k, v in eh.items():
            if not isinstance(k, str):
                raise ValueError(f"manifest.expected_hashes: non-string key: {k!r}")
            safe_relpath(k, "expected_hashes key")
            if v is not None:
                if not isinstance(v, str):
                    raise ValueError(f"manifest.expected_hashes: value must be string or null: {v!r}")
                if len(v) != 64 or any(c not in "0123456789abcdef" for c in v):
                    raise ValueError(f"manifest.expected_hashes: {k!r} value must be 64 lowercase hex: {v!r}")


# ---------------------------------------------------------------------------
# Build command
# ---------------------------------------------------------------------------


def cmd_build(args: argparse.Namespace) -> None:
    manifest_path = Path(args.manifest)
    packet_dir = Path(args.packet_dir)
    root = Path(args.repo)

    # Check root components for symlinks BEFORE resolve
    check_root_components_no_symlink(root, "repo root")
    check_root_components_no_symlink(manifest_path, "manifest path")
    check_root_components_no_symlink(packet_dir, "packet dir")

    root = root.resolve()
    manifest_path = manifest_path.resolve()
    packet_dir = packet_dir.resolve()

    if not manifest_path.is_file():
        fail(f"manifest not found: {manifest_path}")

    if packet_dir.exists():
        fail(f"output directory already exists: {packet_dir}")

    if not is_outside_root(packet_dir, root):
        fail(f"PACKET_DIR must be outside repo root: {packet_dir}")

    manifest_raw = manifest_path.read_bytes()
    manifest = json.loads(manifest_raw)

    validate_manifest(manifest, root)

    manifest_sha = sha256_bytes(manifest_raw)

    # Read sources - single read for hash and content
    source_hashes = {}
    source_contents = {}
    source_modes = {}

    allowed_files = [safe_relpath(f, "allowed_files") for f in manifest["allowed_files"]]
    dependencies = [safe_relpath(d, "dependency") for d in manifest["dependencies"]]

    all_source_paths = list(dict.fromkeys(list(allowed_files) + dependencies))

    for rel in all_source_paths:
        full = root / rel
        check_no_symlink_in_chain(full, root, f"source {rel}")
        if full.is_symlink():
            fail(f"source is a symlink: {rel}")
        # Check no ancestor component is a regular file
        parts = rel.split("/")
        ancestor = root
        for part in parts[:-1]:
            ancestor = ancestor / part
            if ancestor.exists() and ancestor.is_file():
                fail(f"ancestor is a regular file (collision): {ancestor}")
        if full.exists():
            data = full.read_bytes()
            source_hashes[rel] = sha256_bytes(data)
            source_contents[rel] = data
            source_modes[rel] = stat.S_IMODE(full.stat().st_mode)
        else:
            source_hashes[rel] = None
            source_contents[rel] = None
            source_modes[rel] = None

    # ALWAYS include docs/DESIGN.md full bytes in source_hashes
    design_rel = "docs/DESIGN.md"
    design_full = root / design_rel
    check_no_symlink_in_chain(design_full, root, f"design {design_rel}")
    if design_full.is_symlink():
        fail(f"docs/DESIGN.md is a symlink")
    if design_rel in source_contents and source_contents[design_rel] is not None:
        design_bytes = source_contents[design_rel]
    else:
        design_bytes = design_full.read_bytes()
        design_sha = sha256_bytes(design_bytes)
        design_mode = stat.S_IMODE(design_full.stat().st_mode)
        source_hashes[design_rel] = design_sha
        source_contents[design_rel] = design_bytes
        source_modes[design_rel] = design_mode

    # Check expected_hashes
    expected_hashes = manifest.get("expected_hashes") or {}
    declared_source_set = set(all_source_paths)
    for rel, expected in expected_hashes.items():
        canon = safe_relpath(rel, "expected_hashes key")
        if canon not in declared_source_set:
            fail(f"expected_hashes: {canon} not in declared source set")
        if expected is not None:
            if not isinstance(expected, str) or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
                fail(f"expected_hashes: {canon} value must be 64 lowercase hex or null")
        if expected is None:
            if source_hashes.get(canon) is not None:
                fail(f"expected_hashes: {canon} expected to be new but exists")
        else:
            actual = source_hashes.get(canon)
            if actual is None:
                fail(f"expected_hashes: {canon} expected to exist but is missing")
            if actual != expected:
                fail(f"expected_hashes: {canon} mismatch: expected {expected}, got {actual}")

    # Design sections (reuse already-read bytes)
    design_text = design_bytes.decode("utf-8")
    design_sections_text = []
    for sec in manifest["design_sections"]:
        design_sections_text.append(extract_design_section(design_text, sec))

    # Git listing
    git_listing = run_git_ls_files(root)
    git_listing_sha = sha256_bytes("\n".join(git_listing).encode("utf-8"))

    # TS syntax checker hash
    ts_syntax_path = root / "scripts" / "ts_syntax.mjs"
    checker_sha = None
    if ts_syntax_path.is_file():
        checker_sha = sha256_file(ts_syntax_path)

    # Build prompt
    prompt_parts = []
    prompt_parts.append(f"# Task\n\n{manifest['task']}\n")
    prompt_parts.append(f"# Contract\n\n{manifest['contract']}\n")
    prompt_parts.append(f"# Allowed Files\n\n" + "\n".join(f"- `{f}`" for f in allowed_files) + "\n")
    prompt_parts.append(f"# Issue Body\n\n{manifest['issue_body']}\n")

    if design_sections_text:
        prompt_parts.append("# Design Sections\n\n" + "\n\n---\n\n".join(design_sections_text) + "\n")

    prompt_parts.append("# Git File Listing\n\n" + "\n".join(git_listing) + "\n")

    prompt_parts.append("# Source Files\n")
    for rel in all_source_paths:
        prompt_parts.append(f"\n## {rel}\n")
        if source_contents[rel] is not None:
            try:
                text = source_contents[rel].decode("utf-8")
            except UnicodeDecodeError:
                text = source_contents[rel].decode("latin-1")
            prompt_parts.append(f"```\n{text}\n```\n")
        else:
            prompt_parts.append("[NEW FILE - does not yet exist]\n")

    prompt_parts.append("# Output Protocol\n")
    prompt_parts.append(
        "Output ONLY the following format. No prose, no fences, no commentary.\n"
        "UTF-8, LF line endings.\n\n"
        "<<<FILE relative/path>>>\n"
        "full file content\n"
        "<<<END FILE relative/path>>>\n\n"
        "End with exactly:\n"
        "<<<END RESPONSE>>>\n"
    )

    prompt_text = "\n".join(prompt_parts)
    prompt_bytes = prompt_text.encode("utf-8")
    prompt_sha = sha256_bytes(prompt_bytes)

    # Estimate
    byte_count = len(prompt_bytes)
    char_count = len(prompt_text)
    estimated_tokens = math.ceil(byte_count / 4)

    # Write outputs
    try:
        packet_dir.mkdir(parents=True, exist_ok=False)
    except OSError as e:
        fail(f"cannot create packet dir: {e}")

    try:
        (packet_dir / "prompt.md").write_bytes(prompt_bytes)

        snapshot = {
            "schema": "jarvis_packet_v1",
            "root": str(root),
            "manifest_path": str(manifest_path),
            "manifest_sha256": manifest_sha,
            "allowed_files": allowed_files,
            "source_hashes": source_hashes,
            "source_modes": source_modes,
            "git_listing": git_listing,
            "git_listing_sha256": git_listing_sha,
            "prompt_sha256": prompt_sha,
            "checker_path": str(ts_syntax_path) if checker_sha else None,
            "checker_sha256": checker_sha,
            "estimate": {
                "bytes": byte_count,
                "characters": char_count,
                "estimated_tokens": estimated_tokens,
                "method": "ceil(UTF-8 bytes/4); heuristic, not tokenizer count",
            },
        }
        (packet_dir / "snapshot.json").write_text(
            json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

        shutil.copy2(str(manifest_path), str(packet_dir / "manifest.json"))
    except OSError as e:
        shutil.rmtree(str(packet_dir), ignore_errors=True)
        fail(f"write failed: {e}")


# ---------------------------------------------------------------------------
# check_snapshot (exported for jarvis_call.py)
# ---------------------------------------------------------------------------


def check_snapshot(repo: Path, snapshot: Path) -> dict:
    """Validate a snapshot against current repo state.

    Returns the snapshot dict on success.
    Raises ValueError on any mismatch or invalid input.
    """
    repo = Path(repo)
    snapshot = Path(snapshot)
    check_root_components_no_symlink(repo, "repo root")
    check_root_components_no_symlink(snapshot, "snapshot path")
    repo = repo.resolve()
    snapshot = snapshot.resolve()

    if not snapshot.is_file():
        raise ValueError(f"snapshot not found: {snapshot}")

    snap_raw = snapshot.read_bytes()

    try:
        snap = json.loads(snap_raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"snapshot is not valid JSON: {e}")

    if not isinstance(snap, dict):
        raise ValueError("snapshot: must be a JSON object")

    if snap.get("schema") != "jarvis_packet_v1":
        raise ValueError(f"snapshot: unexpected schema: {snap.get('schema')!r}")

    # Verify root identity
    snap_root = snap.get("root")
    if snap_root is None:
        raise ValueError("snapshot: missing root")
    if Path(snap_root).resolve() != repo:
        raise ValueError(f"snapshot: root mismatch: snapshot={snap_root}, actual={repo}")

    # Verify manifest
    manifest_path_str = snap.get("manifest_path")
    if manifest_path_str is None:
        raise ValueError("snapshot: missing manifest_path")
    manifest_path = Path(manifest_path_str)
    check_root_components_no_symlink(manifest_path, "manifest path from snapshot")
    if not manifest_path.is_file():
        raise ValueError(f"snapshot: manifest not found: {manifest_path}")
    actual_manifest_sha = sha256_file(manifest_path)
    if actual_manifest_sha != snap.get("manifest_sha256"):
        raise ValueError(
            f"snapshot: manifest sha mismatch: expected {snap.get('manifest_sha256')}, got {actual_manifest_sha}"
        )

    # Reparse manifest and validate source keys match exactly
    try:
        manifest_data = json.loads(manifest_path.read_bytes())
    except (json.JSONDecodeError, OSError) as e:
        raise ValueError(f"snapshot: cannot reparse manifest: {e}")

    if not isinstance(manifest_data, dict):
        raise ValueError("snapshot: manifest is not a dict")

    validate_manifest(manifest_data, repo)

    # Expected source keys from manifest: allowed_files + dependencies + docs/DESIGN.md
    expected_source_keys = set()
    for f in manifest_data.get("allowed_files", []):
        expected_source_keys.add(safe_relpath(f, "manifest allowed"))
    for d in manifest_data.get("dependencies", []):
        expected_source_keys.add(safe_relpath(d, "manifest dependency"))
    expected_source_keys.add("docs/DESIGN.md")

    source_hashes = snap.get("source_hashes")
    if not isinstance(source_hashes, dict):
        raise ValueError("snapshot: source_hashes must be an object")

    # Verify source keys match manifest exactly
    snap_source_keys = set(source_hashes.keys())
    if snap_source_keys != expected_source_keys:
        missing = expected_source_keys - snap_source_keys
        extra = snap_source_keys - expected_source_keys
        parts = []
        if missing:
            parts.append(f"missing from snapshot: {sorted(missing)}")
        if extra:
            parts.append(f"extra in snapshot: {sorted(extra)}")
        raise ValueError(f"snapshot: source keys mismatch: {'; '.join(parts)}")

    # Verify allowed_files in snapshot match manifest
    snap_allowed = snap.get("allowed_files")
    if not isinstance(snap_allowed, list):
        raise ValueError("snapshot: allowed_files must be a list")
    manifest_allowed = [safe_relpath(f, "snapshot allowed") for f in manifest_data.get("allowed_files", [])]
    if sorted(snap_allowed) != sorted(manifest_allowed):
        raise ValueError("snapshot: allowed_files mismatch with manifest")

    # Verify source hashes and modes
    source_modes = snap.get("source_modes", {})
    for rel, expected_sha in source_hashes.items():
        try:
            canon = safe_relpath(rel, "snapshot source path")
        except ValueError as e:
            raise ValueError(f"snapshot: invalid source path: {e}")
        full = repo / canon
        check_no_symlink_in_chain(full, repo, f"snapshot source {canon}")
        if full.is_symlink():
            raise ValueError(f"snapshot: source is a symlink: {canon}")
        if expected_sha is None:
            if full.exists():
                raise ValueError(f"snapshot: expected new file but exists: {canon}")
        else:
            if not full.exists():
                raise ValueError(f"snapshot: expected file missing: {canon}")
            actual = sha256_file(full)
            if actual != expected_sha:
                raise ValueError(f"snapshot: source sha mismatch: {canon}: expected {expected_sha}, got {actual}")
            # Verify mode
            expected_mode = source_modes.get(rel)
            if expected_mode is not None:
                actual_mode = stat.S_IMODE(full.stat().st_mode)
                if actual_mode != expected_mode:
                    raise ValueError(
                        f"snapshot: source mode mismatch: {canon}: expected {expected_mode}, got {actual_mode}"
                    )

    # Verify git listing
    current_listing = run_git_ls_files(repo)
    current_listing_sha = sha256_bytes("\n".join(current_listing).encode("utf-8"))
    if current_listing_sha != snap.get("git_listing_sha256"):
        raise ValueError(
            f"snapshot: git listing changed: expected {snap.get('git_listing_sha256')}, got {current_listing_sha}"
        )

    # Verify prompt hash (sibling prompt.md)
    prompt_path = snapshot.parent / "prompt.md"
    if not prompt_path.is_file():
        raise ValueError(f"snapshot: prompt.md not found at {prompt_path}")
    actual_prompt_sha = sha256_file(prompt_path)
    if actual_prompt_sha != snap.get("prompt_sha256"):
        raise ValueError(
            f"snapshot: prompt sha mismatch: expected {snap.get('prompt_sha256')}, got {actual_prompt_sha}"
        )

    # Verify checker hash if present
    checker_path_str = snap.get("checker_path")
    checker_sha = snap.get("checker_sha256")
    if checker_path_str and checker_sha:
        checker_path = Path(checker_path_str)
        if not checker_path.is_file():
            raise ValueError(f"snapshot: checker not found: {checker_path}")
        actual_checker_sha = sha256_file(checker_path)
        if actual_checker_sha != checker_sha:
            raise ValueError(
                f"snapshot: checker sha mismatch: expected {checker_sha}, got {actual_checker_sha}"
            )

    return snap


# ---------------------------------------------------------------------------
# Check command
# ---------------------------------------------------------------------------


def cmd_check(args: argparse.Namespace) -> None:
    snapshot_path = Path(args.snapshot)
    root = Path(args.repo)
    check_snapshot(root, snapshot_path)
    print("OK")


# ---------------------------------------------------------------------------
# Output protocol parser (state machine)
# ---------------------------------------------------------------------------

FILE_START_RE = re.compile(r"^<<<FILE (.+)>>>$")
FILE_END_RE = re.compile(r"^<<<END FILE (.+)>>>$")
TERMINAL = "<<<END RESPONSE>>>"


def parse_output(content: str, allowed_files: list) -> dict:
    """Parse the output protocol. Returns {relpath: content_bytes}.

    Raises ValueError on any protocol violation.
    """
    # Require final newline
    if not content.endswith("\n"):
        raise ValueError("output protocol: content must end with final newline")
    # Reject CR
    if "\r" in content:
        raise ValueError("output protocol: CR characters not allowed")

    lines = content.split("\n")
    # Last element after split on trailing \n is ""
    # Remove it for processing (we know content ends with \n)
    if lines and lines[-1] == "":
        lines = lines[:-1]

    files = {}
    state = "EXPECT_START"
    current_path = None
    current_lines = []
    i = 0

    while i < len(lines):
        line = lines[i]

        if state == "EXPECT_START":
            m = FILE_START_RE.match(line)
            if m:
                raw_path = m.group(1)
                try:
                    current_path = safe_relpath(raw_path, "output file path")
                except ValueError as e:
                    raise ValueError(f"output protocol: unsafe path: {e}")
                if current_path in files:
                    raise ValueError(f"output protocol: duplicate file: {current_path}")
                if current_path not in allowed_files:
                    raise ValueError(f"output protocol: file not in allowlist: {current_path}")
                current_lines = []
                state = "IN_FILE"
            elif line == TERMINAL:
                if not files:
                    raise ValueError("output protocol: no files before terminal")
                state = "DONE"
            elif line.strip() == "":
                pass  # blank envelope lines between files are allowed
            else:
                raise ValueError(f"output protocol: unexpected line in EXPECT_START: {line!r}")

        elif state == "IN_FILE":
            # Reject nested delimiter lines inside open file
            if FILE_START_RE.match(line):
                raise ValueError(
                    f"output protocol: nested FILE start inside open file {current_path}: {line!r}"
                )
            m = FILE_END_RE.match(line)
            if m:
                end_path = m.group(1)
                try:
                    end_canon = safe_relpath(end_path, "END FILE path")
                except ValueError as e:
                    raise ValueError(f"output protocol: unsafe END path: {e}")
                if end_canon != current_path:
                    raise ValueError(
                        f"output protocol: END path mismatch: started {current_path}, ended {end_canon}"
                    )
                # Reconstruct content preserving trailing LF count
                file_content = "\n".join(current_lines) + "\n"
                if not file_content.strip():
                    raise ValueError(f"output protocol: empty file: {current_path}")
                _check_omission(file_content, current_path)
                files[current_path] = file_content.encode("utf-8")
                current_path = None
                current_lines = []
                state = "EXPECT_START"
            else:
                if line == TERMINAL:
                    raise ValueError(
                        f"output protocol: incomplete file; nested END RESPONSE inside open file {current_path}"
                    )
                current_lines.append(line)

        elif state == "DONE":
            if line.strip() != "":
                raise ValueError(f"output protocol: trailing content after terminal: {line!r}")

        i += 1

    if state == "IN_FILE":
        raise ValueError("output protocol: incomplete file (missing END FILE)")
    if state == "EXPECT_START" and not files:
        raise ValueError("output protocol: no files found")
    if state == "EXPECT_START" and files:
        raise ValueError("output protocol: missing terminal <<<END RESPONSE>>>")

    # Check all allowed files are present
    for af in allowed_files:
        if af not in files:
            raise ValueError(f"output protocol: missing file from allowlist: {af}")

    return files


def _check_omission(content: str, path: str) -> None:
    """Reject obvious omission markers. Legitimate strings in code are allowed."""
    lines = content.split("\n")
    for line in lines:
        stripped = line.strip()
        if stripped == "...":
            # Permit literal ellipsis in Markdown indented code examples.
            # A line starting with exactly four spaces in a .md/.markdown file
            # is a Markdown indented code block, not an omitted body marker.
            # Unindented Markdown ellipsis and code-file ellipsis still reject.
            if not (path.endswith(".md") or path.endswith(".markdown")):
                raise ValueError(f"output protocol: omission marker '...' in {path}")
            if not line.startswith("    "):
                raise ValueError(f"output protocol: omission marker '...' in {path}")
        if stripped in ("rest unchanged", "omitted for brevity",
                        "// rest unchanged", "// omitted for brevity",
                        "# rest unchanged", "# omitted for brevity"):
            raise ValueError(f"output protocol: omission marker in {path}: {stripped!r}")
    # Reject files that are essentially just a TODO placeholder
    non_empty = [l for l in lines if l.strip()]
    if len(non_empty) <= 2:
        joined = " ".join(non_empty).lower()
        if joined.startswith("todo") and len(joined) < 80:
            raise ValueError(f"output protocol: file appears to be a TODO placeholder: {path}")


# ---------------------------------------------------------------------------
# Syntax validation
# ---------------------------------------------------------------------------


def syntax_check_file(file_path: Path, root: Path) -> tuple:
    """Run syntax check on a file. Returns (ok: bool, log: str, exit_code: int)."""
    ext = file_path.suffix.lower()

    if ext in (".ts", ".tsx", ".mts", ".cts"):
        ts_syntax = root / "scripts" / "ts_syntax.mjs"
        if not ts_syntax.is_file():
            return (False, f"ts_syntax.mjs not found at {ts_syntax}", 1)
        node = os.environ.get("JARVIS_NODE", "node")
        try:
            result = subprocess.run(
                [node, str(ts_syntax), str(file_path)],
                capture_output=True,
                timeout=60,
                text=True,
            )
            log = f"exit={result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            return (result.returncode == 0, log, result.returncode)
        except subprocess.TimeoutExpired:
            return (False, "timeout after 60s", -1)
        except OSError as e:
            return (False, f"cannot run node: {e}", -1)

    elif ext == ".py":
        try:
            source = file_path.read_text(encoding="utf-8")
            ast.parse(source, filename=str(file_path))
            return (True, "ast.parse OK", 0)
        except SyntaxError as e:
            return (False, f"SyntaxError: {e}", 1)

    elif ext == ".json":
        try:
            data = file_path.read_text(encoding="utf-8")
            json.loads(data)
            return (True, "json.loads OK", 0)
        except json.JSONDecodeError as e:
            return (False, f"JSONDecodeError: {e}", 1)

    elif ext in (".sh", ".bash"):
        try:
            result = subprocess.run(
                ["bash", "-n", str(file_path)],
                capture_output=True,
                timeout=10,
                text=True,
            )
            log = f"exit={result.returncode}\n{result.stderr}"
            return (result.returncode == 0, log, result.returncode)
        except (subprocess.TimeoutExpired, OSError) as e:
            return (False, f"bash -n failed: {e}", -1)

    else:
        return (True, "no syntax check for this extension", 0)


# ---------------------------------------------------------------------------
# Stage command
# ---------------------------------------------------------------------------


def _write_validation(request_dir: Path, status: str, reason: str,
                      hand_edits: list = None) -> None:
    """Write validation.json to request dir. Best-effort.
    Preserves incomplete_seen and hand_edits across re-staging."""
    try:
        existing = {}
        vpath = request_dir / "validation.json"
        if vpath.is_file():
            try:
                existing = json.loads(vpath.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                existing = {}
        if not isinstance(existing, dict):
            existing = {}
        prev_incomplete_seen = existing.get("incomplete_seen", False)
        prev_hand_edits = existing.get("hand_edits", [])
        if not isinstance(prev_hand_edits, list):
            prev_hand_edits = []
        incomplete_seen = (status == "incomplete") or bool(prev_incomplete_seen)
        merged_hand_edits = list(prev_hand_edits)
        if hand_edits:
            for he in hand_edits:
                if he not in merged_hand_edits:
                    merged_hand_edits.append(he)
        validation = {
            "status": status,
            "reason": reason,
            "incomplete_seen": incomplete_seen,
            "hand_edits": merged_hand_edits,
        }
        vpath.write_text(
            json.dumps(validation, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        pass


def cmd_stage(args: argparse.Namespace) -> None:
    request_dir = Path(args.request_dir)
    stage_dir = Path(args.stage_dir)
    root = Path(args.repo)

    # Check root components for symlinks BEFORE resolve
    check_root_components_no_symlink(root, "repo root")
    check_root_components_no_symlink(request_dir, "request dir")
    check_root_components_no_symlink(stage_dir, "stage dir")

    request_dir = request_dir.resolve()
    stage_dir = stage_dir.resolve()
    root = root.resolve()

    if not is_outside_root(stage_dir, root):
        fail(f"STAGE_DIR must be outside repo root: {stage_dir}")

    if stage_dir.exists():
        fail(f"stage directory already exists: {stage_dir}")

    # --- Load and validate meta ---
    meta_path = request_dir / "meta.json"
    check_root_components_no_symlink(meta_path, "request meta.json")
    if not meta_path.is_file():
        _write_validation(request_dir, "failed", "meta.json not found")
        fail(f"meta.json not found in {request_dir}")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        _write_validation(request_dir, "failed", f"cannot read meta.json: {e}")
        fail(f"cannot read meta.json: {e}")

    if not isinstance(meta, dict):
        _write_validation(request_dir, "failed", "meta.json is not a dict")
        fail("meta.json is not a dict")

    # Validate meta fields - shape check before access
    if meta.get("status") != "ok":
        _write_validation(request_dir, "failed", f"meta.status={meta.get('status')!r}")
        fail(f"meta.status must be 'ok', got {meta.get('status')!r}")
    if meta.get("exit_code") != 0:
        _write_validation(request_dir, "failed", f"meta.exit_code={meta.get('exit_code')!r}")
        fail(f"meta.exit_code must be 0, got {meta.get('exit_code')!r}")
    if meta.get("effort") != "low":
        _write_validation(request_dir, "failed", f"meta.effort={meta.get('effort')!r}")
        fail(f"meta.effort must be 'low', got {meta.get('effort')!r}")
    model_root = meta.get("model_root")
    if not isinstance(model_root, str) or not model_root.strip():
        _write_validation(request_dir, "failed", "meta.model_root invalid")
        fail("meta.model_root must be a nonempty string")
    if meta.get("finish_reason") != "stop":
        _write_validation(request_dir, "failed", f"meta.finish_reason={meta.get('finish_reason')!r}")
        fail(f"meta.finish_reason must be 'stop', got {meta.get('finish_reason')!r}")
    if meta.get("post_attempts") != 1:
        _write_validation(request_dir, "failed", f"meta.post_attempts={meta.get('post_attempts')!r}")
        fail(f"meta.post_attempts must be 1, got {meta.get('post_attempts')!r}")

    # REQUIRE content_sha256 in meta
    meta_content_sha = meta.get("content_sha256")
    if not isinstance(meta_content_sha, str) or not meta_content_sha:
        _write_validation(request_dir, "failed", "meta.content_sha256 missing or invalid")
        fail("meta.content_sha256 is required and must be a nonempty string")

    # REQUIRE exit_code file
    ec_file = request_dir / "exit_code"
    check_root_components_no_symlink(ec_file, "request exit_code")
    if not ec_file.is_file():
        _write_validation(request_dir, "failed", "exit_code file missing")
        fail(f"exit_code file not found in {request_dir}")
    try:
        ec_content = ec_file.read_text(encoding="utf-8").strip()
    except OSError as e:
        _write_validation(request_dir, "failed", f"cannot read exit_code: {e}")
        fail(f"cannot read exit_code file: {e}")
    if ec_content != "0":
        _write_validation(request_dir, "failed", f"exit_code file={ec_content!r}")
        fail(f"exit_code file contains {ec_content!r}, expected '0'")

    # Load snapshot
    snapshot_path_str = meta.get("snapshot_path")
    if not isinstance(snapshot_path_str, str) or not snapshot_path_str:
        _write_validation(request_dir, "failed", "meta.snapshot_path missing")
        fail("meta.snapshot_path is required")
    snapshot_path = Path(snapshot_path_str)
    if not snapshot_path.is_file():
        _write_validation(request_dir, "failed", f"snapshot not found: {snapshot_path}")
        fail(f"snapshot not found: {snapshot_path}")

    # Verify snapshot SHA
    expected_snap_sha = meta.get("snapshot_sha256")
    if not isinstance(expected_snap_sha, str) or not expected_snap_sha:
        _write_validation(request_dir, "failed", "meta.snapshot_sha256 missing")
        fail("meta.snapshot_sha256 is required")
    actual_snap_sha = sha256_file(snapshot_path)
    if actual_snap_sha != expected_snap_sha:
        _write_validation(request_dir, "failed", f"snapshot sha mismatch")
        fail(f"snapshot sha mismatch: meta says {expected_snap_sha}, actual {actual_snap_sha}")

    # Load and validate snapshot
    try:
        snap = check_snapshot(root, snapshot_path)
    except ValueError as e:
        _write_validation(request_dir, "failed", f"snapshot validation: {e}")
        fail(f"snapshot validation failed: {e}")

    # Verify prompt_sha256 matches
    meta_prompt_sha = meta.get("prompt_sha256")
    if meta_prompt_sha != snap.get("prompt_sha256"):
        _write_validation(request_dir, "failed", "prompt sha mismatch")
        fail(
            f"prompt sha mismatch: meta={meta_prompt_sha}, snapshot={snap.get('prompt_sha256')}"
        )

    # REQUIRE content.md
    content_path = request_dir / "content.md"
    check_root_components_no_symlink(content_path, "request content.md")
    if not content_path.is_file():
        _write_validation(request_dir, "failed", "content.md not found")
        fail(f"content.md not found in {request_dir}")
    content_bytes = content_path.read_bytes()
    content_sha = sha256_bytes(content_bytes)

    # Verify content_sha256 from meta
    if meta_content_sha != content_sha:
        _write_validation(request_dir, "failed", "content sha mismatch")
        fail(f"content sha mismatch: meta={meta_content_sha}, actual={content_sha}")

    # REQUIRE reply.json
    reply_path = request_dir / "reply.json"
    check_root_components_no_symlink(reply_path, "request reply.json")
    if not reply_path.is_file():
        _write_validation(request_dir, "failed", "reply.json not found")
        fail(f"reply.json not found in {request_dir}")
    try:
        reply_raw = reply_path.read_bytes()
        reply = json.loads(reply_raw)
    except (OSError, json.JSONDecodeError) as e:
        _write_validation(request_dir, "failed", f"cannot parse reply.json: {e}")
        fail(f"cannot parse reply.json: {e}")

    # Shape check reply structure before access
    if not isinstance(reply, dict):
        _write_validation(request_dir, "failed", "reply.json is not a dict")
        fail("reply.json is not a dict")
    choices = reply.get("choices")
    if not isinstance(choices, list) or len(choices) == 0:
        _write_validation(request_dir, "failed", "reply.json choices missing/empty")
        fail("reply.json choices missing or empty")
    choice0 = choices[0]
    if not isinstance(choice0, dict):
        _write_validation(request_dir, "failed", "reply.json choices[0] not a dict")
        fail("reply.json choices[0] is not a dict")
    message = choice0.get("message")
    if not isinstance(message, dict):
        _write_validation(request_dir, "failed", "reply.json choices[0].message not a dict")
        fail("reply.json choices[0].message is not a dict")
    reply_content = message.get("content")
    if not isinstance(reply_content, str):
        _write_validation(request_dir, "failed", "reply.json content not a string")
        fail("reply.json choices[0].message.content is not a string")

    if reply_content.encode("utf-8") != content_bytes:
        _write_validation(request_dir, "failed", "reply.json content does not match content.md")
        fail("reply.json content does not match content.md")

    # Verify finish_reason in reply
    reply_fr = choice0.get("finish_reason")
    if reply_fr != "stop":
        _write_validation(request_dir, "failed", f"reply finish_reason={reply_fr!r}")
        fail(f"reply.json finish_reason is {reply_fr!r}, expected 'stop'")

    # Parse output
    allowed_files = snap.get("allowed_files", [])
    try:
        content_text = content_bytes.decode("utf-8")
    except UnicodeDecodeError:
        _write_validation(request_dir, "incomplete", "content.md is not valid UTF-8")
        fail("content.md is not valid UTF-8")

    # Envelope repair: only append ONE final LF when content has no final LF
    # AND ends exactly with <<<END RESPONSE>>>. No other modification.
    repair_record = None
    parsing_text = content_text
    if not content_text.endswith("\n") and content_text.endswith(TERMINAL):
        if getattr(args, "repair_envelope", False):
            parsing_text = content_text + "\n"
            repaired_bytes = parsing_text.encode("utf-8")
            repair_record = {
                "operation": "Append final LF after complete <<<END RESPONSE>>> delimiter",
                "original_content_sha256": content_sha,
                "repaired_content_sha256": sha256_bytes(repaired_bytes),
                "hand_edit": {
                    "file": "response envelope",
                    "reason": "Quoted exact mechanical operation: append one final LF byte after complete terminal delimiter; no content modification.",
                },
            }
        # else: strict parse will reject (no final newline)
    # If content already ends with \n, no repair needed (no-op even with flag)

    try:
        parsed_files = parse_output(parsing_text, allowed_files)
    except ValueError as e:
        _write_validation(request_dir, "incomplete", f"output parsing: {e}")
        fail(f"output parsing failed: {e}")

    # Create stage dir
    try:
        stage_dir.mkdir(parents=True, exist_ok=False)
    except OSError as e:
        fail(f"cannot create stage dir: {e}")

    # Write parsed files to stage
    files_dir = stage_dir / "files"
    files_dir.mkdir()

    file_hashes = {}
    syntax_logs = {}
    all_ok = True

    for rel, data in parsed_files.items():
        out_path = files_dir / rel
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(data)
        file_hashes[rel] = sha256_bytes(data)

        # Syntax check
        ok, log, ec = syntax_check_file(out_path, root)
        syntax_logs[rel] = {"ok": ok, "log": log, "exit_code": ec}
        if not ok:
            all_ok = False

    # Write syntax logs using subdirs to avoid collision
    logs_dir = stage_dir / "logs"
    logs_dir.mkdir()
    syntax_log_hashes = {}
    for rel, info in syntax_logs.items():
        log_rel = rel + ".log"
        log_path = logs_dir / log_rel
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_bytes = info["log"].encode("utf-8")
        log_path.write_bytes(log_bytes)
        syntax_log_hashes[rel] = sha256_bytes(log_bytes)

    # Record base hashes and modes for existing files
    base_info = {}
    for rel in parsed_files:
        full = root / rel
        if full.exists():
            base_info[rel] = {
                "sha256": sha256_file(full),
                "mode": stat.S_IMODE(full.stat().st_mode),
            }
        else:
            base_info[rel] = {"sha256": None, "mode": None}

    # Verify files set == allowed_files == base_info keys == syntax keys
    assert set(file_hashes.keys()) == set(allowed_files)
    assert set(base_info.keys()) == set(allowed_files)
    assert set(syntax_logs.keys()) == set(allowed_files)

    # Write repair record if applicable
    repair_sha = None
    if repair_record is not None:
        repair_bytes = (json.dumps(repair_record, indent=2, sort_keys=True) + "\n").encode("utf-8")
        (stage_dir / "response-repair.json").write_bytes(repair_bytes)
        repair_sha = sha256_bytes(repair_bytes)

    # Write stage manifest
    stage_manifest = {
        "request_dir": str(request_dir),
        "snapshot_path": str(snapshot_path),
        "snapshot_sha256": actual_snap_sha,
        "meta_sha256": sha256_file(meta_path),
        "content_sha256": content_sha,
        "reply_sha256": sha256_bytes(reply_raw),
        "exit_code_sha256": sha256_file(ec_file),
        "file_hashes": file_hashes,
        "base_info": base_info,
        "syntax_logs": {k: v["ok"] for k, v in syntax_logs.items()},
        "syntax_log_hashes": syntax_log_hashes,
        "syntax_log_exit_codes": {k: v["exit_code"] for k, v in syntax_logs.items()},
        "parse_complete": True,
        "syntax_all_ok": all_ok,
        "repair_sha256": repair_sha,
    }
    (stage_dir / "stage_manifest.json").write_text(
        json.dumps(stage_manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    # Write validation.json
    repair_hand_edits = [repair_record["hand_edit"]] if repair_record else None
    if all_ok:
        _write_validation(request_dir, "ok", "", hand_edits=repair_hand_edits)
    else:
        failed = [k for k, v in syntax_logs.items() if not v["ok"]]
        _write_validation(request_dir, "failed", f"syntax check failed for: {', '.join(failed)}",
                          hand_edits=repair_hand_edits)
        fail("syntax validation failed; see stage logs")


# ---------------------------------------------------------------------------
# Apply command
# ---------------------------------------------------------------------------


def cmd_apply(args: argparse.Namespace) -> None:
    stage_dir = Path(args.stage_dir)
    root = Path(args.repo)

    check_root_components_no_symlink(root, "repo root")
    check_root_components_no_symlink(stage_dir, "stage dir")

    stage_dir = stage_dir.resolve()
    root = root.resolve()

    if not is_outside_root(stage_dir, root):
        fail(f"STAGE_DIR must be outside repo root: {stage_dir}")

    # Refuse if already applied
    applied_path = stage_dir / "applied.json"
    if applied_path.exists():
        fail(f"stage already applied: {applied_path}")

    # Refuse if backup dir already exists
    backup_dir = stage_dir / "backup"
    if backup_dir.exists():
        fail(f"backup directory already exists (stale?): {backup_dir}")

    # Load stage manifest
    sm_path = stage_dir / "stage_manifest.json"
    if not sm_path.is_file():
        fail(f"stage_manifest.json not found in {stage_dir}")
    try:
        sm = json.loads(sm_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        fail(f"cannot read stage_manifest.json: {e}")

    if not isinstance(sm, dict):
        fail("stage_manifest.json is not a dict")

    if not sm.get("parse_complete"):
        fail("stage manifest: parse not complete")
    if not sm.get("syntax_all_ok"):
        fail("stage manifest: syntax checks did not all pass")

    # Recheck snapshot
    snapshot_path_str = sm.get("snapshot_path")
    if not isinstance(snapshot_path_str, str):
        fail("stage manifest: snapshot_path missing")
    snapshot_path = Path(snapshot_path_str)
    if not snapshot_path.is_file():
        fail(f"snapshot not found: {snapshot_path}")
    actual_snap_sha = sha256_file(snapshot_path)
    if actual_snap_sha != sm.get("snapshot_sha256"):
        fail(f"snapshot sha mismatch at apply time: expected {sm['snapshot_sha256']}, got {actual_snap_sha}")

    try:
        snap = check_snapshot(root, snapshot_path)
    except ValueError as e:
        fail(f"snapshot revalidation failed: {e}")

    # Recheck request meta/content/reply/exit_code hashes
    request_dir_str = sm.get("request_dir")
    if not isinstance(request_dir_str, str):
        fail("stage manifest: request_dir missing")
    request_dir = Path(request_dir_str)
    check_root_components_no_symlink(request_dir, "request dir")

    meta_path = request_dir / "meta.json"
    check_root_components_no_symlink(meta_path, "request meta.json")
    if not meta_path.is_file():
        fail(f"request meta.json not found: {meta_path}")
    if sha256_file(meta_path) != sm.get("meta_sha256"):
        fail("request meta.json hash mismatch at apply time")

    content_path = request_dir / "content.md"
    check_root_components_no_symlink(content_path, "request content.md")
    if not content_path.is_file():
        fail(f"request content.md not found: {content_path}")
    if sha256_file(content_path) != sm.get("content_sha256"):
        fail("request content.md hash mismatch at apply time")

    reply_path = request_dir / "reply.json"
    check_root_components_no_symlink(reply_path, "request reply.json")
    if not reply_path.is_file():
        fail(f"request reply.json not found: {reply_path}")
    if sha256_file(reply_path) != sm.get("reply_sha256"):
        fail("request reply.json hash mismatch at apply time")

    ec_file = request_dir / "exit_code"
    check_root_components_no_symlink(ec_file, "request exit_code")
    if not ec_file.is_file():
        fail(f"request exit_code file not found: {ec_file}")
    if sha256_file(ec_file) != sm.get("exit_code_sha256"):
        fail("request exit_code file hash mismatch at apply time")

    # Recheck staged file hashes
    files_dir = stage_dir / "files"
    file_hashes = sm.get("file_hashes")
    if not isinstance(file_hashes, dict):
        fail("stage manifest: file_hashes must be a dict")

    for rel, expected_sha in file_hashes.items():
        try:
            canon = safe_relpath(rel, "staged file path")
        except ValueError as e:
            fail(f"staged file unsafe path: {e}")
        staged_file = files_dir / canon
        check_no_symlink_in_chain(staged_file, files_dir, f"staged file {canon}")
        if not staged_file.is_file():
            fail(f"staged file missing: {rel}")
        if staged_file.is_symlink():
            fail(f"staged file is a symlink: {rel}")
        actual = sha256_file(staged_file)
        if actual != expected_sha:
            fail(f"staged file hash mismatch: {rel}: expected {expected_sha}, got {actual}")

    # Recheck syntax log hashes
    logs_dir = stage_dir / "logs"
    check_root_components_no_symlink(logs_dir, "logs dir")
    syntax_log_hashes = sm.get("syntax_log_hashes", {})
    syntax_log_exit_codes = sm.get("syntax_log_exit_codes", {})
    for rel, expected_log_sha in syntax_log_hashes.items():
        log_rel = rel + ".log"
        log_file = logs_dir / log_rel
        if not log_file.is_file():
            fail(f"syntax log missing: {log_rel}")
        actual = sha256_file(log_file)
        if actual != expected_log_sha:
            fail(f"syntax log hash mismatch: {log_rel}")
        # Verify exit code stored in log
        stored_ec = syntax_log_exit_codes.get(rel)
        if stored_ec is not None and stored_ec != 0:
            fail(f"syntax log exit code non-zero for {rel}: {stored_ec}")

    # Verify files set == snapshot.allowed_files == base_info keys == syntax keys
    allowed_files = snap.get("allowed_files", [])
    base_info = sm.get("base_info", {})
    syntax_logs = sm.get("syntax_logs", {})

    if set(file_hashes.keys()) != set(allowed_files):
        fail("stage file set does not match snapshot allowed_files")
    if set(base_info.keys()) != set(allowed_files):
        fail("stage base_info keys do not match snapshot allowed_files")
    if set(syntax_logs.keys()) != set(allowed_files):
        fail("stage syntax log keys do not match snapshot allowed_files")
    if set(syntax_log_hashes.keys()) != set(allowed_files):
        fail("stage syntax log hash keys do not match allowed_files")
    if set(syntax_log_exit_codes.keys()) != set(allowed_files):
        fail("stage syntax log exit code keys do not match allowed_files")
    for rel in allowed_files:
        if not syntax_logs.get(rel):
            fail(f"syntax log status not True for {rel}")
        ec = syntax_log_exit_codes.get(rel)
        if ec != 0:
            fail(f"syntax log exit code not 0 for {rel}: {ec}")

    # Recheck base info (sources unchanged since staging) including modes
    for rel, info in base_info.items():
        try:
            canon = safe_relpath(rel, "base_info path")
        except ValueError as e:
            fail(f"base_info unsafe path: {e}")
        full = root / canon
        if info["sha256"] is None:
            if full.exists():
                fail(f"source appeared since staging: {rel}")
        else:
            if not full.exists():
                fail(f"source disappeared since staging: {rel}")
            actual = sha256_file(full)
            if actual != info["sha256"]:
                fail(f"source changed since staging: {rel}: expected {info['sha256']}, got {actual}")
            # Verify mode
            expected_mode = info.get("mode")
            if expected_mode is not None:
                actual_mode = stat.S_IMODE(full.stat().st_mode)
                if actual_mode != expected_mode:
                    fail(f"source mode changed since staging: {rel}: expected {expected_mode}, got {actual_mode}")

    # Recheck checker if snapshot has one
    checker_path_str = snap.get("checker_path")
    checker_sha = snap.get("checker_sha256")
    if checker_path_str and checker_sha:
        checker_path = Path(checker_path_str)
        if not checker_path.is_file():
            fail(f"checker not found at apply time: {checker_path}")
        if sha256_file(checker_path) != checker_sha:
            fail("checker changed since staging")

    # Recheck repair record if present
    repair_sha = sm.get("repair_sha256")
    if repair_sha is not None:
        repair_path = stage_dir / "response-repair.json"
        if not repair_path.is_file():
            fail("repair record missing at apply time")
        if sha256_file(repair_path) != repair_sha:
            fail("repair record hash mismatch at apply time")

    # Preflight all target paths: symlinks, parent collisions
    for rel in file_hashes:
        canon = safe_relpath(rel, "target path")
        target = root / canon
        check_no_symlink_in_chain(target, root, f"target {canon}")
        if target.is_symlink():
            fail(f"target is a symlink: {canon}")
        # Check parent chain for file/directory collisions
        parent = target.parent
        if parent.exists() and parent.is_file():
            fail(f"parent is a file (collision): {parent}")
        # Check ancestors
        ancestor = target
        while ancestor != root:
            if ancestor.exists() and ancestor.is_file() and ancestor != target:
                fail(f"ancestor is a file (collision): {ancestor}")
            ancestor = ancestor.parent

    # All validation passed. Build ordered plan.
    # Determine existing vs new for each target
    plan = []
    for rel in file_hashes:
        canon = safe_relpath(rel, "plan path")
        target = root / canon
        exists = target.exists()
        plan.append({"rel": canon, "target": target, "exists": exists})

    # Prepare ALL backups before any mutation
    try:
        backup_dir.mkdir(parents=True, exist_ok=False)
    except OSError as e:
        fail(f"cannot create backup dir: {e}")

    backed_up = []  # list of (rel, target, had_backup)
    try:
        for item in plan:
            target = item["target"]
            if item["exists"]:
                bak = backup_dir / item["rel"]
                bak.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(target), str(bak))
                backed_up.append((item["rel"], target, True))
            else:
                backed_up.append((item["rel"], target, False))
    except OSError as e:
        # Backup failed - no mutations have occurred, just fail
        shutil.rmtree(str(backup_dir), ignore_errors=True)
        fail(f"backup failed, no changes made: {e}")

    # Track every new ancestor dir for cleanup
    created_dirs = []

    # Preflight: ensure parent dirs exist or can be created
    for item in plan:
        target = item["target"]
        parent = target.parent
        if not parent.exists():
            # Will need to create - check no file collision in chain
            check_no_symlink_in_chain(parent, root, f"parent of {item['rel']}")

    # Apply mutations
    written_targets = []  # targets we actually wrote to
    try:
        for item in plan:
            target = item["target"]
            rel = item["rel"]

            # Ensure parent dirs exist, tracking created ones
            parent = target.parent
            if not parent.exists():
                # Create all missing ancestors
                missing = []
                check = parent
                while not check.exists() and check != root:
                    missing.append(check)
                    check = check.parent
                for d in reversed(missing):
                    d.mkdir(exist_ok=True)
                    created_dirs.append(d)

            # Mark before write (for rollback of partial writes)
            written_targets.append((rel, target, item["exists"]))

            # Write new content
            staged_file = files_dir / rel
            data = staged_file.read_bytes()
            target.write_bytes(data)

            # Set mode
            base = base_info.get(rel, {})
            if base.get("mode") is not None:
                os.chmod(str(target), base["mode"])
            else:
                os.chmod(str(target), 0o644)

    except OSError as e:
        # Rollback: restore only written targets
        restore_errors = []
        for rel, target, existed in reversed(written_targets):
            try:
                if existed:
                    bak = backup_dir / rel
                    if bak.is_file():
                        shutil.copy2(str(bak), str(target))
                    else:
                        restore_errors.append(f"backup missing for {rel}")
                else:
                    if target.exists():
                        target.unlink()
            except OSError as re_err:
                restore_errors.append(f"restore failed for {rel}: {re_err}")

        # Clean created dirs
        for d in reversed(created_dirs):
            try:
                d.rmdir()
            except OSError:
                pass

        if restore_errors:
            print(f"WARNING: rollback errors: {'; '.join(restore_errors)}", file=sys.stderr)
            print(f"Recovery files in: {backup_dir}", file=sys.stderr)
        fail(f"apply failed, rolled back: {e}")

    # Record applied status
    applied = {
        "status": "applied",
        "snapshot_sha256": actual_snap_sha,
        "file_hashes": file_hashes,
        "backup_dir": str(backup_dir),
    }
    (stage_dir / "applied.json").write_text(
        json.dumps(applied, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    print("applied")


# ---------------------------------------------------------------------------
# Summary command
# ---------------------------------------------------------------------------


def cmd_summary(args: argparse.Namespace) -> None:
    # Deduplicate request dirs
    seen_dirs = set()
    request_dirs = []
    for d in args.request_dirs:
        resolved = str(Path(d).resolve())
        if resolved in seen_dirs:
            fail(f"duplicate request directory: {resolved}")
        seen_dirs.add(resolved)
        request_dirs.append(Path(resolved))

    hand_edits = []
    if args.hand_edits:
        try:
            raw = json.loads(Path(args.hand_edits).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            fail(f"cannot read hand-edits: {e}")
        if not isinstance(raw, list):
            fail("hand-edits file must contain a JSON list")
        for he in raw:
            if not isinstance(he, dict):
                fail("hand-edits entries must be objects")
            if "file" not in he:
                fail("hand-edits entry missing 'file' key")
        hand_edits = raw

    total = len(request_dirs)
    post_attempts_known = 0
    post_attempts_unknown = 0
    model_roots = set()
    timings = {"queue_seconds": [], "probe_seconds": [], "request_seconds": [], "total_seconds": []}
    incomplete = 0
    failures = 0
    cancelled = 0
    unresolved = 0
    malformed = 0
    legacy_seen = False

    for rd in request_dirs:
        meta_path = rd / "meta.json"
        if not meta_path.is_file():
            unresolved += 1
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            malformed += 1
            unresolved += 1
            continue

        if not isinstance(meta, dict):
            malformed += 1
            unresolved += 1
            continue

        # post_attempts: count known only, never invent
        pa = meta.get("post_attempts")
        if isinstance(pa, int) and pa >= 0:
            post_attempts_known += pa
        else:
            post_attempts_unknown += 1

        mr = meta.get("model_root")
        if isinstance(mr, str) and mr:
            model_roots.add(mr)

        # Timings: only finite non-negative values
        for key in ("queue_seconds", "probe_seconds", "request_seconds", "total_seconds"):
            val = meta.get(key)
            if isinstance(val, (int, float)):
                if val == val and val != float("inf") and val != float("-inf") and val >= 0:
                    timings[key].append(val)

        # Legacy 'seconds' fallback to request_seconds
        if "request_seconds" not in meta and "seconds" in meta:
            val = meta.get("seconds")
            if isinstance(val, (int, float)):
                if val == val and val != float("inf") and val != float("-inf") and val >= 0:
                    timings["request_seconds"].append(val)
                    legacy_seen = True

        # Use terminal exit_code file as actual evidence
        ec_file = rd / "exit_code"
        ec_value = None
        if ec_file.is_file():
            try:
                ec_value = ec_file.read_text(encoding="utf-8").strip()
            except OSError:
                pass

        status = meta.get("status")

        # Determine classification
        if ec_value is None:
            unresolved += 1
        else:
            try:
                ec_int = int(ec_value)
            except ValueError:
                unresolved += 1
                continue
            if ec_int == 0:
                validation_path = rd / "validation.json"
                if validation_path.is_file():
                    try:
                        v = json.loads(validation_path.read_text(encoding="utf-8"))
                        if v.get("status") == "incomplete" or v.get("incomplete_seen"):
                            incomplete += 1
                    except (OSError, json.JSONDecodeError):
                        pass
            elif ec_int == 4:
                incomplete += 1
            elif ec_int == 130:
                cancelled += 1
            elif ec_int == 1:
                failures += 1
            else:
                if status == "cancelled":
                    cancelled += 1
                else:
                    failures += 1

    def fmt_timing(vals):
        if not vals:
            return "unknown"
        total_val = sum(vals)
        min_val = min(vals)
        max_val = max(vals)
        return f"sum={total_val:.1f} min={min_val:.1f} max={max_val:.1f}"

    lines = []
    lines.append("# Jarvis Request Summary\n")
    lines.append(f"- Total request directories: {total}")
    lines.append(f"- POST attempts (known): {post_attempts_known}")
    if post_attempts_unknown > 0:
        lines.append(f"- POST attempts (unknown/legacy): {post_attempts_unknown}")
    lines.append(f"- Unique model roots: {len(model_roots)}")
    if model_roots:
        for mr in sorted(model_roots):
            lines.append(f"  - {mr}")
    lines.append(f"- Queue seconds: {fmt_timing(timings['queue_seconds'])}")
    lines.append(f"- Probe seconds: {fmt_timing(timings['probe_seconds'])}")
    lines.append(f"- Request seconds: {fmt_timing(timings['request_seconds'])}")
    lines.append(f"- Total seconds: {fmt_timing(timings['total_seconds'])}")
    lines.append(f"- Incomplete: {incomplete}")
    lines.append(f"- Failures: {failures}")
    lines.append(f"- Cancelled: {cancelled}")
    lines.append(f"- Unresolved (no exit_code): {unresolved}")
    lines.append(f"- Malformed: {malformed}")
    if legacy_seen:
        lines.append("- Legacy seconds treated as request time; queue/probe remain unknown")

    # Collect hand_edits from validation.json files automatically
    auto_hand_edits = []
    for rd in request_dirs:
        validation_path = rd / "validation.json"
        if validation_path.is_file():
            try:
                v = json.loads(validation_path.read_text(encoding="utf-8"))
                for he in v.get("hand_edits", []):
                    if he not in auto_hand_edits:
                        auto_hand_edits.append(he)
            except (OSError, json.JSONDecodeError):
                pass
    # Merge with explicit hand_edits (dedup)
    all_hand_edits = list(hand_edits)
    for he in auto_hand_edits:
        if he not in all_hand_edits:
            all_hand_edits.append(he)
    hand_edits = all_hand_edits

    if hand_edits:
        lines.append(f"\n## Hand Edits ({len(hand_edits)})\n")
        for he in hand_edits:
            if isinstance(he, dict):
                lines.append(f"- {he.get('file', '?')}: {he.get('reason', 'no reason')}")
            else:
                lines.append(f"- {he}")

    lines.append("\n> Note: A valid syntax parser cannot prove semantic completeness.")
    lines.append("> Review and full gates (typecheck, tests) are required.")

    print("\n".join(lines))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(EXIT_REJECT)


def main():
    parser = argparse.ArgumentParser(description="Jarvis packet tooling")
    sub = parser.add_subparsers(dest="command")

    p_build = sub.add_parser("build")
    p_build.add_argument("manifest")
    p_build.add_argument("packet_dir")
    p_build.add_argument("--repo", required=True)

    p_check = sub.add_parser("check")
    p_check.add_argument("snapshot")
    p_check.add_argument("--repo", required=True)

    p_stage = sub.add_parser("stage")
    p_stage.add_argument("request_dir")
    p_stage.add_argument("stage_dir")
    p_stage.add_argument("--repo", required=True)
    p_stage.add_argument("--repair-envelope", action="store_true", default=False)

    p_apply = sub.add_parser("apply")
    p_apply.add_argument("stage_dir")
    p_apply.add_argument("--repo", required=True)

    p_summary = sub.add_parser("summary")
    p_summary.add_argument("request_dirs", nargs="+")
    p_summary.add_argument("--hand-edits", default=None)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        if args.command == "build":
            cmd_build(args)
        elif args.command == "check":
            cmd_check(args)
        elif args.command == "stage":
            cmd_stage(args)
        elif args.command == "apply":
            cmd_apply(args)
        elif args.command == "summary":
            cmd_summary(args)
    except SystemExit:
        raise
    except (OSError, UnicodeDecodeError, ValueError, KeyError, TypeError) as e:
        # Expected rejections from malformed CLI inputs
        fail(str(e))
    except Exception:
        # Unexpected errors get a traceback (these are bugs, not rejections)
        raise


if __name__ == "__main__":
    main()
