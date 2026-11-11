# Development Tooling

Native editing and diff review, optional external authoring helpers, shared
simulation test utilities, and project-local Node 22 verification matching CI.

## Default workflow

Use native edits and artifacts, review the resulting diff, and run checks relevant
to the change. The current user request selects the authoring model and scope.
Agree interfaces and file ownership before authorized parallel work; a shared
file needs one integration owner to review and combine owned differences.

Evidence skills, external authoring helpers, and archives are optional. Prefer
native logs and a brief existing task note when useful; no permanent archive is
required. The generic `complete_files.py` fallback and this repository's Jarvis
packet/caller transport retain their separate existing contracts when selected.
The completed [#36](https://github.com/MCancian/DroneDelegation/issues/36)
provides historical tooling-task context; its authorship and scope restrictions
do not govern later tasks. Do not issue GitHub issue comments or control the
model container without an explicit user override.

## Task checks

For repository work, select checks relevant to the requested change and current
authorization; these practices do not require a global checklist or new records.

- Before milestone work, resolve its canonical number and title. Distinguish a
  query failure or milestone not found from a successful query returning no
  issues. Check open issues, merged PRs, inclusion of their commits in the current
  checkout, and acceptance evidence separately: none alone proves completion.
  Use the informational milestone preflight below; review acceptance evidence
  separately from its inventory.
- Source reviews use the supplied run date and identify the reviewed revision,
  file, and symbol. Open the claimed references and check that they support the
  finding before presenting them as evidence; line numbers alone can go stale.
- For relevant asynchronous changes, check success, error, cancellation,
  teardown, and unhandled rejections, including failures after a synchronous
  cancellation call returns. Retain useful native results for diagnosing failures.
- Temporal fixtures establish the chosen phase before triggering the event.
  Derive expected values from independent public observations at event time,
  rather than repeating implementation calculations or assuming spawn state is
  still current. Retain a useful event trace before changing an assertion.
- Browser proofs race success against visible error outcomes with bounded waits.
  Inspect the relevant request, error details, and screenshot before teardown;
  a timeout or one successful action does not establish the full interaction.
  The maintained browser smoke command below exercises these outcomes.
- Prefer native non-login commands (`login: false`) when the environment does
  not require login setup. Collect terminal results before rerunning work.

## Milestone preflight

Requires Python 3.8+, Git, and an authenticated GitHub CLI (`gh`). Run from the
checkout to inspect, or supply its path explicitly:

```bash
python3 -B scripts/milestone_status.py --milestone 9
python3 -B scripts/milestone_status.py --milestone 'M9 Tooling Reliability' --checkout /path/to/checkout --repo MCancian/DroneDelegation --json
```

The default checkout is the current Git working tree, resolved to its root. The
repository defaults to that checkout's `origin` remote; supply `--repo OWNER/REPO`
when there is no origin or a different repository is intended. Milestone lookup
uses its number or exact canonical title, including closed milestones. An
unmatched or ambiguous title is an error, distinct from an empty milestone.

Human and JSON output report issue states, explicitly linked implementation
PRs, merge commits, HEAD, dirty state, and local commit inclusion. Generic
mentions are not implementation links. Closure, merge, inclusion, and acceptance
remain separate: acceptance is always unverified by this command. A merged PR
or zero open issues does not establish acceptance; inspect relevant evidence.

Exit `0` means reporting succeeded, even with open issues, dirty files, missing
local commit objects, or unverified acceptance. Missing objects and inconclusive
shallow history produce `unknown`, without fetching. Exit `1` indicates a lookup,
Git, API, or authentication failure; available partial results and bounded
diagnostics remain in the report. JSON goes to stdout, with errors also on
stderr. Invalid command-line arguments use argparse's exit `2`. Native calls
have a 30-second timeout and pagination is bounded.

The command does not change GitHub state, edit the checkout, fetch, execute
checks, or begin implementation. Git optional locking and lazy fetching are
disabled during inspection. It is an informational command, not a readiness
gate or automatic milestone closer.

## Browser smoke

The deterministic smoke suite requires Node 22, Linux `flock` (util-linux), and
Playwright's pinned Chromium. After installing npm dependencies, install the
browser once and run the suite:

```bash
bash scripts/node22.sh npx playwright install chromium
bash scripts/node22.sh npm run smoke
```

On supported Ubuntu CI runners, `npx playwright install --with-deps chromium`
also installs required system libraries. On other hosts, use the available
platform libraries; the current Bluefin host launches Playwright's Ubuntu
fallback browser successfully. Browser installation is separate from `verify`.

`smoke` builds the production app, copies it into `.cache/browser-smoke/site`,
and builds a separate crew component fixture there. It then runs Chromium at
1280×720 with seed 1 and controlled simulation time. Production `dist/` remains
free of the test fixture. Full-app tests and the separate production crew-module
fixture are named distinctly in the report.

The suite covers briefing visibility and start, Standard/Large layout and
persistence, radar/report selection, manual command results, crew roles/unread
counts, urgent scrolling, and chat through the real Node proxy. A local fake
upstream enforces the single-leading-system-message template. Tests require the
combined prompt and situation, execute a direct order, inject an immediate 503,
cancel an unfinished action without executing it, and prove another request can
acquire the released slot. Each request checks expected success against new
visible errors within five seconds rather than waiting for the outer timeout.

Geometry and scroll-position assertions accompany representative screenshots;
there are no pixel baselines. Native AudioContext unlock and oscillator
activation are checked after trusted browser gestures. Physical speaker
audibility and live-model quality are separate manual checks. Routine CI needs
no model server.

The suite owns ephemeral loopback HTTP ports, sockets, and isolated temporary
slot directories. Fixture teardown closes them on success, failure, or
cancellation, even if diagnostic capture fails. Browser page errors and
unhandled promise rejections fail the checks. Use Ctrl-C to cancel the runner
normally. Tests use bounded observable waits and animation-frame advancement.

The list reporter prints each result. Review screenshots, captured requests and
errors, and failure traces under the ignored `.cache/browser-smoke/report/` and
`.cache/browser-smoke/results/` directories, replaced by subsequent runs:

```bash
bash scripts/node22.sh npx playwright show-report .cache/browser-smoke/report
```

Failure summaries, relevant requests/errors, and a screenshot are captured
before HTTP teardown. The separate CI browser job runs on every PR and main
push, installs Chromium/system libraries, and retains report/results artifacts
for seven days. These are ordinary run artifacts; no permanent archive is
required. A passing mocked reply does not establish live-model compatibility or
prove an action beyond the specific disposition and resulting state asserted.

## Local host shell setup

The Bluefin development host initializes Starship in both
`/etc/profile.d/90-bluefin-starship.sh` and the Bling setup sourced by
`~/.bashrc`. VS Code shell integration is also sourced by the user configuration.
Prompt and terminal integration should run only in interactive shells; required
environment setup, including Cargo's environment, stays outside those guards.

The local user repair wraps the Bling source in `if [[ $- == *i* ]]; then ... fi`
and adds the same interactivity condition to both existing VS Code sources.
It preserves the current inherited and minimal-login PATH/tool resolution and
interactive login/non-login integration behavior. Mise is not installed on this
host; if added later, configure required noninteractive tool paths separately
from prompt activation.

Both local repairs were applied and verified on 2026-11-11. The final checks
covered eight noninteractive variants, four environment comparisons, and four
interactive terminal variants, with stable configuration hashes during the run.

The system-profile repair adds this POSIX guard before the existing Starship
initialization, retaining the rest of that file:

```sh
case $- in
    *i*) ;;
    *) return 0 ;;
esac
```

This is an explicit local `/etc` override; review it when Bluefin updates that
file. Do not edit immutable `/usr/share` files or suppress startup stderr.
Back up the original bytes and ownership/mode before applying, and retain a
rollback that restores the existing file without changing its permissions or
SELinux context. The local installer checks exact reviewed input hashes and
keeps a root-only backup at
`/etc/profile.d/90-bluefin-starship.sh.m9-original`, which is not sourced as a
profile script. The system edit requires root; the user repair alone leaves
one system-profile Starship warning in noninteractive login shells.

Regression checks must inspect stdout, stderr, control sequences, and exit code:

```bash
TERM=dumb bash -lc 'printf "%s\n" noninteractive-login-ok'
TERM=dumb bash -c 'printf "%s\n" noninteractive-nonlogin-ok'
```

Both should emit only their marker with empty stderr after both repairs. Also
check `TERM_PROGRAM=vscode`, inherited and minimal environments, named tool
availability, and interactive login/non-login shells in a terminal. Interactive
terminal tests must answer terminal queries and collect/reap the shell process.
Native `login: false` remains appropriate when login setup is unnecessary.

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
| `npm run smoke` | Production build → cached crew fixture → deterministic Chromium checks |

## Manifest schema

This section and the packet lifecycle, metadata, and output protocol below apply
only when using the optional Jarvis transport (`scripts/jarvis_packet.py` and
`scripts/jarvis_call.py`). Its served-model, slot, snapshot, and strict-envelope
requirements remain unchanged.

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

### Native detached waiting

Launch with native exec so the session may yield a native session ID:

```bash
python3 -B scripts/jarvis_call.py --wait REQUEST --max-wait 1200
```

Retain PID, native session ID, and `run.log`; use native waits and collect the
terminal result before rerunning work. Resume the existing wait if it yields,
rather than creating duplicate waiters. CLI `--max-wait` returning 10 (pending)
means wait on the same `REQUEST` again; never duplicate the POST. CLI default
`--max-wait` is 45. Do independent work while the request is in flight.

Cancel guard: PID + start_ticks identity; SIGINT/TERM yields exit 130. SIGKILL leaves unresolved state; no automatic retry. No monitoring loop instead of native wait.

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
- The parser cannot prove semantic completeness; review and the checks required
  for the actual change remain necessary.

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

1. Retain useful native IDs and logs; reuse an existing task note when needed.
2. Compare fixture/spec/implementation; classify the defect before fixing.
3. Assertion changes require independent evidence.
4. Run a focused repair check, then required implementation gates on final inputs:
   full `npm run verify` (tooling/typecheck/test/build) via the wrapper for code
   changes. Docs-only changes need relevant documentation, whitespace, and link
   checks; do not claim application gates that were not run.
5. Changed inputs invalidate earlier gates; no concurrent edits while gates run.
6. CI green is mandatory before merge on the one-issue branch PR.
7. When using Jarvis, retain its raw responses and hash/validation records and
   describe mechanical repairs with request model roots and timings in the PR.

## Jarvis caller exit codes

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

## Jarvis transport limits

- Token estimates are heuristic (`ceil(bytes/4)`), not measured tokenizer usage.
- Dependency completeness is manual; the tooling cannot guarantee semantic dependencies.
- Stage evidence is local trusted records, not cryptographic proof against deliberate forgery.
- Review staged diff before apply. Use `diff --no-index OLD STAGE/files/file` to inspect; do not execute staged code.
- No root symlinks allowed; work from canonical paths.
- All sources are checked for staleness at stage and apply time.
- Staged TS receives syntax check only (no execution); full typecheck is a separate gate.
- Ordinary I/O rollback is not crash-atomic; a recovery path exists in `STAGE_DIR/backup/`.
- Abrupt SIGKILL may leave unresolved state; no automatic retry.

## Verification

For implementation changes, use the pinned runtime and full verification gate:

```bash
bash scripts/node22.sh npm ci
bash scripts/node22.sh npm run verify
```

Focused examples:

```bash
bash scripts/node22.sh npm test -- tests/helpers.spec.ts
bash scripts/node22.sh npm run tooling:test
```
