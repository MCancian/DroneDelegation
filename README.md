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
