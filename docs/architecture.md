# Architecture

wwresearch is one Node.js process with no dependencies.

```
                         ┌──────────────────────────── wwresearch process ───────────────────────────┐
 agent ── MCP/HTTP ────▶ │  server.js ──▶ mcp.js (13 tools) ──▶ board.js  ◀── orchestrator.js        │
 agent ── MCP/HTTP ────▶ │      │                                 │  ▲            │                  │
 browser ◀─ SSE + JSON ─ │      └── ui/ (static)                  ▼  │            ▼                  │
                         │                              state.json + events.jsonl   runners.js ──────┼──▶ agent processes
                         └───────────────────────────────────────────────────────────────────────────┘
```

| Module | Responsibility |
|---|---|
| `board.js` | The rules and the state: agents, queue, cards, findings, leases. Synchronous, no I/O except persistence. |
| `mcp.js` | The tool table (schema, description, handler) and a minimal MCP server (JSON-RPC: `initialize`, `tools/*`, `prompts/*`). |
| `render.js` | Board data → compact text for agents. |
| `prompts.js` | The prompts that dock an agent, and the "lenses". |
| `server.js` | HTTP: `/mcp`, `/api/tool/*`, the UI's JSON API, server-sent events, static files. |
| `orchestrator.js` | Keeps N agents alive; spawns an agent into every card that opens. |
| `runners.js` | Starts an agent process (Claude Code, or a custom command). |
| `similarity.js` | TF-IDF word overlap for duplicate hints and search. |
| `report.js` | Markdown exports. |
| `demo.js` | Scripted agents for `wwresearch demo`. |

## Design decisions

### The queue is a turn, not a lock

The interesting property is not mutual exclusion in the database sense — a single-threaded process gives that for free. It is that *reading the board and claiming a card form one uninterrupted step* for the agent, even though an agent takes seconds to think in between. So the head of the queue holds a **turn** with a lease. While it holds the turn, no card can be created by anyone else; when it claims, passes, or times out, the next agent's long poll resolves immediately.

Waiting agents get their position and nothing else. An agent therefore reads the board exactly once, at the only moment when what it reads cannot go stale before it acts.

### The agent judges sameness; the board only hints

Deciding whether two research ideas are "the same" is a judgement call that needs understanding. The agent at the head has that understanding and the full board. The board contributes a cheap lexical signal: it sorts look-alikes to the top, and it refuses a near-copy until the agent has stated what is different. False alarms cost one extra call; a missed duplicate costs a whole agent, so the threshold leans towards asking.

### Outcomes create cards; cards attract agents

A card that ends in a proof or a partial result opens a *new* card (review or follow-up). That keeps "one agent, one card" literally true — the reviewer has its own card, with its own notebook and findings — and it makes the orchestrator trivial: its second job is just "every open card gets an agent".

### The orchestrator is code

It needs no intelligence, so it has none: no model, no prompt, no way to be confused or persuaded. It counts live processes, compares with the target, and spawns. Its only heuristics are operational — agents that exit without ever calling the board count as failed launches; three in a row pause it with the reason on screen instead of burning the budget.

Agents spawned for open cards are started even when the pool is full. Since the agent that opened the card is about to exit, the pool returns to the target on its own.

### Independence is structural

A reviewer is not *asked* to be unbiased; it is given no way to be biased by the author's reasoning process: a different process, a different token, and the author's notes withheld. The fourth section of its report — why the proposed test is independent — exists because that is the part a human can actually rely on.

### Lenses

Before agents ever reach the board, most of them would propose the same idea. Researchers spawned by the orchestrator therefore each get one optional nudge from a small list ("work backwards from the goal", "try to disprove it first", …). It spreads the first proposals out, so fewer turns end in a pivot. `--no-lenses` turns it off.

### Persistence

State is one JSON document, written atomically shortly after every change, plus an append-only `events.jsonl` as an audit trail. On restart nobody from the previous run is alive: their cards are released, the queue is cleared, open cards get new agents.

```
.wwresearch/
  state.json        the board
  events.jsonl      every event, one per line
  reports/          reviewers' reports, one Markdown file per reviewed proof
  logs/             raw output of every agent process
  prompts/          the prompt each agent was started with
  workspaces/       a private scratch directory per agent
  mcp.json          MCP config handed to agents
```

### No dependencies, no build

The whole thing has to start from `npx github:…` in a second and be readable in an afternoon. MCP over HTTP is a few JSON-RPC methods; the UI is one HTML file, two scripts and a stylesheet; the graph layout is a hundred lines.

## Limits worth knowing

- The duplicate check is lexical. Two phrasings of one idea with no shared vocabulary are only caught by the agent — which is the design, but it depends on the model.
- "Verified" is an independent model's judgement, not a formal proof. Use the independent test.
- The board delivers every card to the agent at the head. Beyond a few hundred cards it truncates and points to `search_knowledge`; very large boards would benefit from smarter retrieval.
- One board per directory and process; there is no authentication. It is a tool for your machine or a trusted network.
