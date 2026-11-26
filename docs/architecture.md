# Architecture

wwresearch is one Node.js process with no dependencies.

```
                         ┌──────────────────────────── wwresearch process ───────────────────────────┐
 agent ── MCP/HTTP ────▶ │  server.js ──▶ mcp.js (14 tools) ──▶ board.js  ◀── orchestrator.js        │
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
| `runners.js` | Starts an agent process (Claude Code, or a custom command), with its permissions, and stops its whole process tree. |
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

A card that ends in a proof or a partial result opens a *new* card (review or follow-up), and a verified proof opens one more: a result check, whose agent decides whether the goal is reached. That keeps "one agent, one card" literally true — the reviewer has its own card, with its own notebook and findings — and it makes the orchestrator trivial: its second job is just "every open card gets an agent".

### The orchestrator is code

It needs no intelligence, so it has none: no model, no prompt, no way to be confused or persuaded. It counts live processes, compares with the target, and spawns. Its only heuristics are operational — agents that exit without ever calling the board count as failed launches; three in a row pause it with the reason on screen instead of burning the budget.

Each agent is started as one stoppable unit with everything it launches — a Job Object on Windows (`src/jobwrap.ps1`), its own process group elsewhere — at below-normal priority. Whatever an agent leaves running when it exits dies with it, and **Shut down** (`POST /api/shutdown`) kills every unit at once and pauses the pool. The cards they held reopen for fresh agents without using up a retry. The same happens by itself when the goal is marked as finished, by a result checker's `finished: true` or by the user's **Finished** button. The orchestrator still judges nothing: it reacts to the `goal_finished` event.

The target is a cap for card agents as well. What counts is the number of agents that still have work to do: an agent whose card is closed is only winding down, so the review or follow-up it opened starts at once, without waiting for its process to exit. When more cards are open than the target allows — after a restart every card that was in progress is open again, and the user may have asked for fewer agents or a costlier model this time — they wait and are worked off as slots free up: result checks first, then reviews, then research cards, oldest first. New researchers only start once no card is waiting for a slot.

An agent that waits is not a dead agent. A headless Claude Code agent that starts a search in the background and ends its turn prints nothing until the job reports back, possibly hours later. The runner reads which background jobs Claude Code lists as running and keeps the card's lease alive while there are any; only an agent with no board call, no output and no running job for `cardLeaseMinutes` is released. The total timeout still bounds a job that never ends.

Costs are added up as they are reported (Claude Code states the session's cost at the end of every turn), not when the process exits, so stopping a run does not lose them. Agents stopped before their first report are counted, and the UI marks the total as a lower bound.

### Independence is structural

A reviewer is not *asked* to be unbiased; it is given no way to be biased by the author's reasoning process: a different process, a different token, and the author's notes withheld. The fourth section of its report — why the proposed test is independent — exists because that is the part a human can actually rely on.

### Lenses

Before agents ever reach the board, most of them would propose the same idea. Researchers spawned by the orchestrator therefore each get one optional nudge from a small list ("work backwards from the goal", "try to disprove it first", …). It spreads the first proposals out, so fewer turns end in a pivot. `--no-lenses` turns it off.

### Persistence

State is one JSON document, written atomically shortly after every change, plus an append-only `events.jsonl` as an audit trail. On restart nobody from the previous run is alive, so the queue is cleared and every card that was being worked on is reopened. The orchestrator's second job then does the rest: open cards get agents. The new agent receives the card's notebook, findings and the previous agent's workspace directory — the card remembers; the agent is replaceable.

What is not restored is the interrupted agent's own context. That is why agents are told to note progress as they go, and why every agent's files live in a workspace that outlasts it.

### Agents are stopped when their card is closed

A closed card spends the agent's token, so nothing it does afterwards can reach the board. Agents that keep running anyway are stopped after a short grace period, and stopping always takes the agent's whole process tree with it — a stopped run must not keep computing, or spending, in the background.

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
- The board delivers every card to the agent at the head, in more detail the smaller the board is. Beyond 150 cards it lists only the newest and points to `search_knowledge`; very large boards would benefit from smarter retrieval.
- Agents share one machine. They are told how many CPU threads there are and how many agents use them, and to stop only their own processes by id — instructions, not walls.
- One board per directory and process; there is no authentication. It is a tool for your machine or a trusted network.
