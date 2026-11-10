# Tooling improvements observed during milestone 3 verification

Date: 2026-11-10. Baseline: `7be09a0`.

Milestone 3's issues #9 and #10 are already closed and merged. This run checks
their acceptance criteria with Jarvis audits and the repository verification
suite. The entries below are proposals, not changes implemented by this run.

## Codex generally

| Priority | Observation | Proposed improvement |
| --- | --- | --- |
| High | Global instructions require `development-evidence`, but its canonical directory is absent and the alternate skill alias is dangling. | Validate required skills and their symlink targets at session startup; report missing owners once with a concrete repair path. |
| Medium | Milestone 3 is still marked open even though all its issues are closed and implementation is merged. | Provide a task preflight that compares the requested milestone, issue states, checkout HEAD, and merged work before planning implementation. |
| Medium | Command output has a separate byte budget that can truncate below the requested token budget. | Expose the effective capture budget before launch and return structured truncation metadata with bounded follow-up reads. |
| High | Both Jarvis responses violated the requested complete-file envelope. One omitted the final newline; the other also omitted delimiter suffixes. | Offer schema-constrained file responses with deterministic serialization, preserving strict validation, original bytes, and explicit repair records. |
| Medium | Static reviews supplied inaccurate line references and one invented audit date. | Give reviewers structured source anchors and a supplied run date; validate references before presenting a review as evidence. |

## DroneDelegation specifically

| Priority | Observation | Proposed improvement |
| --- | --- | --- |
| High | Jarvis packet dependencies are manually selected; two M3 audits require repeated manifest setup and shared source lists. | Add a reviewed acceptance-audit manifest preset per milestone, retaining explicit dependencies and snapshot checks. |
| Medium | `docs/TOOLING.md` contains a completed tooling task's scope restriction alongside enduring procedures. | Move historical scope exclusions into that task's evidence record and make the current authorization the explicit scope input. |
| Medium | The roadmap points only to GitHub milestones, whose open state does not establish whether work remains. | Add a milestone status command that reports open issues and merged acceptance evidence without changing GitHub state automatically. |
| High | Command and crew behavior have pure tests, but feed scrolling, contact selection, and FLASH audio were checked only by source review in this run. | Add a browser smoke harness for selecting a track, submitting a command, clicking a crew report, and unlocking FLASH audio with a user gesture. |
| Medium | Independent audits needed separate snapshot packets, native session records, stage verdicts, and a manually combined summary. | Add an audit-only batch command with explicit file ownership, shared source snapshots, native session evidence, and a combined report; keep staging separate from repository application. |
| Medium | A proposed review fix would restrict visual ETA messages to explicitly small craft, although the spec does not prohibit reports for other closing vessels. | Require a minimal reproduction and a cited requirement for proposed repairs; distinguish defects from coverage suggestions and optional refinements. |

## Milestone 3 result

Milestone 3 was already implemented on the baseline checkout: issues
[#10](https://github.com/MCancian/DroneDelegation/issues/10) and
[#9](https://github.com/MCancian/DroneDelegation/issues/9) were closed through
PRs #31 and #32, followed by the terminal catch-up and crew-update fix in #33.
The GitHub milestone remains open with zero open issues. This run did not
change its state.

| Area | Evidence | Result |
| --- | --- | --- |
| Command validation, attribution, responses, A-9 radio range | Jarvis static review; `commands` and `commandResponses` tests | Acceptance behavior implemented; no concrete defect found. |
| Crew stations, priorities, triggers, sensor timing, duplicate suppression | Jarvis static review; `crew`, `crewEdges`, `crewTransitions`, and `crewScenario` tests | Acceptance behavior implemented; no concrete defect found. |
| Manual controls, feed rendering, track selection, FLASH audio | Source review of `main.ts`, `commandControls.ts`, `contactPanel.ts`, and `crewFeed.ts` | Wiring present; browser interaction and audio not exercised. |
| Repository gates | `bash scripts/node22.sh npm run verify`, native session `22929`, exit `0` | 175 tooling tests; typecheck; 470 Vitest tests across 29 files; production build passed. |

No gameplay or tooling implementation changes were justified by the review.
Suggestions for more tests remain proposals. The point-defense toggle command
is consistent with the explicit UI requirement, despite not having its own row
in the design's command table.

## Execution evidence

- Durable local evidence archive:
  `/var/home/qyfs/.codex/task-evidence/drone-m3-20261110/`.
  It contains scope, ownership, issue inputs, native session IDs, raw model
  replies, validation records, gate logs, and repair decisions. Snapshot paths
  preserve their original `/tmp/drone-m3-20261110/` execution locations.
- Jarvis used the served `jarvis` model, probed as
  `/models/Qwen3.8-Flash-Next-NVFP4`, with low effort and machine-wide slot locks.
  Commands: native session `31488`, exit `0`; crew: session `79865`, exit `0`.
  Two POST attempts total; combined request time approximately 258 seconds.
- Crew response: strict stage rejected a missing final LF (exit `7`). The
  supported `--repair-envelope` operation appended exactly one LF; staging
  then passed (exit `0`). The repair record retains both content hashes.
- Commands response: strict stage rejected the envelope (exit `7`); the
  supported newline repair also rejected malformed FILE/END FILE delimiters
  (exit `7`). It was retained only as an unvalidated static review. Its claimed
  date and line numbers were not adopted as evidence.
- No delegated complete files were applied. Raw replies and metadata were
  preserved; neither source nor test assertions were modified.
- The missing `development-evidence` skill was not reconstructed. Compact
  evidence was recorded explicitly for this run.

## Milestone 4 implementation observations

Started 2026-11-10 from `7be09a0`. Scope: issues #34, #11, #12, and #13.
Jarvis authors the implementation in separate issue branches; Codex coordinates
interfaces, staged validation, review, local gates, and CI before merging.
Evidence: `/var/home/qyfs/.codex/task-evidence/drone-m4-20261110/`.

| Area | Observation | Proposed improvement |
| --- | --- | --- |
| Codex | Required skill references can remain active after the owning skill directory is removed. | Surface missing required skills as a session capability error with an existing-evidence fallback when authorized. |
| Codex | Independent issue branches need coordinated interfaces before full-file generation. | Persist a small interface/ownership record and include it automatically in each delegated task. |
| DroneDelegation | Snapshot checks include the entire Git file listing, so applying one task's new files can stale another task's packet in the same checkout. | Use isolated issue worktrees and expose snapshot conflict reasons before launching a batch. |
| DroneDelegation | Tests for production slot locks must not contend with the model-authoring requests. | Keep temporary lock directories explicit in hermetic tests, and reserve shared XDG locks for actual Jarvis calls. |
| Codex | A nine-file full-response task exceeded its 32,768-token completion budget; reasoning consumed 8,896 tokens and the final test file was truncated. | Budget output and reasoning separately, estimate complete-file response size, and split large packets before launch. |
| DroneDelegation | A test selected its skipped/not-skipped function before its asynchronous availability hook ran, so all lock tests skipped on a host with `flock`. | Detect suite prerequisites before test registration and report unexpected skipped acceptance tests as unresolved. |
| DroneDelegation | An SSE multiline fixture inserted a literal newline inside a JSON string and expected successful parsing. | Validate generated protocol fixtures independently; split valid JSON between tokens and keep malformed payload cases explicit. |
| Codex | A caught synchronous cancellation call still left an asynchronous reader cancellation rejection unhandled. | Include stream teardown and unhandled-rejection checks in delegated async lifecycle reviews. |

Implementation and verification results will be appended as work completes.

- #11: [PR #38](https://github.com/MCancian/DroneDelegation/pull/38) merged
  after local full gates and green CI. Live proxy check streamed a completed
  reply in 4.463 seconds with no reasoning fields.
- #12: [PR #39](https://github.com/MCancian/DroneDelegation/pull/39) merged
  after local full gates and green CI. Chromium against live Jarvis confirmed
  online status, Enter submission, a completed reply, and no page errors.
- #34: projection tests exposed an existing-behavior regression: available
  `SensorInfo.visual` updates were discarded when no latched visual ID existed.
  Restoring that safe fallback preserves observed updates while still excluding
  hidden `visualDescription`. Detection fixtures were also made deterministic.
  [PR #40](https://github.com/MCancian/DroneDelegation/pull/40) merged after local
  full gates (482 application tests) and green CI.
- #13: prompt/serializer/parser and game wiring are delegated separately against
  agreed interfaces. Owned empty output paths were reserved before snapshots,
  preserving listing stability while keeping independent file hashes enforced.

Further observations from #13:

| Area | Observation | Proposed improvement |
| --- | --- | --- |
| DroneDelegation | Physical contact IDs and assigned display track IDs are separate; duplicating physical labels did not create the ambiguous sensor IDs a test intended. | Extend existing simulation fixture helpers with explicit observed-track lookup and ambiguity setup. |
| Codex | A test mistook the attacker's original 045-degree spawn bearing for its launch bearing after both vessels moved. | Derive temporal expectations from independent public observations at the relevant event, and retain the supporting trace before changing assertions. |
| DroneDelegation | Banning `212` as an arbitrary JSON substring rejected legitimate position digits. | Check exact excluded fields and sensor identification text, with poisoned hidden-data invariance tests, rather than scanning unrelated numeric substrings. |
| DroneDelegation | Launch-profile history needs the observed profile, launch event time, and the ship's reference position captured together. | Add a small observed-event fixture for delayed detection and own-ship maneuvering; use it for future doctrine tests. |

#13's 50 focused tests and typecheck pass. The combined branch includes all
three merged prerequisites and passes full Node 22 verification: 175 tooling
tests, typecheck, 621 application tests across 39 files, and production build.
Chromium confirms that advice cards do not execute, direct chaff and maneuver
orders change game state, cancellation aborts upstream without executing, and
offline chat leaves the simulation advancing. No page errors were observed.

The initial 15 Jarvis POSTs used one served model root and approximately 2,789
seconds of cumulative request time, with parallel work reducing elapsed time.
All raw replies omitted the terminal LF; the request summary retains those
initial incomplete verdicts even for subsequently repaired envelopes. One
over-budget reply and malformed delimiters were rejected rather than applied.
The final implementation came from validated replacement requests and recorded
mechanical repairs. A clearer summary should distinguish raw-response defects,
successful supported envelope repairs, and final unresolved work.

The final live direct-order check found a compatibility defect that mocks had
missed: the served model rejects consecutive leading system messages with
`System message must be at the beginning.` The browser correctly sent the
required prompt and situation as separate system messages. A proxy compatibility
repair combines only the adjacent leading system messages for the upstream
template, preserving both contents and conversation order. This requires fresh
verification on the changed server inputs.

| Area | Observation | Proposed improvement |
| --- | --- | --- |
| DroneDelegation | Proxy-only and UI-only live probes passed, but the full prompt/situation payload failed the served model's template. | Maintain a small live compatibility probe using the actual complete message structure, plus a hermetic mock of discovered template constraints. |
| Codex | A browser proof waited only for a completed reply and masked an immediate upstream error until its timeout. | Race success and visible error outcomes and capture request, error text, and screenshot before teardown. |

After the compatibility repair, the deterministic Chromium proof passes again,
including the browser/upstream message-boundary checks. The live Chromium
direct-order proof also passes: Jarvis replies with a chaff action, inventory
falls from six loads to five, and chat reports `Executed: chaff`. No page errors
were observed. The compatibility mock's captured-request accessor checks its
runtime shape before returning typed messages; no assertion was weakened to
satisfy TypeScript.

Final local verification on the repaired inputs passed: 175 tooling tests,
typecheck, 625 application tests across 40 files, and production build. The full
run used 16 Jarvis POSTs and approximately 2,854 seconds of cumulative request
time. Final CI and merge outcomes are retained in the external task record.

## Milestone 5 implementation observations

Started 2026-11-10 from `f2cd859`. Scope: issues #14, #15, #16.
Implementation is delegated to native `gpt-6.1-terra` subagents in isolated
staging copies with agreed interfaces and file ownership. The game's existing
Jarvis runtime remains unchanged. Evidence:
`/var/home/qyfs/.codex/task-evidence/drone-m5-20261110/`.

| Area | Observation | Proposed improvement |
| --- | --- | --- |
| Codex | The required `development-evidence` skill is still missing, and its alternate `.agents/skills` symlink is dangling. Existing milestone records provide an equivalent compact evidence format. | Validate required skill owners at startup and offer explicit reuse of existing evidence records without reconstructing missing skills. |
| Codex | Native command output has a separate byte guard; combining large source reads can truncate even with a generous token limit. | Show the effective byte budget and encourage bounded source reads; preserve the guard's capture path and terminal verdict. |
| DroneDelegation | Milestone #16 suggests SAM fire at surface targets beyond 9 nm, while the authoritative command table defines SAMs for air and missiles. | Resolve rule and weapon-domain conflicts in the design owner before extending command capabilities; retain current command validation. |
| DroneDelegation | `scripts/node22.sh` intentionally resets cwd to the live repository, so invoking it from an isolated staging copy would verify the wrong source tree. | Add an explicit staging-root option; meanwhile use the verified pinned Node/npm directory on PATH and retain the staging cwd in execution evidence. |
| DroneDelegation | The unchanged tooling cancellation test sent SIGTERM after a fixed 100 ms; under parallel development load it exited `-15` before the caller installed its handlers. The isolated focused rerun passed without code changes. | Wait for the caller's published running metadata before signalling; retain the initial failed gate and require a fresh full gate rather than weakening the expected cancellation verdict. |
| DroneDelegation | The M5 milestone description says delegation “stops S-7,” while §7.4 and #16 explicitly require engagement before launch. Seed 123's pre-launch gun burst can miss with the existing 0.35 hit probability. | Distinguish timely engagement from guaranteed neutralization in acceptance language; keep hit probability and target-proposal dedup unchanged unless balancing is separately authorized. |
| DroneDelegation | A staged tactical implementation initially assumed the action-parser argument order incorrectly; typecheck caught it before application. | Include exact existing exported signatures in delegation contracts, alongside newly agreed interfaces; always typecheck complete staged files. |

A second full run exposed the same fixture class in slot contention: its release
timer started before the subprocess initialized, measuring only 0.05 s of actual
queue time against the unchanged ≥0.1 s expectation. The autonomy Terra agent
repaired these fixtures by synchronizing cancellation and release with caller
readiness using bounded waits, preserving production code and assertions.

Further integration review found that tactical range-entry triggers need both
minimum and maximum weapon envelopes from the actual weapons configuration.
Terra corrected the initial hardcoded upper-range check and added a custom-range
boundary test before application. Browser proof assertions also wait for the
next animation frame's observable state instead of assuming a click immediately
redraws all controls.

GitHub initially reported no checks for the newly opened autonomy PR; the active
workflow registered a run about a minute later. The empty result was retained as
unresolved rather than treated as success. Once a run ID existed, native
`gh run watch --exit-status` followed it to its terminal verdict.

The first autonomy CI run passed tooling and typecheck but exposed an existing
slot-test expectation/cleanup defect. The 200 ms queue deadline can expire in
`tryAcquire`'s confirmation timer, producing its explicit timeout error instead
of `acquireSlot`'s “No slot available” error. The test accepted only the latter;
its failed assertion skipped release of four fixture locks and caused four
subsequent tests to time out. The repair accepts exactly those two existing
deadline errors and releases every test-acquired handle after each test,
including assertion failures. Production slot behavior stays unchanged.
Original CI run: `42840882185`; failed log retained in the task record.

Doctrine acceptance needs counterfactual evidence when a successful intercept
removes the airliner before its civil report can occur. With seed 123, A-9 is
engaged at T+709.0 at 39.9908 nm and destroyed at T+773.9; the same-seed HOLD
trajectory reaches the commercial-emitter report at T+776.6. Tests check both
the observed launch range (>32 nm) and that HOLD reference time rather than
requiring a dead contact to emit a later report. The scenario fixture disables
only inbound missile damage to isolate authority timing; target hit probabilities
remain unchanged. This balancing nuance is retained without changing weapons.

Group departure also needs an explicit observed-data fixture: physical size and
scripted motion are intentionally excluded from sensor tracks. The implementation
records its chosen proximity, movement and freshness thresholds, and tests stale
group peers, answered hails, AIS traffic and access to hidden contact data.

GitHub's runner annotations report that `actions/checkout@v4` and
`actions/setup-node@v4` target deprecated Node 20 action runtimes and are forced
to Node 24. The workflow still explicitly installs Node 22.14.0 for the project.
They also announce the `ubuntu-latest` transition to Ubuntu 26. Review action
runtime upgrades and runner-image choices in the CI owner; avoid conflating the
actions' runtime with the application's pinned Node version.

The repaired autonomy PR [#42](https://github.com/MCancian/DroneDelegation/pull/42)
passed CI and merged. Local verification of the final combined implementation
passed 175 tooling tests, typecheck, 666 application tests across 46 files, and
production build. Chromium verified authority controls, all proposal routes and
countdowns, and normal-damage offline playthroughs with delegated and HOLD
authority. The delegated run reached 15:00, executed both doctrine engagements,
and reported no page errors. The HOLD run made no autonomous requests or
engagements. The temporary Vite proof server was stopped through native session
cancellation after those proofs completed.

The tactical proposal PR
[#43](https://github.com/MCancian/DroneDelegation/pull/43) also passed CI and
merged. Final doctrine checks additionally reject future hostile-act timestamps;
the unit fixture now represents genuinely prior observations and explicitly
checks the event-time boundary before starting the 15-second delay.

## Milestone 6 implementation observations

Started 2026-11-10 from `aa810f8`. Scope: #35 (typed event contracts),
#17 (deterministic after-action report), and #18 (optional AI debrief).
Implementation uses native `gpt-6.1-terra` subagents in isolated staging copies.
Evidence: `/var/home/qyfs/.codex/task-evidence/drone-m6-20261110/`.

| Area | Observation | Proposed improvement |
| --- | --- | --- |
| Codex | The required `development-evidence` skill directory remains absent and the alternate alias still points to that absent directory. | Validate skill availability at startup; reuse the established milestone evidence format while its owner is repaired. |
| Codex | Broad filesystem discovery and combined source reads exceeded the native byte guard even with sufficient token limits. The guard retained the full capture and exit verdict. | Scope discovery to likely skill roots and read individual source ranges within the effective byte budget. |
| DroneDelegation | The milestone display name is `M6 After-Action Report`; a differently formatted milestone filter returned an empty issue list with exit 0. | Resolve milestone numbers and canonical titles before listing work; distinguish an empty match from an empty milestone. |
| DroneDelegation | `docs/TOOLING.md` retains Jarvis-only authoring and historical feature exclusions from the tooling task, while this request explicitly selects Terra. | Separate stable execution rules from task-specific scope and authorship rules in repository documentation; honor the explicit model override. |
| Codex | Native noninteractive commands using login-shell setup emitted Starship `TERM=dumb` warnings and terminal control sequences. | Skip interactive prompt initialization for noninteractive execution; use `login: false` for inspections and gates that do not need login setup. |
| DroneDelegation | Allowing arbitrary event names through the typed producer API lets a widened `string` bypass known-payload checks. | Give custom events an explicit API that rejects known event names; test both compile-time payload errors and runtime impersonation guards. |
