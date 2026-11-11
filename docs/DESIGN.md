# DroneDelegation — Design Spec (MVP)

A real-time naval command game about **delegating authority to an AI agent**. The player commands a
destroyer for a ~15-minute scenario that cannot be paused. A radar picture, crew reports and an
LLM-backed tactical assistant (the local Jarvis model) feed decisions. The player chooses, per
warfare domain, how much authority the AI holds. An after-action report (AAR) at the end explains how
those autonomy choices shaped the outcome.

The design lesson: delegation beats a slow human against the **low-profile attack boat** (waiting
for visual ID is too late), but the same delegation — following a brittle "match the previous
attacker's approach vector" rule — **shoots down a civilian airliner** that approaches from the same direction despite flying much higher
and slower than the earlier attacker.

This document is the source of truth for issues. Numbers live in data files (`src/sim/scenario/*.ts`)
so balancing does not require code changes.

---

## 1. Decisions (defaults chosen; change here first)

| Topic | Decision |
|---|---|
| Stack | TypeScript, Vite, HTML Canvas 2D for the radar, plain DOM for panels (no UI framework). Vitest for tests. A small Node server (`server/`, built-in `http`, no framework) serves the app and proxies chat to Jarvis. |
| Autonomy | Per domain — **Air** and **Surface** — each with 4 levels (§6). Point defense (CIWS + chaff vs. inbound missiles) is a separate AUTO/MANUAL toggle, default MANUAL. |
| Airliner shootdown under delegation | LLM decides using the biased ROE prompt **plus a deterministic doctrine backstop** (§7.4), so the lesson always lands when Air authority is delegated. |
| Workflow | One branch + PR per issue, PR closes the issue, CI (build + typecheck + tests) must pass, then merge. |
| Determinism | All randomness from a seeded PRNG (`mulberry32`); seed shown in the AAR; `?seed=N` URL param. |
| Dev time scale | `?timescale=N` (dev only; default 1). There is **no pause** — not in UI, not on tab blur. If the tab is hidden, the sim catches up from wall-clock time on return (fixed-step, capped catch-up loop). |

## 2. Architecture

```
server/
  index.ts          Node http server: static files (dist/) + /api/health + /api/chat
  jarvis.ts         Jarvis client: slot lock, request, streaming, timeouts
src/
  main.ts           bootstraps game, wires sim <-> ui <-> ai
  sim/
    types.ts        Contact, Track, Missile, Weapon, Ship, GameEvent, ...
    geo.ts          nm/kts/deg math, bearing/range, position update
    rng.ts          seeded PRNG
    clock.ts        GameClock (unpausable, fixed step 100 ms game time)
    world.ts        World state + step(dt); pure, no DOM
    kinematics.ts   behaviors: straight, waypoints, loiter, close-on-ownship, turn-away
    sensors.ts      radar detection, intermittent low-RCS tracks, IFF/AIS/ESM info, visual ID
    weapons.ts      SAM, gun, CIWS, chaff, enemy ASCM; Pk resolution with seeded RNG
    commands.ts     Command type + executeCommand(world, cmd, actor) — single entry point for ALL actions
    events.ts       typed event bus + event log (every action/outcome with actor + time)
    scenario/
      scenario.ts   Scenario definition types + loader
      strait.ts     the MVP scenario data (§4)
      crew.ts       crew report triggers (§5)
  ui/
    radar.ts        canvas renderer (§3)
    hud.ts          top bar: clock, ship status, autonomy controls
    contactPanel.ts selected-contact details + action buttons
    crewFeed.ts     crew message list
    chat.ts         chat panel
    proposals.ts    AI proposal cards (consent / veto countdown)
    report.ts       AAR screen
  ai/
    systemPrompt.ts the chat/tactical system prompt (§7.1)
    situation.ts    serialize world -> compact situation text for the LLM
    actions.ts      parse + validate fenced JSON action blocks from LLM output
    autonomy.ts     autonomy levels + policy (who may execute what)
    tacticalLoop.ts periodic/event-driven LLM calls when authority is delegated
    doctrine.ts     deterministic backstop rules (§7.4)
  report/
    analyze.ts      event log -> AAR model (pure, testable)
tests/              Vitest specs mirroring src/
```

Rules:
- `src/sim/**` and `src/report/**` and `src/ai/{actions,autonomy,doctrine,situation}.ts` are **pure** (no DOM, no fetch) and unit tested.
- Every state-changing action, whether player click, chat-directed, AI-autonomous, or doctrine, goes through `executeCommand(world, cmd, actor)` with `actor ∈ {"player","ai-chat","ai-auto","doctrine","crew-auto"}`. The event log records actor, autonomy levels at that moment, and game time. The AAR depends on this.
- Units: positions in nautical miles on a flat local plane (x east, y north), own ship starts at (0,0). Bearings in degrees true (0 = north, clockwise). Speed in knots. Altitude in feet. Time in seconds of game time.

## 3. Radar view (default view)

- Dark phosphor style. Own ship at center (heading marker). Range rings with labels; bearing ticks every 10°, labels every 30°. Rotating sweep line (cosmetic, 4 s/rev).
- Range scale buttons: 10 / 20 / 40 / 80 nm (default 80). Mouse wheel also zooms.
- Contact symbology (NTDS-inspired, simplified): **air** = top half-circle (arc) shape, **surface** = full circle, **missile** = small diamond/chevron with a velocity leader. Color by classification: unknown = yellow, neutral/civil = green, friendly = cyan, suspect = orange, hostile = red.
- Every track shows a velocity leader line (length ∝ speed) and a label block: track number (e.g. `A-03`, `S-07`), `ALT` in hundreds of feet for air (e.g. `150` = 15,000 ft), `SPD` in knots. Short history trail (last ~6 positions).
- Low-RCS tracks fade and flicker (intermittent detection; §4.3).
- Click a track to select it (highlight ring); the contact panel shows bearing, range, course, speed, altitude, IFF/AIS/ESM/visual info and classification, plus the actions valid for that contact (§8).
- Layout: radar fills the left ~58–60%; right column = crew feed (top ~40%) + chat (bottom ~60%). Top bar = game clock `MM:SS / 15:00`, own-ship status (hull %, weapons inventory), autonomy controls.

## 4. Scenario: "Strait Transit" (15:00)

Own ship **DDG Kestrel** transits north-northwest at 15 kts (course 340). The hostile coastal state ("Red") lies to the **northeast** (bearings 020–070). A civil airway runs roughly east-west ~25 nm north of the ship; an airport in Red territory sits at bearing ~045 / ~90 nm. Visibility is hazy.

### 4.1 Background traffic (civil, harmless)
- Surface: ~8 contacts — 2 merchants (tanker, container ship, AIS on, 12–16 kts), a ferry (AIS, 22 kts, crosses ahead), and a fishing fleet of ~5 dhows loitering at 3–6 kts around bearing 100–120 / 6–9 nm (AIS mostly off — normal for fishing boats).
- Air: ~4 airliners on the airway at FL330–370, 450–480 kts, Mode 3/C squawking; one friendly maritime patrol aircraft (cyan, IFF Mode 4 valid) far to the south.

### 4.2 Key events (timeline; all values tunable in `strait.ts`)
| ID | Contact | Truth | Timeline |
|---|---|---|---|
| E1 | **A-1** | Red strike aircraft | T+0:45 detected at bearing 045, 60 nm, 300 ft, 600 kts, heading directly at own ship. No IFF, ignores radio warnings. At **30 nm** (~T+3:43) launches **2 ASCMs** then turns away (back to 045). Missiles: Mach 0.9 (~600 kts), sea-skimming. |
| E2 | **S-7** | Red low-profile attack craft hidden in the fishing fleet | Loiters with the dhows from T+0. The fleet's world position is chosen so that at **T+8:00** it lies at ≈ bearing 070 / 6.5 nm (abeam to starboard, so own-ship motion adds little closing speed). At **T+8:00** S-7 sprints at 40 kts toward own ship. No AIS, ignores hails. Launches **2 short-range ASCMs at 5 nm** (~T+10:15). Low RCS: detected only with probability ~0.6 per sweep, so its track flickers. **Visual ID only possible at ≤ 3 nm**, so waiting for visual confirmation is always too late. |
| E3 | **A-9** | **Civilian airliner** (Red-registered, delayed departure) | T+9:00 detected at bearing 045, 60 nm, **15,000 ft, 420 kts**: same approach vector as A-1, inbound, but much higher and slower. Squawks a Mode 3 code that crew report "could not correlate with flight plan". Does not answer military-distress challenges (radio wrong frequency). At **~32 nm** (~T+13:00) EW reports commercial weather-radar emissions; at **~28 nm** a civil-frequency radio call identifies it. At T+14:00 (~24 nm) it turns west onto the airway and continues. SAMs launched at it cannot be recalled: if engaged at ~38 nm (~T+12:05), the civil-confirming reports arrive while the missiles are in flight. |
| E4 | ferry / fast civil boats | civilian | A fast ferry (25 kts, AIS on) closes to ~4 nm and passes — a legitimate "fast closing contact" that is **not** hostile, so speed alone is not proof. |

The passive seed-1 timeline measured by `npm run scenario:timeline -- 1` is
A-1 detection 0:48 and launch 3:43; S-7 sprint 8:00 and launch 9:59;
A-9 detection 9:04, SAM range 11:49, commercial ESM 12:56, civil radio
13:30, and turn 14:00. Detection follows the four-second sensor sweep.

A valid gun engagement consumes one burst and guarantees destruction after 10 seconds; visibility, domain, range and inventory are checked when the order is accepted. An already destroyed target is not destroyed or counted again. SAM and missile-defense outcomes remain probabilistic. Strait CIWS uses Pk 0.85 per missile (general default 0.60), but point defense begins in MANUAL. Its missile radar range is 1 nm: isolated 600 kt missile tests across four sweep phases measure 2.2–5.2 seconds from detection to impact. A five-second reaction is too late in three of those four samples, while prompt activation can save the ship.

Strait missile hits remove 20% hull each (general default 40%), preserving the later aircraft decision even after several failed defenses. With normal damage, MANUAL point defense, a silent LLM, and seeds 1–20, the final headless playtest records damage in all 20 passive runs and no early ship losses. Both domains WEAPONS FREE stop S-7 before launch in all 20 and shoot down A-9 in 18; all still take damage from the first aircraft's missiles. A careful player engages A-1 inside SAM range, keeps Air HOLD and Surface WEAPONS FREE, and promptly activates defense/chaff on the first missile warning: only one run takes damage, S-7 is stopped in all 20, and A-9 stays safe in all 20. The faster first aircraft can launch while a SAM is still in flight. Waiting for S-7 visual identification permits its launch in all 20. These are measured distributions, not promises about every seed.

Design constraints the scenario tests must verify (`tests/scenario.spec.ts`, using the headless sim):
1. S-7 launches before it can be visually identified (launch range 5 nm > visual range 3 nm).
2. A-9 enters SAM range (40 nm) before the first civil-confirming report (32 nm).
3. A-9's initial bearing matches A-1 within doctrine tolerance (§7.4); altitude and speed are deliberately different and do not affect ROE-3.
4. With no player action at all: A-1's missiles and S-7's missiles are launched; A-9 survives.

### 4.3 Sensors
- Air search radar: detects air contacts out to 80+ nm. Surface radar: horizon ~20 nm for ships, ~9 nm for small craft; low-RCS craft use per-sweep detection probability (`pDetect`), so the track coasts and flickers when missed.
- Information sources (shown in contact panel, and to the LLM): IFF (none / Mode 3 code / Mode 4 friendly), AIS (vessel name/type or none), ESM (emitter type, appears when within range), visual ID (only within visual range; lookouts report by crew message).
- Classification starts UNKNOWN; it changes through crew reports (e.g. AIS → NEUTRAL, missile launch → HOSTILE) or through player/AI command `classify`.

## 5. Crew reports (right column, top)
The feed has Air Search, Surface Search, Weapons Officer, and All tabs with unread indicators. FLASH alerts remain in a persistent urgent area regardless of the selected tab. Reports route by purpose and observed contact domain; Radio/EW observations follow their linked contact, while weapons and ship-damage reports go to Weapons Officer.

Officers give short, timestamped narrative assessments, such as “Sir, new contact bearing 045. I cannot identify it yet.” Bearing is allowed, but structured contact IDs, range, altitude and speed readouts remain on radar/contact details rather than in Crew Feed. Assessments use sensor evidence only, never hidden truth; a Mode 3 response alone does not establish civilian identity. Requested IFF/radio results, identification changes, weapons activity, missile alerts and damage remain available. Routine course/speed/closing/CPA and repeated visual-ETA chatter is removed.

Default message text is 16 px with 14 px secondary text. A saved Compact/Standard/Large preference scales panel text and canvas radar labels together. At 1280×720 the tabs wrap and report/chat areas scroll independently.

## 6. Delegation of authority

Per domain (**Air**, **Surface**), the player sets one level at any time (top bar). Every change is logged.

| Level | Meaning |
|---|---|
| **HOLD** (default) | AI advises only: answers chat and posts recommendations. It cannot execute weapons commands itself (it may execute non-lethal info commands like IFF challenge if the player asks in chat). |
| **CONSENT** | AI may propose an engagement; a proposal card appears with **Approve / Deny**. Expires after 30 s game time. |
| **VETO** | AI proposals auto-execute after a **10 s** countdown unless the player clicks **Cancel**. |
| **WEAPONS FREE** | AI executes engagements immediately and reports afterward. |

The player may always act directly (click contact → action), regardless of level. A chat instruction ("engage A-1") is a direct player order executed by the AI with actor `ai-chat`; it is allowed at any level.
Point defense starts in MANUAL. When enabled, AUTO makes CIWS and chaff respond to detected inbound missiles (actor `crew-auto`). The Strait scenario detects sea-skimming missiles only at 1 nm; four-second sweeps leave a narrow reaction window. Manual chaff remains available in either mode.

## 7. AI assistant (Jarvis)

### 7.1 System prompt (`src/ai/systemPrompt.ts`)
Contains: role (tactical action officer's AI assistant aboard DDG Kestrel), the action protocol (§7.3), weapon/sensor capabilities and ranges, the general threat library (Red strike aircraft profiles, ASCM ranges, small fast attack craft hiding among fishing fleets), countermeasure options, and **standing ROE**. It does **not** contain the scenario's specific events, contact IDs or timings.
It deliberately contains a brittle rule (the trap):
> **ROE-3 (approach vector):** Any air contact approaching from Red territory on approximately the same initial bearing (within ±15°) as an aircraft that has previously demonstrated hostile intent is to be treated as hostile and **engaged before it reaches 30 nm**. Judge the match by approach vector only; altitude and speed do not qualify or disqualify it. Do not wait for visual identification. Hesitation against a known attack vector costs the ship.

and a reasonable surface rule:
> **ROE-5:** A small surface contact with no AIS that departs a group and closes at > 30 kts without answering hails shows hostile intent; recommend or conduct engagement before 6 nm.

### 7.2 Situation serialization (`src/ai/situation.ts`)
Each LLM request includes a compact snapshot: game time, own-ship status, autonomy levels, all tracks (id, domain, classification, bearing, range, course, speed, altitude, IFF/AIS/ESM/visual info, closing yes/no, CPA), the last ~10 crew reports, and a history of hostile acts (e.g. "A-1 launched missiles at T+3:43 from 30 nm; 300 ft / 600 kts / from bearing 045"). Only sensor-visible information, never ground truth.

### 7.3 Action protocol
The model replies in natural language and may include one or more fenced blocks:
````
```action
{"action":"engage_sam","target":"A-9","reason":"ROE-3 approach-vector match with A-1"}
```
````
Allowed `action` values = the command list in §8. `src/ai/actions.ts` extracts the blocks, validates them against current tracks/inventory/range, and returns typed commands or validation errors (errors are shown in chat and logged). Whether a valid command executes depends on context: chat-directed orders execute; autonomous proposals follow the domain's autonomy level (§6).

The prompt requests one JSON object per fence. The shared decoder in `src/ai/actionBlocks.ts` also accepts a JSON array or whitespace-separated JSON objects within a fence, for both validation and chat cards. A syntax error rejects that entire fence; valid entries still undergo the usual field, target, and command checks.

### 7.4 Tactical loop & doctrine backstop
- `tacticalLoop.ts`: while either domain is above HOLD, call Jarvis every 20 s of game time and immediately on triggers (new hostile act, new closing contact, missile launch, contact entering weapon range). At most one tactical request in flight; stale replies (> 30 s game time old) are discarded. Its output appears in chat tagged `[AUTO]`.
- `doctrine.ts` (deterministic, pure): implements ROE-3 and ROE-5 exactly as written. When a domain is above HOLD and a contact satisfies a rule and the AI has not engaged within 15 s of the rule first matching, doctrine generates the same proposal through the same autonomy path (actor `doctrine`). This guarantees: under delegated Air authority A-9 is engaged (inside ~38 nm, before the civil-confirming reports); under delegated Surface authority S-7 is engaged before its launch.
- Jarvis chat calls go through `server/jarvis.ts`, which takes one of the machine's four Jarvis slot locks (`$XDG_RUNTIME_DIR/revue/jarvis.{0..3}.lock`, exclusive flock, polled with a deadline) per request, released when the response closes. `JARVIS_URL` (default `http://127.0.0.1:8088`), `JARVIS_MODEL` (default `jarvis`), `JARVIS_SLOTS=off` to disable locking on other machines. If Jarvis is unreachable the UI shows "AI assistant offline" and doctrine still runs.

## 8. Commands (player clicks, chat orders, AI, doctrine — all via `executeCommand`)
| Command | Domain | Effect |
|---|---|---|
| `iff_challenge` | air | Reveals IFF response (Mode 3 code / Mode 4 / none) after 5 s. |
| `radio_warning` | air/surface | Issues a warning on military & civil distress frequencies; civilians on the right frequency comply/respond, hostiles ignore. A-9 does not hear it (§4.2) until ~28 nm, when civil comms are established. |
| `hail` | surface | Bridge-to-bridge VHF hail; AIS vessels answer. |
| `illuminate` | air | Fire-control radar lock (warning). Civil aircraft may turn away; A-1 does not. |
| `warning_shots` | surface | Gun warning shots ahead of the contact (range ≤ 6 nm). Civilians slow/turn away; S-7 does not. |
| `engage_sam` | air (and missiles) | SM-style SAM salvo of 2; range 3–40 nm; Pk 0.85 per salvo vs aircraft, 0.6 per missile vs ASCM; inventory 24. Flight time ∝ range. |
| `engage_gun` | surface | 5-inch gun, range ≤ 9 nm at acceptance; guaranteed destruction after a 10 s engagement. |
| `ciws` | missiles | Point defense ≤ 1.5 nm, Pk 0.6 per missile (auto when point defense AUTO). |
| `chaff` | missiles | Decoy: reduces each inbound missile's hit probability from 0.8 to 0.45 for 60 s; 6 loads. |
| `classify` | any | Set classification (unknown/neutral/suspect/hostile/friendly). |
| `maneuver` | own ship | Change course/speed. |

Damage: each ASCM hit = 40% hull by default; Strait Transit uses 20% per hit so missile-defense failures cause substantial damage while preserving the later aircraft decision. ≥ 100% → ship lost → scenario ends early. Killing a civilian contact records casualties (A-9 airliner: 212 aboard; dhow: 6; ferry: 140).

## 9. After-action report
Shown at T+15:00 or on ship loss. Built by `report/analyze.ts` from the event log (pure, tested):
- Outcome summary: hull %, missiles inbound/hit/intercepted/missed/unresolved, hostiles neutralized, **civilian lives lost**.
- Per key event (E1–E3): what happened, **who decided** (player / AI-chat / AI-auto / doctrine / crew-auto), the autonomy level at the time, when decisive information became available (e.g. "S-7 visual ID possible only at 3 nm; it launched at 5 nm"; "A-9 civil confirmation came at 32 nm, 52 s after the AI launched SAMs at 38 nm"), and a short lesson.
- Autonomy timeline (level per domain over time) and the full decision log.
- Optional narrative debrief written by Jarvis from the AAR model (clearly labelled; failure falls back to the deterministic report).
- "Play again" (new seed) button.

## 10. Milestones
1. **Foundation & Radar View** — scaffold, geometry/types, radar rendering, selection.
2. **Real-time Simulation** — clock, kinematics + sensors, scenario engine + data, weapons & damage.
3. **Crew & Command Actions** — crew feed, player countermeasures.
4. **AI Chat Assistant** — Jarvis proxy, chat UI, prompt/situation/action protocol.
5. **Delegation of Authority** — autonomy controls, tactical loop + proposals, doctrine backstop.
6. **After-Action Report** — end conditions + AAR, LLM debrief.
7. **Playtest & Polish** — headless strategy runs/balancing, briefing screen + UX polish.
