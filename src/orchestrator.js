// The orchestrator. Plain code, no model, and deliberately only two jobs:
//
//   1. keep the number of live agents at the value the user set
//   2. react to events: when a review, check or follow-up card opens, spawn an
//      agent directly into that card — no queue; when the goal is marked as
//      reached, stop every agent
//
// The value the user set is a cap for both: cards wait for a free slot.
//
// It never reads research, never judges ideas, never talks to agents.

import { EventEmitter } from 'node:events';
import { researcherPrompt, cardPrompt, pickLens } from './prompts.js';

const CLOSING = new Set(['proof_submitted', 'derivation_submitted', 'dead_end', 'review_submitted', 'result_submitted']);

// Exit code of a Windows process that was ended by Ctrl+C (STATUS_CONTROL_C_EXIT,
// as Node reports it and as a signed number). Agents share the board's console,
// so Ctrl+C reaches them directly, often before the board itself hears of it.
const INTERRUPTED = new Set([3221225786, -1073741510]);

// Which open card gets the next free slot: a result check can end the run and
// a review settles a proof, so they go before cards that continue research.
const CARD_ORDER = { check: 0, review: 1 };

export class Orchestrator extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./board.js').Board} opts.board
   * @param {(ctx: object) => {exited: Promise<{code?: number, error?: string, costUsd?: number}>, kill: () => void}} opts.spawnAgent
   * @param {number} opts.target           number of agents to keep alive
   * @param {number} [opts.maxIdeas]       stop sending new researchers after this many (0 = unlimited)
   * @param {boolean} [opts.lenses]        give each researcher a different thinking nudge
   * @param {number} [opts.agentTimeoutMs] kill agents that run longer than this (0 = never)
   * @param {number} [opts.heartbeatMs]    pass agent output on to the board at most this often
   * @param {(agent: object) => string|null} [opts.workspaceFor]
   * @param {string[] | (() => string[])} [opts.notes] facts about the machine, shown to every agent;
   *   a function is asked again for every agent, so it can describe the machine as it is right now
   */
  constructor({ board, spawnAgent, target, maxIdeas = 0, lenses = true, agentTimeoutMs = 0, heartbeatMs = 60_000, workspaceFor = () => null, retryDelayMs = 2000, finishGraceMs = 30_000, notes = [], stopWhenFinished = true }) {
    super();
    this.board = board;
    this.stopWhenFinished = stopWhenFinished; // the goal is reached → stop every agent (the demo keeps going)
    this.spawnAgent = spawnAgent;
    this.lenses = lenses;
    this.agentTimeoutMs = agentTimeoutMs;
    this.heartbeatMs = heartbeatMs;
    this.workspaceFor = workspaceFor;
    this.notes = notes; // facts about the machine and permissions, shown to every agent
    this.retryDelayMs = retryDelayMs;
    this.finishGraceMs = finishGraceMs;
    this.live = new Map();
    this.stopped = false;
    this.pending = null;
    this.launchFailures = 0;
    this.lensOffset = Math.floor(Math.random() * 1000);
    board.setOrchestrator({ enabled: true, target, maxIdeas, paused: false, error: null, idle: false, live: 0 });

    this.onEvent = (ev) => {
      // Job 2 — the "prefabricated message": a card just opened and wants an agent.
      if (ev.type === 'card_opened') this.schedule();
      // A checker (or the user) says the goal is reached: nothing left to research.
      if (ev.type === 'goal_finished' && this.stopWhenFinished) this.shutdown('the goal is reached');
      // The board released an agent (lease expired): make sure its process is gone too.
      if (ev.type === 'agent_gone') this.#kill(this.live.get(ev.agentId));
      // An agent closed its card: its work is done and its token is spent. Give the
      // process a moment to wind down, then free the slot instead of letting it idle.
      if (CLOSING.has(ev.type)) {
        const rec = this.live.get(ev.agentId);
        if (rec) {
          rec.graceTimer = setTimeout(() => this.#kill(rec), this.finishGraceMs);
          rec.graceTimer.unref?.();
        }
        this.schedule(); // its slot is free for a card that is waiting
      }
    };
    this.onSettings = () => this.schedule();
    this.onShutdown = () => this.shutdown();
  }

  start() {
    this.board.on('event', this.onEvent);
    this.board.on('orchestrator', this.onSettings);
    this.board.on('shutdown', this.onShutdown);
    this.schedule();
    return this;
  }

  schedule(delay = 0) {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.reconcile();
    }, delay);
  }

  reconcile() {
    if (this.stopped) return;
    const o = this.board.state.orchestrator;
    if (o.paused) return;

    // Job 2: open cards get an agent directly, and before any new researcher —
    // but never beyond the number the user set. An agent whose card is closed
    // is only winding down and no longer counts, so the review or follow-up it
    // opened starts at once. After a restart many cards reopen together: they
    // are worked off as slots free up, judging cards first, then oldest first.
    const waiting = this.board
      .openCards()
      .filter((card) => !card.reservedFor)
      .sort((a, b) => (CARD_ORDER[a.kind] ?? 2) - (CARD_ORDER[b.kind] ?? 2) || a.createdAt - b.createdAt);
    for (const card of waiting) {
      if (this.#working() >= o.target) break;
      this.#spawn({ review: 'reviewer', check: 'checker' }[card.kind] ?? 'followup', card);
    }
    // Job 1: keep the pool full with researchers that go through the queue.
    while (this.live.size < o.target && (o.maxIdeas === 0 || o.ideasSpawned < o.maxIdeas)) this.#spawn('researcher', null);

    const idle = this.live.size === 0 && (o.target === 0 || (o.maxIdeas !== 0 && o.ideasSpawned >= o.maxIdeas));
    if (idle !== o.idle) {
      this.board.setOrchestrator({ idle });
      if (idle) this.emit('idle');
    }
  }

  /** Live agents that still have work to do: not those whose card is closed or who were released. */
  #working() {
    let n = 0;
    for (const { agent } of this.live.values()) if (agent.state !== 'finished' && agent.state !== 'gone') n++;
    return n;
  }

  #spawn(role, card) {
    const { board } = this;
    const o = board.state.orchestrator;
    const agent = board.registerAgent({ role, origin: 'orchestrator', cardId: card?.id ?? null });
    const goal = board.state.project.goal;
    const workspace = this.workspaceFor(agent);
    agent.workspace = workspace;
    const notes = typeof this.notes === 'function' ? this.notes() : this.notes;
    const prompt =
      role === 'researcher'
        ? researcherPrompt({ goal, token: agent.token, lens: this.lenses ? pickLens(this.lensOffset + o.ideasSpawned) : null, workspace, notes })
        : cardPrompt({ goal, token: agent.token, kind: card.kind, workspace, notes });

    // Output from the agent's process keeps its card's lease alive, so an agent
    // that waits hours on a search is not released for "no activity".
    let lastBeat = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastBeat < this.heartbeatMs) return;
      lastBeat = now;
      board.heartbeat(agent.id);
    };

    const rec = { agent, handle: null, timer: null, killed: false, costUsd: 0 };
    let handle;
    try {
      handle = this.spawnAgent({ agent, role, card, prompt, workspace, onActivity, onCost: (total) => this.#cost(rec, total) });
    } catch (err) {
      handle = { exited: Promise.resolve({ code: -1, error: err.message }), kill() {} };
    }
    rec.handle = handle;
    if (this.agentTimeoutMs > 0) {
      rec.timer = setTimeout(() => {
        board.agentGone(agent.id, `timed out after ${Math.round(this.agentTimeoutMs / 60000)} min`);
        this.#kill(rec);
      }, this.agentTimeoutMs);
      rec.timer.unref?.();
    }
    this.live.set(agent.id, rec);
    board.setOrchestrator({ live: this.live.size, spawned: o.spawned + 1, ideasSpawned: o.ideasSpawned + (role === 'researcher' ? 1 : 0), idle: false });
    this.emit('spawned', { agent, role, card });
    handle.exited.then(
      (res) => this.#exited(rec, res ?? {}),
      (err) => this.#exited(rec, { code: -1, error: err?.message ?? String(err) }),
    );
  }

  /** An agent reports what its session has cost so far; the board keeps the sum over all agents. */
  #cost(rec, total) {
    if (!(total > rec.costUsd)) return;
    const o = this.board.state.orchestrator;
    this.board.setOrchestrator({ costUsd: Math.round((o.costUsd + total - rec.costUsd) * 10000) / 10000 });
    rec.costUsd = total;
  }

  #exited(rec, res) {
    const { board } = this;
    const { agent } = rec;
    clearTimeout(rec.timer);
    clearTimeout(rec.graceTimer);
    this.live.delete(agent.id);
    this.#cost(rec, res.costUsd);
    const o = board.state.orchestrator;
    const patch = { live: this.live.size };

    // An agent that never made a single board call did not really start
    // (command missing, not logged in, MCP not reachable). Don't burn through
    // the budget retrying blindly: back off, and stop after three in a row.
    const neverShowedUp = agent.calls === 0;
    // Ctrl+C in the terminal: the user is stopping the run, the agent did not fail.
    const interrupted = INTERRUPTED.has(res.code);
    let delay = 0;
    if (neverShowedUp && agent.role === 'researcher') patch.ideasSpawned = Math.max(0, o.ideasSpawned - 1);
    // It worked on the board but was stopped before it finished a turn, so it
    // never said what it cost: the total on the board is missing this agent.
    if (!neverShowedUp && rec.costUsd === 0 && o.costUsd > 0) patch.uncosted = o.uncosted + 1;
    // An agent we killed ourselves did not fail to launch.
    if (neverShowedUp && !this.stopped && !rec.killed && !interrupted) {
      this.launchFailures++;
      delay = this.retryDelayMs * this.launchFailures;
      if (this.launchFailures >= 3) {
        patch.paused = true;
        patch.error = `Agents exit without ever contacting the board${res.error ? ` — ${res.error}` : res.code != null ? ` (exit code ${res.code})` : ''}. Check the agent command (and try another --permissions mode), then resume.`;
        this.launchFailures = 0;
      }
    } else if (!neverShowedUp) this.launchFailures = 0;

    board.setOrchestrator(patch);
    // While shutting down we kill the agents ourselves. Leave their cards as they
    // are: the next start reopens them without counting it against the card.
    // The same goes for Ctrl+C: it must not use up one of the card's retries.
    if (interrupted) board.agentGone(agent.id, 'interrupted with Ctrl+C', { restart: true });
    else if (!this.stopped) board.agentGone(agent.id, res.error ? `failed: ${res.error}` : 'process exited');
    this.emit('exited', { agent, ...res });
    this.schedule(delay);
  }

  #kill(rec) {
    if (!rec || rec.killed) return;
    rec.killed = true;
    clearTimeout(rec.timer);
    clearTimeout(rec.graceTimer);
    rec.handle.kill();
  }

  /**
   * The Shut down button: stop spawning and kill every live agent together with
   * everything it started. The board stays up; resuming starts fresh agents, and
   * the cards they held reopen without counting as a retry.
   */
  shutdown(reason = 'shut down from the board') {
    this.board.setOrchestrator({ paused: true, error: null });
    const recs = [...this.live.values()];
    for (const rec of recs) {
      this.board.agentGone(rec.agent.id, reason, { restart: true });
      this.#kill(rec);
    }
    this.emit('shutdown', { agents: recs.length, reason });
    return recs.length;
  }

  /** Stop spawning and terminate every live agent (the board process is exiting). */
  stop() {
    this.stopped = true;
    clearTimeout(this.pending);
    this.board.off('event', this.onEvent);
    this.board.off('orchestrator', this.onSettings);
    this.board.off('shutdown', this.onShutdown);
    for (const rec of this.live.values()) this.#kill(rec);
  }
}
