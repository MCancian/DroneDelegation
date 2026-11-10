# DroneDelegation

A real-time naval command game about **delegating authority to an AI agent**. You command a destroyer through a 15-minute scenario that can't be paused. Radar contacts, crew reports and an LLM tactical assistant inform your decisions, and you choose how much weapons authority the AI holds. An after-action report then shows how those choices shaped what happened.

- Design spec: [docs/DESIGN.md](docs/DESIGN.md)
- Roadmap: see the GitHub milestones.

## Run locally

Requirements: Node.js >= 22.

For a clean install, use `npm ci`.

```bash
npm ci
npm run dev
```

The Vite dev server serves the UI at `http://localhost:5173` and proxies `/api` to the Node API server on `http://127.0.0.1:8787`. In dev, `/api/health` is reachable through the Vite proxy at `http://localhost:5173/api/health`.

## Production build

```bash
npm run build
npm start
```

`npm run build` creates `dist/` for the UI and `dist-server/` for the Node server. `npm start` serves `dist/` and the `/api` endpoints. Set `PORT` to change the server port (default `8787`).

## Checks

```bash
npm run typecheck
npm test
```

The AI assistant runs against a local OpenAI-compatible LLM server (default `http://127.0.0.1:8088`, model `jarvis`).

## Manual controls

The top bar provides own-ship maneuver and point-defense controls; the contact panel (bottom-left of radar) provides per-contact actions.

**Own-ship maneuver** — Enter a course (degrees true, 0–359.9) and speed (knots, 0–35) then click **Maneuver**. The ship immediately adopts the commanded course and speed.

**Point defense** — The `PD: AUTO` / `PD: MANUAL` toggle controls whether CIWS and chaff respond to inbound missiles automatically (actor `crew-auto`). The **Chaff** button deploys one chaff load manually.

**Contact actions** — Click a radar track to select it. The panel shows only actions valid for that contact's domain. Disabled buttons display the reason inline (e.g. "out of range 52.3 nm > 40 nm") so the numeric constraint is visible without hovering.

**Weapon inventory** — Displayed in the top bar (`SAM / CHAFF / GUN / CIWS` counts), updated each frame.

## Chat (Jarvis)

The chat panel shows an **online badge** when Jarvis is reachable (`GET /api/ai/health`). When offline, chat is disabled but crew reports and simulation continue.

**Controls:** Enter sends, Shift+Enter inserts a newline, Cancel aborts the current stream.

Each request sends the system prompt, a fresh sensor-only situation snapshot, and the last 20 conversation exchanges.

**Direct orders** (imperative commands) execute as `ai-chat` through the command entrypoint with range/inventory checks. Use exact displayed track IDs including zero padding:

- `Deploy chaff`
- `Set course 090 speed 20 knots`
- `Hail S-01`
- `Engage A-01`

Advice may show suggested action cards; those suggestions do not execute. Conditional or hypothetical chat orders are treated as advice. Errors and results appear in chat.

## Delegation controls

The top bar sets Air and Surface authority independently. Both begin at **HOLD**.

- **HOLD:** advice only.
- **CONSENT:** autonomous engagement proposals require approval within 30 game seconds.
- **VETO:** proposals execute after 10 game seconds unless cancelled.
- **WEAPONS FREE:** autonomous engagements execute immediately.

Point defense remains a separate AUTO/MANUAL control. Direct player actions and
explicit chat orders remain available at every authority level. Authority changes
and command snapshots are retained in the event log.

## Backend configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `JARVIS_URL` | `http://127.0.0.1:8088` | OpenAI-compatible endpoint |
| `JARVIS_MODEL` | `jarvis` | Model name |
| `JARVIS_SLOTS` | *(unset)* | `off` disables flock (other machines only); normal uses 4 shared XDG slots |

Endpoints: `GET /api/ai/health`, `POST /api/chat`.

## Implementation choices (not spec changes)

The spec (§8) defines command semantics but leaves several numeric parameters unspecified. These are implementation choices recorded here:

- **Maneuver speed cap 35 kts.** The spec does not state a maximum own-ship speed. 35 kts was chosen as a plausible destroyer sprint speed.
- **Non-lethal response latency 5 s.** The spec says civilians "answer" hails/warnings and IFF reveals happen "after 5 s" for IFF specifically. A uniform 5 s delay was applied to all non-lethal command responses (hail, radio warning, illuminate, warning shots) for consistency. The spec does not mandate this uniformity.
- **Warning shots consume 1 gun burst.** The spec (§8) says warning shots are "gun warning shots ahead of the contact" without specifying inventory cost. Consuming one burst from the gun inventory was chosen to prevent unlimited warning shots.
- **A-9 radio range 28 nm.** The spec (§4.2) states A-9 "cannot hear military-distress warnings until ~28 nm." This is encoded as `radioRangeNm: 28` in the contact's `responses` field; radio warnings issued while the contact is beyond 28 nm are recorded as "ignored" in the event log.

## Tooling

Development tooling (Jarvis caller, packet builder, staged apply, Node 22 wrapper) is documented in [docs/TOOLING.md](docs/TOOLING.md).

Run all verification gates locally:

```bash
bash scripts/node22.sh npm run verify
```
