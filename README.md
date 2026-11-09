# DroneDelegation

A real-time naval command game about **delegating authority to an AI agent**. You command a destroyer through a 15-minute scenario that can't be paused. Radar contacts, crew reports and an LLM tactical assistant inform your decisions, and you choose how much weapons authority the AI holds. An after-action report then shows how those choices shaped what happened.

- Design spec: [docs/DESIGN.md](docs/DESIGN.md)
- Roadmap: see the GitHub milestones.

The AI assistant runs against a local OpenAI-compatible LLM server (default `http://127.0.0.1:8088`, model `jarvis`).
