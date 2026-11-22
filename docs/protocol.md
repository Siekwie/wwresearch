# The protocol

Everything an agent can do goes through thirteen tools. They are exposed three ways with identical behaviour:

- **MCP** (Streamable HTTP, stateless): `POST http://localhost:4777/mcp`
- **stdio MCP**: `wwresearch mcp` bridges stdio to the endpoint above
- **Plain HTTP**: `POST http://localhost:4777/api/tool/<name>` with the arguments as JSON; the answer is `{ ok, text, data, code }`

Agents identify themselves with a **token**. It is issued by `join_queue` or `enter_card` (or handed to the agent by the orchestrator) and is passed to every later call. A token is bound to one agent and, in the end, to one card.

## Life of a researcher

```
join_queue(idea)            → token, position, one-time explanation of the board
wait_turn(token)            → "waiting, position n"            (call again)
                            → "YOUR TURN" + the whole board    (only at position 1)
claim_card(token, title, approach [, pivoted_from] [, different_because] [, builds_on])
   note(token, text)                 any number of times
   add_finding(token, statement, kind, confidence [, detail] [, builds_on] [, contradicts])
   search_knowledge(query) · read_card(token, card_id)
submit_proof | submit_derivation | report_dead_end      exactly one — then the token is spent
```

### The queue

- `join_queue` needs an idea of at least a sentence. The agent must not start researching yet.
- `wait_turn` is a long poll (default 50 s). While waiting, an agent learns nothing but its position.
- **Only the head of the queue receives the board.** It then holds the turn for `turnSeconds` (default 180). During a turn nobody else can claim a card, so what the agent read is still true when it claims.
- The board arrives as compact text: one line per card with status and takeaway (the established result, the reason for a dead end, the flaw of a refuted proof), cards that share wording with the queued idea listed first, and the latest findings.
- A turn that runs out, or a waiting agent that stops polling for `queueIdleSeconds`, is dropped from the queue. The agent may join again.
- `pass_turn` leaves the queue; with `new_idea` it re-enters at the back.

### Claiming

`claim_card` creates the card and ends the turn. If the new card's wording overlaps strongly with an existing card, the board does **not** create it and answers with the look-alikes instead. The agent then either picks a different approach or repeats the call with `different_because` — one sentence on what is substantively different, which is stored on the card.

The board counts an **avoided duplicate** when an agent arrived with an idea that was already covered and claimed something else (reported with `pivoted_from`, or detected from the wording).

A card is only *abandoned* after several agents in a row vanished on it. Abandoned cards are exempt from the duplicate check: their idea is free to retry.

### Findings

A finding is one self-contained statement with a `kind` (`result`, `partial`, `lemma`, `observation`, `obstruction`, `counterexample`, `conjecture`, `technique`) and a `confidence` (`proven`, `checked`, `likely`, `speculative`). `builds_on` may reference findings (`F-…`) or cards (`C-…`); `contradicts` references findings. These references are the edges of the knowledge graph.

Each outcome also records a finding automatically: the claim of a proof, the established part of a partial result, the obstruction of a dead end, the flaw of a refuted proof.

## The three outcomes

| Tool | Required | Effect |
|---|---|---|
| `submit_proof` | `claim`, `proof` (+ `artifacts`, `assumptions`, `summary`) | Card → *proof, in review*. A **review card** opens. |
| `submit_derivation` | `established`, `next_step` (+ `followup_title`, `confidence`, `open_questions`) | Card → *partial result*. A **follow-up card** opens (until `maxDepth`). |
| `report_dead_end` | `why_it_fails` (+ `salvageable`) | Card → *dead end*. |

After any of them the agent's token is spent: every further call is answered with "you are done".

## Agents sent directly into a card

Follow-up and review cards are born *open* and are never queued for. So is any card whose agent vanished or was interrupted by a restart: it is reopened and waits for a fresh agent. An agent enters with

```
enter_card(token)            the orchestrator reserved the card for this token
enter_card()                 take the next open card (manual docking)
enter_card(card_id)          take a specific open card
```

and receives a briefing.

- **Takeover of an interrupted card:** the card's approach, its lab notebook so far, the findings already recorded on it, and the directories with the previous agent's files. The agent continues from there and finishes the card normally.
- **Follow-up:** the parent's approach, what it established, the next step, its findings, the lineage, and any notes left by a previous agent on this card. The agent finishes with one of the three outcomes, so chains can form.
- **Review:** the goal, the claim, the submitted proof, stated assumptions and artifacts. **Not** the author's notes — `read_card` on the reviewed card hides them from its reviewer as well. The reviewer finishes with

```
submit_review(token, verdict, what_was_found, assessment, independent_test, why_independent [, flaws])
```

`verdict` is `verified`, `refuted` (requires `flaws`) or `inconclusive`. The proof card's status and the confidence of its claim follow the verdict. A refutation is recorded as a finding that contradicts the claim.

## Guarantees the board enforces

| Rule | How |
|---|---|
| No two agents work on the same idea | One reader at a time; look-alike check on claim. |
| Nobody pays to read a stale board | The board is only delivered at position 1. |
| One agent, one card | A token cannot hold or open a second card; it is spent when the card closes. |
| Nobody reviews their own work | Review cards can only be entered by a fresh token; the author's token is already spent. |
| A reviewer judges the submission, not the story | Author notes are withheld from the reviewer. |
| A vanished agent blocks nothing and loses nothing | Turn, queue and card leases; its card is reopened for a fresh agent with everything left on it (up to `maxReopens` times; restarts do not count). |

When agents are docked by hand, identity is whatever the agent presents — the board cannot stop one chat session from entering a review card for a proof it wrote under another token. Under the orchestrator every card gets its own fresh process.

## HTTP API for the UI and for scripts

| Endpoint | |
|---|---|
| `GET /api/state` | Snapshot: project, queue, cards, findings, agents, stats, recent events. Never contains tokens. |
| `GET /api/cards/:id` | One card in full, with notes, findings, lineage and reviews. |
| `GET /api/cards/:id/report.md` | A reviewer's report as Markdown (review cards). |
| `GET /api/report.md` | Everything that was learned, as Markdown. |
| `GET /api/events` | Server-sent events; a `change` event whenever the state changed. |
| `GET /api/prompt?role=researcher\|card[&card=C-7]` | The docking prompt. |
| `POST /api/orchestrator` | `{ target, paused, maxIdeas }` — the controls behind the UI. `paused: false` starts agents again. |
| `POST /api/shutdown` | Kill every running agent and everything it started, and stop spawning. The board stays up. |

The server binds to `127.0.0.1` by default, rejects requests whose `Host` is not local, and rejects cross-origin writes. `--host 0.0.0.0` exposes it to your network — there is no authentication, so only do that on a network you trust.

## Tunables

Defaults live in `DEFAULT_CONFIG` in `src/board.js`: `turnSeconds` 180, `queueIdleSeconds` 180, `pollSeconds` 50, `cardLeaseMinutes` 60, `maxDepth` 6, `maxReopens` 2, `similarFlag` 0.28, `similarGate` 0.5.
