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

Integration review found that pending chat needed teardown before report analysis:
the existing action parser logs validation errors before its ended guard. The
report end handler now aborts chat and health requests before taking its snapshot.
The initial browser proof also assumed title casing in visible text; CSS renders
section headings in uppercase. The proof now checks visible labels without
depending on casing, preserving the original failed log.

Normal-damage delegated browser play with seed 123 confirmed the existing M5
balancing nuance: S-07 was engaged before launch, but the gun missed. Report
lessons must distinguish timely engagement from successful neutralization and
must not imply the player waited when a recorded engagement proves otherwise.

Screenshot review caught a CSS inheritance defect that functional browser checks
did not detect: the game's global muted paragraph rule overrode the report's
intended text color. A scoped report rule restores readable contrast. Keep visual
review alongside behavioral proofs for new overlays, including a narrow viewport.

Final combined staging verification passed 175 tooling tests, typecheck, 682
application tests across 50 files, and the production build. Chromium verified
natural completion, normal-damage early ship loss, frozen controls, new-seed
replay, doctrine attribution, successful and failed debrief streams, a 390 px
viewport, and cancellation of pending chat at scenario end, with no page errors.
Debrief browser checks use controlled SSE responses; live model prose was not
part of these deterministic proofs. Implementation and complete-file hashes,
native session IDs, retained failed checks, repair decisions, and final logs are
stored in the external evidence directory above.

## Milestone 7 implementation observations

Started 2026-11-10. Scope: #19 (headless strategy playtests and balance) and
#20 (briefing and UX polish). Implementation uses native `gpt-6.1-terra`
subagents in isolated staging copies, per the explicit model override. Evidence:
`/var/home/qyfs/.codex/task-evidence/drone-m7-20261110/`.

| Area | Observation | Proposed improvement |
| --- | --- | --- |
| Codex | The required `development-evidence` skill is still absent at its configured path. The M6 task record supplies an equivalent scope, interface, execution, and repair format. | Validate required skill paths before advertising them; retain the existing evidence owner while repairing availability. |
| Codex | Broad skill/tool discovery and combined source reads exceeded the output guard; the full captures and terminal verdicts were retained. | Limit discovery to likely skill roots and requested tool names; read source files in bounded chunks. |
| DroneDelegation | The tooling owner still specifies Jarvis authorship and historical feature exclusions; this request explicitly selects Terra for M7. | Keep task-specific authorship and scope separate from stable execution rules, and record explicit overrides in task evidence. |

The GitHub issue search returned useful issue bodies but null state/milestone
fields. A native `gh api` read confirmed canonical milestone #7 and open issues
#19/#20; those snapshots are retained. A quoted JavaScript browser-harness
heredoc also triggered the shell-background detection notice despite running
no background workload. Narrow metadata tools and shell-aware guard parsing
would reduce these fallback inspections and false diagnostics.

The initial 20-seed M7 strategy run exposed a balance defect hidden by the
earlier seed-123 timing checks: full delegation stopped S-7 before launch in
only 7/20 runs; a single gun burst at Pk 0.35 explains the weak benefit.
Verification must report both timely decisions and physical outcomes, with
normal damage and real early termination. Scenario-specific tuning keeps the
shared weapon defaults and seeded randomness intact. The original measurements
are retained beside the final distributions rather than overwritten.

Combined UX staging passed the existing full verification gate. Chromium
verified a zero-time briefing, range keys, a full offline watch, frozen end
controls and new-seed replay at 1280×720. Screenshots were reviewed visually.
The additional interaction fixture initially selected S-03 at 6 nm while
expecting an out-of-range gun action; source inspection classified that as a
fixture error, and the proof now selects S-01 at 12 nm with its assertions
unchanged. Live accessible-reason updates also need to preserve button focus;
the UX implementation restores focus when refreshing an action.

The requested cosmetic spawn/sweep follow-up was evaluated without changing
the simulation order. Air contacts spawn between four-second radar sweeps, so
merely swapping runner/world calls does not guarantee immediate detection.
Keep the established sensor cadence and measured detection times until a
separate sensor-timing change supplies consistent headless and browser proof.

Final combined M7 staging passed 175 tooling tests, both TypeScript projects,
690 application tests across 53 files, and the production build. Chromium
confirmed briefing/start/replay, range and chat shortcuts, editable-field guards,
keyboard-readable disabled reasons, actual missile ETA and visual alerts, FLASH
audio oscillator activation after a user gesture, and live hull damage. No page
errors were recorded at 1280×720. Screenshot review confirmed readable briefing
text and separated fleet labels. Native IDs, final file hashes, baseline and
tuned outcome distributions, retained failures and repair decisions are in the
M7 evidence directory. The browser checks use controlled AI health responses;
live model prose is outside these deterministic proofs.

## Playtesting follow-up observations (M8)

Scope: issues #50–#58 and the user's subsequent design decisions. Native
`gpt-6.1-sol` agents handled the initial independent fixes; `gpt-6-luna`
agents explored and implemented the remaining decisions in isolated staging
copies. These are additional tooling proposals from that work, not tooling
features implemented by it. Earlier missing-skill observations are historical:
`development-evidence` is available at its canonical path at this review.

| Priority | Owner | Observation | Proposed improvement |
| --- | --- | --- | --- |
| High | DroneDelegation | Aircraft and combat work passed focused checks independently, but combining the faster attacker with MANUAL point defense changed careful-player damage from 2/20 in the combat agent's baseline to 19/20. Its scripted player still assumed automatic defense, and the faster attacker could launch before a SAM arrived. | Add a scenario interaction matrix covering aircraft motion, weapon travel time, defense defaults, sensor timing, and scripted strategies. Recheck combined inputs with normal damage and actual early termination; require explicit player actions in strategy fixtures and classify changed expectations before repair. |
| High | DroneDelegation | The first four-phase missile test launched every missile before advancing the supposed launch phase. It measured the same physical window four times while reporting different delays. | Build timing fixtures that advance to the chosen sweep phase before launch and measure first detection and actual impact events. Retain event timelines and check phase coverage, prompt responses, and delayed responses. The repaired fixture measured 2.2–5.2 seconds; a five-second response failed in three of four samples. |
| High | DroneDelegation | A live Jarvis reply claimed it was setting point defense to AUTO and emitted that action, but autonomous policy correctly permitted only the engagement. The smoke test passed because a SAM fired and no parse notice appeared. | Extend the existing live compatibility probe to reconcile every proposed action with policy, command results, and resulting state. Verify that skipped/advice-only actions cannot be mistaken for successful execution; surface their disposition without expanding authority. A successful reply or one successful weapon action is insufficient evidence for the other claims. |
| High | DroneDelegation | Larger text left the briefing introduction scrolled out of view because initial focus went to the start button. Separately, urgent-alert code scrolled an inner list while CSS made its parent the actual scroll owner. | Extend the existing browser smoke harness with visible geometry and scroll-position assertions: introduction starts visible, newest urgent alert remains visible after overflow, tabs/unread counts work, and Standard/Large text and canvas labels resize and persist at 1280×720. Review screenshots as well as DOM presence. |
| Medium | development-evidence | The aircraft and combat agents, plus the integration owner, needed different parts of `strait.ts`: aircraft data, combat configuration, and scripted report wording. Applying either complete file wholesale would have discarded other accepted changes. | Record one final integration owner for a shared file and explicit section contracts for staged proposals. Validate base hashes and owned differences before merging, then validate the complete combined file. Extend existing staging/evidence tooling rather than introducing a second workflow. |
| Medium | Codex | A fourth native-agent spawn was rejected by the thread limit; an agent that had completed its first task was reused for the queued investigation. | Expose remaining agent capacity and support queued tasks on authorized agents. Keep task-specific model selection, ownership, and completion evidence when reusing a worker; do not duplicate in-flight work after a capacity rejection. |
| Medium | development-evidence | Task records, retained failures, live-model replies, browser proofs, and the final verification log remain under temporary execution directories. | Add durable evidence finalization to the existing evidence scripts: archive selected records/logs/artifacts with hashes and original native IDs, preserving execution paths while checking archived references. Exclude dependency caches and browser profiles. Until archived, label these paths as temporary evidence. |

The first direct-upstream smoke attempt also omitted the production proxy's
leading-system-message normalization and received HTTP 400. That was a harness
defect, not a new product regression. Reusing the existing normalization fixed
the probe. This supplies further evidence for the M4 proposal to exercise the
actual production message path rather than maintaining a separate approximation.

Final local verification passed 175 tooling tests, both TypeScript projects,
727 application tests across 59 files, and the production build (native session
`87824`, exit `0`). Chromium checked role routing, unread counts, keyboard
navigation, contact selection, urgent overflow, briefing visibility, saved text
sizes, and canvas font sizes. A separate live model probe executed an engagement
for a matching approach vector despite different altitude and speed; it did not
establish that every action claimed in the model's prose executed.

Temporary evidence, not a durable archive:

- `/tmp/drone-playtest-eg0jjebn/task-record.json` — initial independent fixes.
- `/tmp/drone-design-quakq2t8/task-record.json` — design decisions, staging,
  integration repairs, native IDs, and applied-file hashes.
- `/tmp/drone-design-quakq2t8/verify.log` — final repository gates.
- `/tmp/drone-design-quakq2t8/browser-result.json`, `layout-standard.png`, and
  `layout-large.png` — browser assertions and reviewed screenshots.
- `/tmp/drone-design-quakq2t8/live-request.json`, `live-reply.json`, and
  `live-summary.json` — live-model input, response, and observed execution.

## Codex-slimming dispositions before M9 implementation

Reviewed 2026-11-10 (America/New_York; 2026-11-11 UTC). The historical
observations above remain intact. These dispositions describe that review;
the subsequent M9 implementation is recorded below. Unrelated DroneDelegation
feature and balance proposals remain separate work.

| Proposals | Current disposition |
| --- | --- |
| Missing skill and evidence records | The canonical `development-evidence` skill and its alias are healthy; only the dangling `agent-claude` alias was removed. Evidence machinery is optional; native logs and a brief existing task note suffice when useful. The user accepted current startup skill availability behavior; no startup validator was added. |
| Complete-file envelopes and output/reasoning budgets | Native artifacts and diffs are the default. The generic `complete_files.py` fallback is retained for small external tasks, separately from this repository's optional Jarvis packet/caller transport. Both retain their existing contracts. No automatic estimator or schema service was added. |
| Interface and shared-file ownership | Agree interfaces and ownership before authorized parallel work, then review native artifacts and owned diffs before coordinated shared-file integration. This is procedure, not automation; no automatic contract injection was added. |
| Output capture and permanent evidence | The Codex output hook and its stale trust entry were removed. Shared-guard documentation now describes current Claude-only wiring and the intentional dual-client installer; guard code and Claude configuration were unchanged. Native limits remain; the user declined permanent archive machinery. Historical temporary evidence remains labeled temporary. |
| Native waiting and instruction volume | Wait instructions were compacted and the duplicate hint removed; existing native 45–50-second settings remain. Minimal AGENTS instructions were adopted. High reasoning remains the user's preference, not an original backlog issue. |
| Native agent capacity | The user accepted current Codex agent-capacity behavior. No custom scheduler or capacity API was added. |
| Review anchors, async lifecycle, and temporal fixtures | These are now repository task-specific practices in `docs/TOOLING.md`: supplied dates and checked source anchors, relevant lifecycle failures, and phase/event-time observations with useful traces. This is documentation, not new automation. Earlier concrete application bugs were already fixed and were not re-tested by this docs change. |
| Shell initialization | Initial tool probes were clean, but `TERM=dumb bash -lc 'printf "%s\n" noninteractive-login-ok'` reproduced two Starship errors and terminal control sequences despite exit `0`; the corresponding `bash -c` probe was clean. Both distribution-managed prompt initialization and user setup contribute. An in-memory guard of user initialization still left a system-profile error, so the candidate was rejected and no live shell files changed. Prefer `login: false` when login setup is unnecessary. The robust host fix remains pending in [#61](https://github.com/MCancian/DroneDelegation/issues/61) and requires coordinated host-owner work. |
| Historical repository restrictions | The guide now uses the current user/task's authoring model and scope. Blanket authorship and feature exclusions from completed [#36](https://github.com/MCancian/DroneDelegation/issues/36) were removed from ongoing rules; optional Jarvis executable contracts remain intact. |

That review left three implementations tracked in
[M9 Tooling Reliability](https://github.com/MCancian/DroneDelegation/milestone/9):

- [#59 — Add read-only milestone and checkout preflight](https://github.com/MCancian/DroneDelegation/issues/59).
- [#60 — Add maintained browser smoke checks with prompt failure diagnostics](https://github.com/MCancian/DroneDelegation/issues/60).
- [#61 — Fix noninteractive login-shell prompt initialization on the development host](https://github.com/MCancian/DroneDelegation/issues/61).

That review changed policy and documentation only and claimed no application
gates. The implementation below addresses exactly those three M9 items, using
the user's subsequent design decisions.

## M9 tooling reliability implementation

Implemented locally on 2026-11-11 against HEAD `f17edf9`, including the existing
dirty working-tree inputs. Three `gpt-6.1-sol` leads each used one
`gpt-6-luna` exploratory reviewer. Work was staged separately with agreed file
ownership; the integration owner reviewed native artifacts, owned differences,
and screenshots before application. Existing gameplay changes were preserved.

| Item | Implementation and checks |
| --- | --- |
| #59: informational preflight | `scripts/milestone_status.py` uses authenticated native `gh` queries and read-only Git inspection. Human/JSON output keeps issue closure, explicit PR links, merge state, checkout inclusion, and unverified acceptance separate. Fifteen hermetic tests cover lookup, pagination/partial failures, missing metadata, dirty trees, and complete/shallow histories. Live probes correctly report M9's three open issues and M3's two closed issues with merged PRs #31/#32 included in HEAD. Findings are informational; lookup/transport errors fail while retaining partial results. |
| #60: deterministic browser smoke | `npm run smoke` builds the app and a cache-only production-component fixture, then runs five Chromium checks. The real proxy handles a fake upstream's success, immediate 503, cancellation, and post-cancel recovery. Standard/Large geometry, radar/report selection, manual command results, unread/overflow behavior, and native audio activation after a trusted gesture are checked. Screenshots were reviewed. A separate CI job runs on every PR and main push; ordinary report/results artifacts expire after seven days. |
| #61: local host repair | Interactive guards were applied to the user's Bling/VS Code setup. The user applied the reviewed root-owned Starship profile guard with exact-hash checks and a root-only backup. Final verification passes all eight noninteractive variants with exact marker-only stdout and empty stderr, four unchanged PATH/tool-resolution comparisons, and four unchanged interactive terminal variants. No immutable `/usr/share` files were changed. |

The browser suite asserts geometry rather than pixel baselines. Its crew
component checks are identified separately from full-app integration checks.
Native audio activation does not prove speaker audibility, and deterministic
responses do not establish live-model quality. The milestone command never
fetches, runs checks, changes GitHub state, or concludes acceptance from closure.

The stable procedures and commands are in `docs/TOOLING.md`. Final repository
verification uses `bash scripts/node22.sh npm run verify`, followed separately
by `bash scripts/node22.sh npm run smoke` on the integrated checkout. The initial
local implementation left GitHub issue/milestone state unchanged; publication
and remote CI results are separate from those local checks.

Publication review also reproduced and repaired three regressions in the
preceding gameplay changes: the AAR missed the revised affirmative visual-ID
wording; a scripted uncertainty report could contradict an earlier visual ID;
and an unsolicited crew report replaced a focused report button. Producer-to-AAR
and maneuvered-scenario checks now retain the observed identification, while
Standard/Large browser checks preserve report focus and Enter selection during
updates. The failing reproductions were retained before repair, alongside the
focused passing checks. These repairs preserve the approved gameplay design.

Temporary execution evidence, not a durable archive:
`/tmp/drone-m9-52xc6ycb/` contains the brief task record, staged native results,
live preflight JSON, final `verify.log` and `smoke.log`, and `host-final.log`.
The private host backup contains user configuration and must not be printed or
attached. The reviewed system rollback preserves the original file's owner,
mode, and SELinux context. The local `/etc` override needs review if Bluefin
updates its owner.
