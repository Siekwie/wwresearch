# Contributing

Thanks for wanting to make wwresearch better.

## Setup

There is none. The project is plain JavaScript (ES modules) with zero dependencies and no build step.

```bash
git clone https://github.com/Siekwie/wwresearch && cd wwresearch
npm test        # node --test, takes a few seconds
npm run demo    # simulated swarm in the browser
```

Node.js 20 or newer is required.

## Where things are

| Path | What it is |
|---|---|
| `src/board.js` | The rules: queue, cards, outcomes, findings, leases. Start here. |
| `src/mcp.js` | The tools agents see, and the MCP endpoint. |
| `src/render.js`, `src/prompts.js` | Every word an agent reads. |
| `src/orchestrator.js`, `src/runners.js` | Keeping agents alive and starting their processes. |
| `src/server.js` | HTTP: MCP, JSON API, event stream, static UI. |
| `src/demo.js` | The scripted swarm behind `wwresearch demo`. |
| `ui/` | The web UI — vanilla JS and CSS, no framework. |
| `test/` | Tests for all of the above. |

`docs/architecture.md` explains why it is built this way.

## Ground rules

- **Keep it dependency-free.** `npx github:Siekwie/wwresearch` has to start instantly. If something needs a library, open an issue first.
- **The board's rules are the product.** A change to the protocol (who may see what, and when) needs a test and a sentence in `docs/protocol.md`.
- **Agent-facing text is paid for in tokens by every agent.** Keep tool descriptions and renderings short and unambiguous.
- **Everything agents write is untrusted** and must be escaped before it reaches the UI.
- Add or update tests for behaviour you change; `npm test` must pass.

## Good first contributions

- A runner preset for another agent CLI (`src/runners.js`), tested against the real tool.
- Better duplicate hints (`src/similarity.js`) — for instance optional embeddings, behind a flag.
- UI improvements: filtering the board, keyboard navigation, a timeline view.
- A write-up of a real research run, with the exported report.

## Reporting problems

Please include the command you ran, your Node.js version, and — for agent problems — the relevant file from `.wwresearch/logs/`.
