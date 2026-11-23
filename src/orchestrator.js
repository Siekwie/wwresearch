// The orchestrator. Plain code, no model, and deliberately only two jobs:
//
//   1. keep the number of live agents at the value the user set
//   2. react to events: when a proof or follow-up card opens, spawn an agent
//      directly into that card — no queue
//
// It never reads research, never judges ideas, never talks to agents.

import { EventEmitter } from 'node:events';
import { researcherPrompt, cardPrompt, pickLens } from './prompts.js';

const CLOSING = new Set(['proof_submitted', 'derivation_submitted', 'dead_end', 'review_submitted']);

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
   */
  constructor({ board, spawnAgent, target, maxIdeas = 0, lenses = true, agentTimeoutMs = 0, heartbeatMs = 60_000, workspaceFor = () => null, retryDelayMs = 2000, finishGraceMs = 30_000, notes = [] }) {
    super();
    this.board = board;
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

    // Job 2: every open card gets an agent, directly.
    for (const card of this.board.openCards()) {
      if (!card.reservedFor) this.#spawn(card.kind === 'review' ? 'reviewer' : 'followup', card);
    }
    // Job 1: keep the pool full with researchers that go through the queue.
    while (this.live.size < o.target && (o.maxIdeas === 0 || o.ideasSpawned < o.maxIdeas)) this.#spawn('researcher', null);

    const idle = this.live.size === 0 && (o.target === 0 || (o.maxIdeas !== 0 && o.ideasSpawned >= o.maxIdeas));
    if (idle !== o.idle) {
      this.board.setOrchestrator({ idle });
      if (idle) this.emit('idle');
    }
  }

  #spawn(role, card) {
    const { board } = this;
    const o = board.state.orchestrator;
    const agent = board.registerAgent({ role, origin: 'orchestrator', cardId: card?.id ?? null });
    const goal = board.state.project.goal;
    const workspace = this.workspaceFor(agent);
    agent.workspace = workspace;
    const { notes } = this;
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

    let handle;
    try {
      handle = this.spawnAgent({ agent, role, card, prompt, workspace, onActivity });
    } catch (err) {
      handle = { exited: Promise.resolve({ code: -1, error: err.message }), kill() {} };
    }
    const rec = { agent, handle, timer: null, killed: false };
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

  #exited(rec, res) {
    const { board } = this;
    const { agent } = rec;
    clearTimeout(rec.timer);
    clearTimeout(rec.graceTimer);
    this.live.delete(agent.id);
    const o = board.state.orchestrator;
    const patch = { live: this.live.size };
    if (res.costUsd > 0) patch.costUsd = Math.round((o.costUsd + res.costUsd) * 10000) / 10000;

    // An agent that never made a single board call did not really start
    // (command missing, not logged in, MCP not reachable). Don't burn through
    // the budget retrying blindly: back off, and stop after three in a row.
    const neverShowedUp = agent.calls === 0;
    let delay = 0;
    if (neverShowedUp && agent.role === 'researcher') patch.ideasSpawned = Math.max(0, o.ideasSpawned - 1);
    // An agent we killed ourselves did not fail to launch.
    if (neverShowedUp && !this.stopped && !rec.killed) {
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
    if (!this.stopped) board.agentGone(agent.id, res.error ? `failed: ${res.error}` : 'process exited');
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
    this.emit('shutdown', { agents: recs.length });
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
