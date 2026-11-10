# Jarvis Tooling

Machine-slot-locked caller, manifest-driven prompt snapshots, staged response validation and application, shared simulation test utilities, and project-local Node 22 verification matching CI.

## Prerequisites

- Linux x86_64 (the `scripts/node22.sh` wrapper enforces this).
- Python 3.8+ (stdlib only; no pip installs).
- `git` and `flock` available on PATH.
- An existing `npm` on PATH for the bootstrap install (the wrapper uses it to fetch the pinned runtime).
- Network access on first bootstrap (downloads pinned Node 22.14.0 and npm 10.9.2 into `.cache/node22/`). Warm runtime launch needs no runtime download; invoked commands such as `npm ci` may need network.
- Other platforms: install Node 22.14.0 and npm 10.9.2 manually and run commands directly. Global Node installation is unchanged; the pin matches CI's explicit `22.14.0`.

## Node 22 wrapper

```bash
bash scripts/node22.sh COMMAND ARGS...
```

Default (no args): `npm run verify`.

The wrapper installs `node-linux-x64@22.14.0` and `npm@10.9.2` into `.cache/node22/` using `--ignore-scripts --no-save --package-lock=false`. It validates exact versions of both the node binary and the npm CLI, exports `PATH` and `JARVIS_NODE`, sets cwd to repo root, then `exec`s the command. Concurrent bootstraps are serialized via `flock`. The cache directory is gitignored.

## Package scripts

| Script | Purpose |
|---|---|
| `npm run tooling:test` | Python unittest discovery in `tests/tooling/` |
| `npm run verify` | `tooling:test` → `typecheck` → `test` → `build` |

## Manifest schema

A manifest is a JSON object with these fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `task` | string | yes | Nonempty task description |
| `allowed_files` | string[] | yes | Relative paths the model may output |
| `contract` | string | yes | Nonempty contract text |
| `dependencies` | string[] | yes | Existing files inlined into prompt |
| `design_sections` | string[] | yes | Exact Markdown headings from `docs/DESIGN.md` |
| `issue_body` | string | yes | Nonempty issue body text |
| `expected_hashes` | object/null | no | `{path: sha256_or_null}` for pre-flight checks |

See `docs/jarvis-manifest.example.json` for a template.

### Inlining rules

- FULL current contents of existing allowed output files AND explicitly listed `dependencies` are inlined into the prompt.
- New outputs (absent on disk) receive a `[NEW FILE]` marker.
- The required dependency list is manual; the tooling cannot infer semantic dependencies.
- Unrelated test/file bodies are excluded from inlining (filenames still appear in the Git listing).
- Copy the example manifest outside the worktree and edit `task`, `allowed_files`, `contract`, `dependencies`, and the FULL real issue body before `build`. No automatic GitHub issue fetch.
- `expected_hashes` keys must be declared paths; values are 64-char lowercase hex sha256 or `null` (for expected-new files).

## Packet lifecycle

### Build

```bash
python3 -B scripts/jarvis_packet.py build MANIFEST PACKET_DIR --repo ROOT
```

- `PACKET_DIR` must be outside `ROOT` and must not exist.
- Outputs: `prompt.md`, `snapshot.json`, `manifest.json`.
- All dependency files are inlined in full. Absent allowed files are recorded as `[NEW FILE]`.
- Design sections are extracted by exact heading match; full `docs/DESIGN.md` hash is recorded.
- Git listing includes tracked and untracked non-gitignored files.
- Token estimate: `ceil(UTF-8 bytes / 4)` heuristic (not tokenizer count).

### Check

```bash
python3 -B scripts/jarvis_packet.py check SNAPSHOT --repo ROOT
```

Validates source hashes, modes, git listing, prompt hash, and checker hash against current repo state.

### Call

```bash
python3 -B scripts/jarvis_call.py PACKET/prompt.md REQUEST_DIR \
  --snapshot PACKET/snapshot.json --repo ROOT \
  [--detach] [--queue-timeout 1200] [--timeout 1200] \
  [--max-tokens 32768] [--temperature 0.2] [--effort low]
```

- `JARVIS_URL` or `--url` default `http://127.0.0.1:8088`.
- Served model ID `jarvis` ONLY; `--effort low` ONLY.
- Acquires one of 4 machine-wide slot flocks (`$XDG_RUNTIME_DIR/revue/jarvis.N.lock`). `--lock-dir` is an explicit override for private tests; production uses the four shared XDG locks and never unlinks them.
- Probes served model root; no self-report or model substitution. No start/stop/restart of the container. No game runtime proxy changes.
- Queue and request timings are separate; request deadline covers probe+HTTP.
- Writes `meta.json`, `content.md`, `reasoning.md`, `reply.json`, `exit_code`, `run.log`.
- Fresh `REQUEST_DIR` refuses reuse (must not exist). Raw legacy `PROMPT_OUT` works but stage/apply requires a linked snapshot.
- `--detach` forks, returns PID immediately. Use `--wait` to poll.
- `--apply` is an unsafe prototype; unsupported as a replacement for stage/apply.

### Native detached waiting (REQUIRED)

Launch with native exec so the session may yield a native session ID:

```bash
python3 -B scripts/jarvis_call.py --wait REQUEST --max-wait 1200
```

Retain PID, native session ID, and `run.log`. Do independent work while the request is in flight.

When the request is the remaining dependency, use a 45 s native `write_stdin` wait in a dedicated `functions.exec` cell:

```javascript
// @exec: {"yield_time_ms": 50000}
text(await tools.write_stdin({session_id: SESSION_ID, chars: "", yield_time_ms: 45000}));
```

If the cell yields, resume that cell with `functions.wait` — do not issue a second wait. The native exec session must reach actual terminal exit. CLI `--max-wait` returning 10 (pending) means just wait the same `REQUEST` again; never duplicate the POST. CLI default `--max-wait` is 45.

Cancel guard: PID + start_ticks identity; SIGINT/TERM yields exit 130. SIGKILL leaves unresolved state; no automatic retry. No monitoring loop instead of native wait.

Tool syntax examples above are agent orchestration documentation, not repo executables.

### Detached workflow

```bash
# Launch
python3 -B scripts/jarvis_call.py prompt.md REQ --snapshot snap.json --repo ROOT --detach
# Wait (exit 10 = still pending; re-invoke same command)
python3 -B scripts/jarvis_call.py --wait REQ --max-wait 1200
# Cancel (SIGTERM, guarded by PID+start_ticks identity)
python3 -B scripts/jarvis_call.py --cancel REQ
```

### Stage

```bash
python3 -B scripts/jarvis_packet.py stage REQUEST_DIR STAGE_DIR --repo ROOT
```

- `STAGE_DIR` must be outside `ROOT` and must not exist.
- Validates meta, snapshot, content hash, reply structure, output protocol delimiters.
- Runs syntax checks using trusted `scripts/ts_syntax.mjs` from current repo.
- Writes `stage_manifest.json`, `files/`, `logs/`.

### Envelope repair

If the model returns a complete response missing only the final LF after `<<<END RESPONSE>>>`:

```bash
python3 -B scripts/jarvis_packet.py stage REQUEST_DIR STAGE_DIR --repo ROOT --repair-envelope
```

This appends exactly one LF byte, writes `response-repair.json` (hashed in stage manifest), and records the operation as a hand edit. Apply rechecks the repair record. Never manually rewrite raw metadata or replies. Default strict mode still rejects.

### Apply

```bash
python3 -B scripts/jarvis_packet.py apply STAGE_DIR --repo ROOT
```

Rechecks all source/request/stage hashes, creates backups, writes files preserving mode. On failure, rolls back. Not crash-atomic; if rollback fails, recovery files remain in `STAGE_DIR/backup/`.

### Summary

```bash
python3 -B scripts/jarvis_packet.py summary REQUEST_DIR... [--hand-edits JSON_FILE]
```

Outputs PR-ready markdown: counts, model roots, timing sums, incomplete/failures/unresolved, hand edits.

## Metadata use

- `meta.json` records: PID, proc_start_time, slot, model_root, post_attempts, finish_reason, usage, and separate queue/probe/request/total seconds.
- Claimed-dir requests record terminal state when the filesystem is writable; invalid CLI args may reject before output creation.
- Actual served root is probe evidence, not self-report.
- Summary reports unknown legacy counters and split timings honestly; `incomplete_seen` is retained after repair and `hand_edit` records are automatically collected from `validation.json`.
- `--repair-envelope` is explicit and appends ONLY one final LF after a complete `<<<END RESPONSE>>>`; no other body changes or metadata rewrites. Raw request checks and repair hash are retained.

## Output protocol

The model must output ONLY the following format. No prose, no fences, no commentary. UTF-8, LF line endings. Each file is wrapped in delimiters at column 0:

    <<<FILE relative/path>>>
    <complete file content ending with LF>
    <<<END FILE relative/path>>>
    ...
    <<<END RESPONSE>>>

(The above is indented four spaces for documentation purposes; actual protocol delimiters appear at column 0 with no leading whitespace.)

- Blank envelope lines between files are allowed.
- Final newline after `<<<END RESPONSE>>>` is mandatory.
- No fences, no prose outside delimiters.
- All allowed files must be present.
- Literal indented Markdown code example ellipsis (`...`) is valid and checked; actual omission markers in code files or unindented docs are rejected.
- The parser cannot prove semantic completeness; review and full gates are required.

## Shared simulation test helpers

Import from `tests/helpers/sim`:

```typescript
import {
  makeContact, makeWorld, worldContact,
  deterministicWeaponsConfig,
  stepWorld, stepWorldWithCrew, stepScenario,
} from './helpers/sim';
```

- `worldContact(world, id)` returns the world-owned reference; mutating it changes the world, not the input object.
- `makeWorld` clones configs; seeded worlds are independent.
- `deterministicWeaponsConfig(0|1)` sets all kill/hit probability fields to exactly 0 or 1; no seed guessing.
- `stepWorld` calls `world.step` only. `stepWorldWithCrew` adds `stepCrew` once per step. `stepScenario` calls `runner.world.step` + `runner.update` (which already includes crew); it caps at remaining scenario duration across repeated calls and stops on `shipLost`.
- Durations must be finite, nonnegative, whole multiples of `STEP_S`. No double crew.
- Existing test migrations are mechanical helper adoption only; preserve all assertions.

## Repair flow

1. Record native IDs and logs externally.
2. Compare fixture/spec/implementation; classify the defect before fixing.
3. Assertion changes require independent evidence.
4. Run a focused repair check, then the FINAL full `npm run verify` (tooling/typecheck/test/build) on final inputs via the wrapper.
5. Changed inputs invalidate earlier gates; no concurrent edits while gates run.
6. CI green is mandatory before merge on the one-issue branch PR.
7. Quote small mechanical hand edits in the PR body with request model roots and timings.

Scope boundary: no `src/`, `server/`, scenario data, `DESIGN`, gameplay, M4, or feature issues #34/#35/#13/#17/#20. Never issue comments. No tools start the container.

## Exit codes (CALLER)

| Code | Meaning |
|---|---|
| 0 | Success |
| 2 | Server down |
| 3 | Model unavailable |
| 4 | Empty/truncated |
| 5 | HTTP/protocol/deadline/artifact error |
| 6 | Queue expired |
| 7 | Invalid/stale inputs (packet expected validation) |
| 10 | Pending (detached, not yet terminal) |
| 130 | Cancelled |

Additional: argparse usage errors exit 2; no-command exits 1; TS syntax checker exits 0/1; the wrapper propagates the invoked command's exit code.

## Limits

- Token estimates are heuristic (`ceil(bytes/4)`), not measured tokenizer usage.
- Dependency completeness is manual; the tooling cannot guarantee semantic dependencies.
- Stage evidence is local trusted records, not cryptographic proof against deliberate forgery.
- Review staged diff before apply. Use `diff --no-index OLD STAGE/files/file` to inspect; do not execute staged code.
- No root symlinks allowed; work from canonical paths.
- All sources are checked for staleness at stage and apply time.
- Staged TS receives syntax check only (no execution); full typecheck is a separate gate.
- Ordinary I/O rollback is not crash-atomic; a recovery path exists in `STAGE_DIR/backup/`.
- Abrupt SIGKILL may leave unresolved state; no automatic retry.

## Authorship

Jarvis authors repository implementation and tooling. Codex orchestrates and quotes small mechanical repairs. One issue → one branch → one PR → CI green → merge. No issue comments.

## Verification

```bash
bash scripts/node22.sh npm ci
bash scripts/node22.sh npm run verify
```

Focused examples:

```bash
bash scripts/node22.sh npm test -- tests/helpers.spec.ts
bash scripts/node22.sh npm run tooling:test
```
