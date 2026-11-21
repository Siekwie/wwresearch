// The board: single source of truth for queue, cards, findings and agents.
//
// Everything here is synchronous and runs on one thread, which is exactly what
// makes the queue trustworthy: reading the board and claiming a card can never
// interleave between two agents. Research itself happens outside, in parallel.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { rank } from './similarity.js';

export const DEFAULT_CONFIG = {
  turnSeconds: 180, // how long the agent at the head may hold the board
  queueIdleSeconds: 180, // waiting agents that stop polling are dropped
  pollSeconds: 50, // long-poll duration of wait_turn
  cardLeaseMinutes: 60, // active cards without any activity are released
  maxDepth: 6, // longest chain of follow-up cards
  maxReopens: 2, // how often a follow-up/review card is handed to a fresh agent
  similarFlag: 0.28, // "looks related" threshold (hint only)
  similarGate: 0.5, // "looks like a duplicate" threshold (asks for a justification)
};

export const FINDING_KINDS = [
  'result',
  'partial',
  'lemma',
  'observation',
  'obstruction',
  'counterexample',
  'conjecture',
  'technique',
  'refutation',
];
export const CONFIDENCE = ['proven', 'checked', 'likely', 'speculative'];
export const VERDICTS = ['verified', 'refuted', 'inconclusive'];

export class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new BoardError(code, message);
};

function text(value, field, { min = 1, max = 4000, optional = false } = {}) {
  if (value == null || (typeof value === 'string' && !value.trim())) {
    if (optional) return null;
    fail('invalid', `"${field}" is required.`);
  }
  if (typeof value !== 'string') fail('invalid', `"${field}" must be a string.`);
  const v = value.trim();
  if (v.length < min) fail('invalid', `"${field}" is too short (at least ${min} characters).`);
  if (v.length > max)
    fail('invalid', `"${field}" is too long (max ${max} characters). Put long material in a file and reference its path.`);
  return v;
}

function list(value, field) {
  if (value == null) return [];
  if (typeof value === 'string') value = value.split(/[\s,]+/).filter(Boolean);
  if (!Array.isArray(value)) fail('invalid', `"${field}" must be a list.`);
  return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
}

export const short = (s, n = 160) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

const ADJECTIVES = `curious quiet bold patient restless careful stubborn lucid nimble skeptical tidy wandering eager
  gentle rigorous playful sober vivid frugal daring`.split(/\s+/);
const SCIENTISTS = `noether euler gauss curie turing lovelace ramanujan hypatia erdos germain hilbert franklin feynman
  galois kovalevskaya shannon bohr meitner riemann hopper cantor mirzakhani poincare godel fermat`.split(/\s+/);

export class Board extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string|null} [opts.dir]  directory for state.json / events.jsonl (null = in-memory)
   * @param {string} [opts.goal]      research goal (required for a fresh board)
   * @param {string} [opts.title]     short title of the goal
   * @param {object} [opts.config]    overrides for DEFAULT_CONFIG
   * @param {() => number} [opts.now] clock, injectable for tests
   */
  constructor({ dir = null, goal, title, config = {}, now = Date.now, demo = false } = {}) {
    super();
    this.setMaxListeners(0);
    this.dir = dir;
    this.now = now;
    this.tokens = new Map();
    this.resumed = false;
    this.saveTimer = null;

    const file = dir && path.join(dir, 'state.json');
    if (file && fs.existsSync(file)) {
      this.state = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.state.config = { ...DEFAULT_CONFIG, ...this.state.config, ...config };
      for (const a of Object.values(this.state.agents)) this.tokens.set(a.token, a.id);
      this.resumed = true;
    } else {
      const g = text(goal, 'goal', { min: 8, max: 20000 });
      this.state = {
        version: 1,
        project: { goal: g, title: short(title || g.split('\n')[0], 120), createdAt: now(), verified: [], demo },
        config: { ...DEFAULT_CONFIG, ...config },
        orchestrator: { enabled: false, target: 0, paused: false, live: 0, spawned: 0, ideasSpawned: 0, maxIdeas: 0, costUsd: 0, error: null, idle: false },
        seq: { card: 0, finding: 0, agent: 0, event: 0 },
        stats: { boardReads: 0, duplicatesAvoided: 0, turnsExpired: 0 },
        agents: {},
        queue: [],
        cards: {},
        findings: {},
        feed: [],
      };
      if (dir) fs.mkdirSync(dir, { recursive: true });
      this.#event('project_created', { text: `Research started: ${this.state.project.title}` });
    }
  }

  // ---------------------------------------------------------------- plumbing

  get config() {
    return this.state.config;
  }

  #event(type, data = {}) {
    const ev = { seq: ++this.state.seq.event, at: this.now(), type, ...data };
    this.state.feed.push(ev);
    if (this.state.feed.length > 500) this.state.feed.splice(0, this.state.feed.length - 500);
    if (this.dir) {
      try {
        fs.appendFileSync(path.join(this.dir, 'events.jsonl'), `${JSON.stringify(ev)}\n`);
      } catch {
        /* the journal is best effort */
      }
    }
    this.#dirty();
    this.emit('event', ev);
    return ev;
  }

  #dirty() {
    this.emit('change');
    if (!this.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 150);
    this.saveTimer.unref?.();
  }

  /** Write state.json now (atomic). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.dir) return;
    const file = path.join(this.dir, 'state.json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, file);
  }

  #agentName() {
    const taken = new Set(Object.values(this.state.agents).map((a) => a.name));
    for (let i = 0; i < 50; i++) {
      const name = `${ADJECTIVES[crypto.randomInt(ADJECTIVES.length)]}-${SCIENTISTS[crypto.randomInt(SCIENTISTS.length)]}`;
      if (!taken.has(name)) return name;
    }
    return `agent-${this.state.seq.agent + 1}`;
  }

  #auth(token) {
    const id = typeof token === 'string' ? this.tokens.get(token.trim()) : null;
    const agent = id && this.state.agents[id];
    if (!agent) fail('unknown_token', 'Unknown agent token. Use the token you received from join_queue or enter_card.');
    if (agent.state === 'finished')
      fail('finished', `Your card ${agent.cardId} is closed. One agent, one card — you are done. Stop now.`);
    if (agent.state === 'gone')
      fail('gone', `This agent was released (${agent.endReason || 'inactive'}). Stop now; do not continue this card.`);
    agent.lastSeenAt = this.now();
    agent.calls++;
    return agent;
  }

  #refs(value, field, { findingsOnly = false } = {}) {
    const ids = list(value, field).map((v) => v.toUpperCase());
    const unknown = ids.filter((id) => !(this.state.findings[id] || (!findingsOnly && this.state.cards[id])));
    if (unknown.length)
      fail('invalid', `"${field}" references unknown ids: ${unknown.join(', ')}. Use ids exactly as shown on the board (F-… for findings${findingsOnly ? '' : ', C-… for cards'}).`);
    return ids;
  }

  // ------------------------------------------------------------------ agents

  /**
   * Register an agent. The orchestrator calls this before spawning a process so
   * it can hand the token to the new agent; manual agents get registered
   * implicitly by join_queue / enter_card.
   */
  registerAgent({ role = 'researcher', origin = 'manual', name, cardId = null } = {}) {
    const id = `A-${++this.state.seq.agent}`;
    const agent = {
      id,
      name: name ? short(name, 40) : this.#agentName(),
      token: `wwr_${crypto.randomBytes(12).toString('hex')}`,
      role,
      origin,
      state: 'new', // new → queued → turn → working → finished | gone
      cardId: null,
      idea: null,
      calls: 0, // authenticated board calls — 0 means the agent never showed up
      createdAt: this.now(),
      lastSeenAt: this.now(),
      endedAt: null,
      endReason: null,
    };
    if (cardId) {
      const card = this.state.cards[cardId];
      if (!card || card.status !== 'open') fail('unavailable', `${cardId} is not open.`);
      if (card.reservedFor) fail('unavailable', `${cardId} is already reserved.`);
      card.reservedFor = id;
      agent.cardId = cardId;
    }
    this.state.agents[id] = agent;
    this.tokens.set(agent.token, id);
    this.#dirty();
    return agent;
  }

  /** An agent disappeared (process exit, lease expiry, restart). Releases whatever it held. */
  agentGone(agentId, reason = 'left') {
    const agent = this.state.agents[agentId];
    if (!agent || agent.state === 'finished' || agent.state === 'gone') return;
    const qi = this.state.queue.findIndex((e) => e.agentId === agentId);
    if (qi !== -1) this.state.queue.splice(qi, 1);
    const card = this.state.cards[agent.cardId];
    agent.state = 'gone';
    agent.endedAt = this.now();
    agent.endReason = reason;
    this.#event('agent_gone', { agentId, text: `${agent.name} left (${reason})` });
    if (card) {
      if (card.reservedFor === agentId) card.reservedFor = null;
      if (card.agentId === agentId && card.status === 'active') this.#abandon(card, agent, reason);
    }
    if (qi !== -1) this.emit('queue');
  }

  #abandon(card, agent, reason) {
    card.notes.push({ at: this.now(), system: true, text: `${agent.name} left without closing this card (${reason}).` });
    const retry = (card.kind === 'review' || card.kind === 'followup') && card.reopens < this.config.maxReopens;
    if (retry) {
      card.status = 'open';
      card.agentId = null;
      card.reopens++;
      this.#event('card_opened', { cardId: card.id, kind: card.kind, reopened: true, text: `${card.id} reopened for a fresh agent` });
    } else {
      card.status = 'abandoned';
      card.closedAt = this.now();
      if (card.kind === 'review') {
        const parent = this.state.cards[card.parentId];
        if (parent && parent.proofStatus === 'in_review') parent.proofStatus = 'unreviewed';
      }
      this.#event('card_abandoned', { cardId: card.id, text: `${card.id} abandoned: ${card.title}` });
    }
  }

  // ------------------------------------------------------------------- queue

  #entry(agentId) {
    return this.state.queue.find((e) => e.agentId === agentId);
  }

  joinQueue({ token, idea, name } = {}) {
    idea = text(idea, 'idea', { min: 12, max: 800 });
    const agent = token ? this.#auth(token) : this.registerAgent({ role: 'researcher', origin: 'manual', name });
    if (agent.role !== 'researcher')
      fail('wrong_role', 'You were spawned directly into a card. Call enter_card — the queue is only for new ideas.');
    if (agent.cardId) fail('has_card', `You already work on ${agent.cardId}. One agent, one card.`);
    let entry = this.#entry(agent.id);
    if (entry) {
      entry.idea = idea;
      entry.lastPollAt = this.now();
    } else {
      entry = { agentId: agent.id, idea, joinedAt: this.now(), lastPollAt: this.now(), turnStartedAt: null, similar: [], gateWarned: false };
      this.state.queue.push(entry);
      this.#event('queue_joined', { agentId: agent.id, text: `${agent.name} queued an idea: ${short(idea, 110)}` });
    }
    agent.state = entry.turnStartedAt ? 'turn' : 'queued';
    agent.idea = idea;
    this.#dirty();
    return { agent, position: this.state.queue.indexOf(entry) + 1 };
  }

  #turn(entry) {
    const agent = this.state.agents[entry.agentId];
    if (!entry.turnStartedAt) {
      entry.turnStartedAt = this.now();
      entry.similar = this.similarCards(entry.idea, 5);
      agent.state = 'turn';
      this.state.stats.boardReads++;
      this.#event('turn_started', { agentId: agent.id, text: `${agent.name} is reading the board` });
    }
    const left = Math.max(0, Math.round(this.config.turnSeconds - (this.now() - entry.turnStartedAt) / 1000));
    return { status: 'your_turn', agent, idea: entry.idea, similar: entry.similar, secondsLeft: left, board: this.digest() };
  }

  /** Non-blocking: where is this agent in the queue? Delivers the board if it is at the head. */
  peekTurn(token) {
    const agent = this.#auth(token);
    const entry = this.#entry(agent.id);
    if (!entry) {
      if (agent.cardId) fail('has_card', `You already hold ${agent.cardId}. Work on it — no need to wait.`);
      fail('not_queued', 'You are not in the queue (your turn may have expired). Call join_queue again with your idea.');
    }
    entry.lastPollAt = this.now();
    const index = this.state.queue.indexOf(entry);
    if (index === 0) return this.#turn(entry);
    return { status: 'waiting', agent, position: index + 1, ahead: index };
  }

  /**
   * Long-poll until the agent reaches the head of the queue (or the timeout hits).
   * Waiting agents receive nothing but their position — the board is only
   * delivered to the head, so nobody pays tokens for a board that is about to change.
   */
  async waitTurn(token, { timeoutMs = this.config.pollSeconds * 1000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = this.peekTurn(token);
      const remaining = deadline - Date.now();
      if (res.status === 'your_turn' || remaining <= 0 || signal?.aborted) return res;
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.off('queue', done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(remaining, 10_000));
        this.on('queue', done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }

  #head(token) {
    const agent = this.#auth(token);
    const entry = this.state.queue[0];
    if (!entry || entry.agentId !== agent.id || !entry.turnStartedAt) {
      if (this.#entry(agent.id)) fail('not_your_turn', 'It is not your turn yet. Call wait_turn until you receive the board.');
      if (agent.cardId) fail('has_card', `You already hold ${agent.cardId}. One agent, one card.`);
      fail('not_queued', 'You are not in the queue (your turn may have expired). Call join_queue again with your idea.');
    }
    return { agent, entry };
  }

  /** The head of the queue creates and claims a card. Ends its turn. */
  claimCard({ token, title, approach, different_because, pivoted_from, builds_on } = {}) {
    const { agent, entry } = this.#head(token);
    title = text(title, 'title', { min: 4, max: 140 });
    approach = text(approach, 'approach', { min: 20, max: 2000 });
    const differentBecause = text(different_because, 'different_because', { optional: true, max: 600 });
    const buildsOn = this.#refs(builds_on, 'builds_on');
    let pivotedFrom = pivoted_from ? String(pivoted_from).trim().toUpperCase() : null;
    if (pivotedFrom && !this.state.cards[pivotedFrom]) pivotedFrom = null;

    const similar = this.similarCards(`${title}. ${approach}`, 3);
    const top = similar[0];
    if (top && top.score >= this.config.similarGate && !differentBecause) {
      entry.gateWarned = true;
      this.#dirty();
      return { claimed: false, similar };
    }

    // Did the board redirect this agent away from a duplicate?
    const original = entry.similar[0];
    const lexicalPivot =
      original && original.score >= this.config.similarGate && !similar.some((s) => s.id === original.id && s.score >= this.config.similarGate);
    const pivoted = Boolean(pivotedFrom) || lexicalPivot || (entry.gateWarned && !differentBecause);
    if (pivoted) {
      this.state.stats.duplicatesAvoided++;
      pivotedFrom ??= original?.id ?? null;
    }

    const card = this.#createCard({ kind: 'idea', title, approach, status: 'active', agent });
    Object.assign(card, { originalIdea: entry.idea, differentBecause, flaggedSimilar: Boolean(top && top.score >= this.config.similarGate), pivotedFrom: pivoted ? pivotedFrom : null, buildsOn });
    this.state.queue.shift();
    agent.state = 'working';
    agent.cardId = card.id;
    this.#event('card_claimed', {
      agentId: agent.id,
      cardId: card.id,
      pivoted,
      text: `${agent.name} claimed ${card.id}: ${card.title}${pivoted ? ' (pivoted away from a duplicate)' : ''}`,
    });
    this.emit('queue');
    return { claimed: true, card, pivoted };
  }

  /** Give up the turn (or the place in the queue). Optionally re-queue at the back with a new idea. */
  passTurn({ token, new_idea } = {}) {
    const agent = this.#auth(token);
    const index = this.state.queue.findIndex((e) => e.agentId === agent.id);
    if (index === -1) fail('not_queued', 'You are not in the queue.');
    this.state.queue.splice(index, 1);
    agent.state = 'new';
    this.#event('turn_passed', { agentId: agent.id, text: `${agent.name} passed` });
    this.emit('queue');
    if (new_idea) return { requeued: true, ...this.joinQueue({ token, idea: new_idea }) };
    return { requeued: false, agent };
  }

  // ------------------------------------------------------------------- cards

  #createCard({ kind, title, approach, status, agent = null, parent = null }) {
    const id = `C-${++this.state.seq.card}`;
    const now = this.now();
    const card = {
      id,
      kind, // idea | followup | review
      title: short(title, 140),
      approach,
      status, // open | active | proof | derivation | dead_end | reviewed | abandoned
      proofStatus: null, // in_review | verified | refuted | inconclusive | unreviewed
      parentId: parent?.id ?? null,
      childIds: [],
      depth: parent ? parent.depth + (kind === 'followup' ? 1 : 0) : 0,
      agentId: agent?.id ?? null,
      reservedFor: null,
      reopens: 0,
      createdAt: now,
      claimedAt: agent ? now : null,
      closedAt: null,
      lastActivityAt: now,
      notes: [],
      findingIds: [],
      outcome: null,
    };
    this.state.cards[id] = card;
    if (parent) parent.childIds.push(id);
    return card;
  }

  openCards() {
    return Object.values(this.state.cards).filter((c) => c.status === 'open');
  }

  /**
   * Enter an open follow-up or review card — the path for agents that are
   * spawned directly into a card, bypassing the queue.
   */
  enterCard({ token, card_id } = {}) {
    let agent = token ? this.#auth(token) : null;
    let card;
    if (agent) {
      if (agent.role === 'researcher')
        fail('wrong_role', 'Researchers get a card through the queue: join_queue → wait_turn → claim_card.');
      card = this.state.cards[agent.cardId];
      if (!card) fail('unavailable', 'No card is assigned to this token.');
      if (card.agentId === agent.id && card.status === 'active') return { agent, card, briefing: this.#briefing(card) };
      if (card.status !== 'open' || (card.reservedFor && card.reservedFor !== agent.id))
        fail('unavailable', `${card.id} is no longer available (status: ${card.status}). Stop now.`);
    } else {
      const wanted = card_id ? String(card_id).trim().toUpperCase() : null;
      card = wanted ? this.state.cards[wanted] : this.openCards().find((c) => !c.reservedFor);
      if (!card) fail('none_open', wanted ? `There is no card ${wanted}.` : 'No open card is waiting for an agent right now.');
      if (card.status !== 'open') fail('unavailable', `${card.id} is not open (status: ${card.status}).`);
      if (card.reservedFor) fail('unavailable', `${card.id} is reserved for an agent that is being spawned.`);
      agent = this.registerAgent({ role: card.kind === 'review' ? 'reviewer' : 'followup', origin: 'manual' });
    }
    const now = this.now();
    Object.assign(card, { status: 'active', agentId: agent.id, reservedFor: null, claimedAt: now, lastActivityAt: now });
    agent.state = 'working';
    agent.cardId = card.id;
    this.#event('card_entered', { agentId: agent.id, cardId: card.id, text: `${agent.name} entered ${card.id}: ${card.title}` });
    return { agent, card, briefing: this.#briefing(card) };
  }

  #briefing(card) {
    const parent = this.state.cards[card.parentId];
    const base = { kind: card.kind, goal: this.state.project.goal, parentId: parent?.id ?? null, previousNotes: card.notes.slice(-20) };
    if (!parent) return base;
    if (card.kind === 'review') {
      // The reviewer sees the submitted proof — never the author's scratch notes.
      const o = parent.outcome;
      return { ...base, claim: o.claim, proof: o.proof, artifacts: o.artifacts, assumptions: o.assumptions, authorCardTitle: parent.title };
    }
    const o = parent.outcome;
    return {
      ...base,
      parentTitle: parent.title,
      parentApproach: parent.approach,
      established: o.established,
      nextStep: o.nextStep,
      openQuestions: o.openQuestions,
      parentFindings: parent.findingIds.map((id) => this.state.findings[id]),
      lineage: this.lineage(parent.id),
    };
  }

  lineage(cardId) {
    const chain = [];
    for (let c = this.state.cards[cardId]; c; c = this.state.cards[c.parentId]) chain.unshift({ id: c.id, title: c.title, status: c.status });
    return chain;
  }

  #working(token, kinds) {
    const agent = this.#auth(token);
    const card = this.state.cards[agent.cardId];
    if (!card || card.agentId !== agent.id || card.status !== 'active')
      fail('no_card', agent.role === 'researcher' ? 'You have no card yet. Go through the queue first: join_queue → wait_turn → claim_card.' : 'Call enter_card first.');
    if (kinds && !kinds.includes(card.kind))
      fail('wrong_card', card.kind === 'review' ? 'This is a review card. Finish it with submit_review.' : 'This is not a review card. Finish it with submit_proof, submit_derivation or report_dead_end.');
    card.lastActivityAt = this.now();
    return { agent, card };
  }

  note({ token, text: body } = {}) {
    const { agent, card } = this.#working(token);
    body = text(body, 'text', { max: 4000 });
    card.notes.push({ at: this.now(), agentId: agent.id, text: body });
    this.#event('note', { agentId: agent.id, cardId: card.id, text: `${card.id}: ${short(body, 140)}` });
    return { card, count: card.notes.length };
  }

  #addFinding(card, agent, { kind, statement, detail = null, confidence, buildsOn = [], contradicts = [], auto = false }) {
    const id = `F-${++this.state.seq.finding}`;
    const finding = { id, cardId: card.id, agentId: agent?.id ?? null, kind, statement, detail, confidence, buildsOn, contradicts, auto, at: this.now() };
    this.state.findings[id] = finding;
    card.findingIds.push(id);
    this.#event('finding_added', { agentId: agent?.id, cardId: card.id, findingId: id, kind, text: `${id} (${kind}) from ${card.id}: ${short(statement, 130)}` });
    return finding;
  }

  addFinding({ token, statement, kind = 'observation', confidence = 'likely', detail, builds_on, contradicts } = {}) {
    const { agent, card } = this.#working(token);
    statement = text(statement, 'statement', { min: 8, max: 1200 });
    detail = text(detail, 'detail', { optional: true, max: 6000 });
    if (!FINDING_KINDS.includes(kind)) fail('invalid', `"kind" must be one of: ${FINDING_KINDS.join(', ')}.`);
    if (!CONFIDENCE.includes(confidence)) fail('invalid', `"confidence" must be one of: ${CONFIDENCE.join(', ')}.`);
    return this.#addFinding(card, agent, {
      kind,
      statement,
      detail,
      confidence,
      buildsOn: this.#refs(builds_on, 'builds_on'),
      contradicts: this.#refs(contradicts, 'contradicts', { findingsOnly: true }),
    });
  }

  #close(card, agent, status, outcome) {
    card.status = status;
    card.closedAt = this.now();
    card.outcome = outcome;
    agent.state = 'finished';
    agent.endedAt = this.now();
    agent.endReason = status;
  }

  /** Outcome 1 — the goal appears solved. Opens a review card for an independent agent. */
  submitProof({ token, claim, proof, artifacts, assumptions, summary, builds_on } = {}) {
    const { agent, card } = this.#working(token, ['idea', 'followup']);
    claim = text(claim, 'claim', { min: 10, max: 1500 });
    proof = text(proof, 'proof', { min: 40, max: 40000 });
    summary = text(summary, 'summary', { optional: true, max: 3000 });
    assumptions = text(assumptions, 'assumptions', { optional: true, max: 3000 });
    artifacts = list(artifacts, 'artifacts');
    const buildsOn = this.#refs(builds_on, 'builds_on');
    this.#close(card, agent, 'proof', { type: 'proof', claim, proof, artifacts, assumptions, summary });
    card.proofStatus = 'in_review';
    const finding = this.#addFinding(card, agent, { kind: 'result', statement: claim, detail: summary, confidence: 'claimed', buildsOn, auto: true });
    card.outcome.findingId = finding.id;
    this.#event('proof_submitted', { agentId: agent.id, cardId: card.id, text: `${agent.name} submitted a proof on ${card.id}: ${short(claim, 110)}` });
    const review = this.#createCard({
      kind: 'review',
      title: `Review: ${short(claim, 100)}`,
      approach: `Independently check the proof submitted on ${card.id} and write the report for the user.`,
      status: 'open',
      parent: card,
    });
    this.#event('card_opened', { cardId: review.id, kind: 'review', parentId: card.id, text: `${review.id} opened: independent review of ${card.id}` });
    return { card, review };
  }

  /** Outcome 2 — part of the goal is solved, or the approach survived every attempt to refute it. */
  submitDerivation({ token, established, next_step, followup_title, confidence = 'likely', open_questions, summary, builds_on } = {}) {
    const { agent, card } = this.#working(token, ['idea', 'followup']);
    established = text(established, 'established', { min: 10, max: 3000 });
    const nextStep = text(next_step, 'next_step', { min: 10, max: 2000 });
    const openQuestions = text(open_questions, 'open_questions', { optional: true, max: 3000 });
    summary = text(summary, 'summary', { optional: true, max: 3000 });
    if (!CONFIDENCE.includes(confidence)) fail('invalid', `"confidence" must be one of: ${CONFIDENCE.join(', ')}.`);
    const buildsOn = this.#refs(builds_on, 'builds_on');
    this.#close(card, agent, 'derivation', { type: 'derivation', established, nextStep, openQuestions, summary });
    const finding = this.#addFinding(card, agent, { kind: 'partial', statement: established, detail: summary, confidence, buildsOn, auto: true });
    card.outcome.findingId = finding.id;
    this.#event('derivation_submitted', { agentId: agent.id, cardId: card.id, text: `${agent.name} derived a partial result on ${card.id}: ${short(established, 110)}` });
    let followup = null;
    if (card.depth < this.config.maxDepth) {
      followup = this.#createCard({
        kind: 'followup',
        title: text(followup_title, 'followup_title', { optional: true, max: 140 }) ?? `Follow-up: ${short(nextStep, 100)}`,
        approach: nextStep,
        status: 'open',
        parent: card,
      });
      card.outcome.followupId = followup.id;
      this.#event('card_opened', { cardId: followup.id, kind: 'followup', parentId: card.id, text: `${followup.id} opened: follow-up on ${card.id}` });
    }
    return { card, followup };
  }

  /** Outcome 3 — the approach leads nowhere. The reason is the valuable part. */
  reportDeadEnd({ token, why_it_fails, salvageable, summary, builds_on } = {}) {
    const { agent, card } = this.#working(token, ['idea', 'followup']);
    const whyItFails = text(why_it_fails, 'why_it_fails', { min: 10, max: 3000 });
    salvageable = text(salvageable, 'salvageable', { optional: true, max: 2000 });
    summary = text(summary, 'summary', { optional: true, max: 3000 });
    const buildsOn = this.#refs(builds_on, 'builds_on');
    this.#close(card, agent, 'dead_end', { type: 'dead_end', whyItFails, salvageable, summary });
    const finding = this.#addFinding(card, agent, { kind: 'obstruction', statement: whyItFails, detail: salvageable, confidence: 'likely', buildsOn, auto: true });
    card.outcome.findingId = finding.id;
    this.#event('dead_end', { agentId: agent.id, cardId: card.id, text: `${agent.name} hit a dead end on ${card.id}: ${short(whyItFails, 110)}` });
    return { card };
  }

  /** A reviewer (never the author) closes a review card with a verdict and the report for the user. */
  submitReview({ token, verdict, what_was_found, assessment, independent_test, why_independent, flaws } = {}) {
    const { agent, card } = this.#working(token, ['review']);
    if (!VERDICTS.includes(verdict)) fail('invalid', `"verdict" must be one of: ${VERDICTS.join(', ')}.`);
    const whatWasFound = text(what_was_found, 'what_was_found', { min: 20, max: 6000 });
    assessment = text(assessment, 'assessment', { min: 20, max: 8000 });
    const independentTest = text(independent_test, 'independent_test', { min: 20, max: 8000 });
    const whyIndependent = text(why_independent, 'why_independent', { min: 20, max: 6000 });
    flaws = text(flaws, 'flaws', { optional: verdict !== 'refuted', min: 10, max: 6000 });
    const parent = this.state.cards[card.parentId];
    this.#close(card, agent, 'reviewed', { type: 'review', verdict, whatWasFound, assessment, independentTest, whyIndependent, flaws });
    parent.proofStatus = verdict;
    const claimFinding = this.state.findings[parent.outcome.findingId];
    if (claimFinding && verdict !== 'inconclusive') claimFinding.confidence = verdict;
    if (verdict === 'refuted')
      this.#addFinding(card, agent, { kind: 'refutation', statement: flaws, confidence: 'likely', buildsOn: [], contradicts: claimFinding ? [claimFinding.id] : [], auto: true });
    if (verdict === 'verified') this.state.project.verified.push(parent.id);
    const label = { verified: 'VERIFIED', refuted: 'REFUTED', inconclusive: 'inconclusive on' }[verdict];
    this.#event('review_submitted', { agentId: agent.id, cardId: card.id, parentId: parent.id, verdict, text: `${agent.name} ${label} the proof on ${parent.id}: ${short(parent.outcome.claim, 100)}` });
    return { card, parent, verdict };
  }

  // --------------------------------------------------------------- knowledge

  /** Cards most similar to a text (reviews and abandoned cards excluded). */
  similarCards(query, k = 5) {
    const cards = Object.values(this.state.cards).filter((c) => c.kind !== 'review' && c.status !== 'abandoned');
    const docs = cards.map((c) => ({ id: c.id, text: `${c.title}. ${c.approach}` }));
    return rank(query, docs)
      .filter((r) => r.score >= this.config.similarFlag)
      .slice(0, k)
      .map((r) => ({ id: r.id, score: Math.round(r.score * 100) / 100, title: this.state.cards[r.id].title, status: this.state.cards[r.id].status }));
  }

  search({ query, limit = 8 } = {}) {
    query = text(query, 'query', { min: 2, max: 400 });
    limit = Math.min(Math.max(Number(limit) || 8, 1), 25);
    const docs = [
      ...Object.values(this.state.findings).map((f) => ({ id: f.id, text: `${f.statement} ${f.detail ?? ''}` })),
      ...Object.values(this.state.cards)
        .filter((c) => c.kind !== 'review')
        .map((c) => ({ id: c.id, text: `${c.title}. ${c.approach} ${this.#takeaway(c) ?? ''}` })),
    ];
    const needle = query.toLowerCase();
    return rank(query, docs)
      .map((r) => {
        const doc = docs.find((d) => d.id === r.id);
        return { ...r, score: r.score + (doc.text.toLowerCase().includes(needle) ? 0.25 : 0) };
      })
      .filter((r) => r.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => (r.id.startsWith('F-') ? { type: 'finding', ...this.state.findings[r.id] } : { type: 'card', ...this.#line(this.state.cards[r.id]) }));
  }

  #takeaway(c) {
    const o = c.outcome;
    if (c.status === 'abandoned') return 'abandoned before a result — free to retry';
    if (!o) return null;
    if (o.type === 'dead_end') return o.whyItFails;
    if (o.type === 'derivation') return o.established;
    if (o.type === 'proof') {
      const review = c.childIds.map((id) => this.state.cards[id]).find((r) => r.kind === 'review' && r.status === 'reviewed');
      if (c.proofStatus === 'refuted' && review) return `claimed: ${o.claim} — REFUTED: ${review.outcome.flaws}`;
      return o.claim;
    }
    return null;
  }

  #line(c) {
    return {
      id: c.id,
      kind: c.kind,
      status: c.status,
      proofStatus: c.proofStatus,
      title: c.title,
      approach: short(c.approach, 240),
      takeaway: short(this.#takeaway(c), 260) || null,
      parentId: c.parentId,
      followupId: c.outcome?.followupId ?? null,
    };
  }

  /** The compact view of the board that the agent at the head of the queue receives. */
  digest() {
    const cards = Object.values(this.state.cards).filter((c) => c.kind !== 'review');
    const count = (fn) => cards.filter(fn).length;
    return {
      title: this.state.project.title,
      counts: {
        cards: cards.length,
        ideas: count((c) => c.kind === 'idea'),
        active: count((c) => c.status === 'active' || c.status === 'open'),
        proofs: count((c) => c.status === 'proof'),
        verified: count((c) => c.proofStatus === 'verified'),
        refuted: count((c) => c.proofStatus === 'refuted'),
        derivations: count((c) => c.status === 'derivation'),
        deadEnds: count((c) => c.status === 'dead_end'),
        abandoned: count((c) => c.status === 'abandoned'),
        findings: Object.keys(this.state.findings).length,
      },
      cards: cards.map((c) => this.#line(c)).reverse(),
      findings: Object.values(this.state.findings)
        .filter((f) => !f.auto)
        .slice(-25)
        .reverse()
        .map((f) => ({ id: f.id, kind: f.kind, confidence: f.confidence, cardId: f.cardId, statement: short(f.statement, 220) })),
    };
  }

  /** Full detail of one card. A reviewer never sees the scratch notes of the card it reviews. */
  cardDetail(cardId, { token } = {}) {
    const card = this.state.cards[String(cardId ?? '').trim().toUpperCase()];
    if (!card) fail('not_found', `There is no card ${cardId}.`);
    let hideNotes = false;
    if (token) {
      const viewer = this.#auth(token);
      const own = this.state.cards[viewer.cardId];
      hideNotes = own?.kind === 'review' && own.parentId === card.id;
    }
    const review = card.childIds.map((id) => this.state.cards[id]).filter((c) => c.kind === 'review');
    return {
      ...card,
      notes: hideNotes ? [] : card.notes,
      notesHidden: hideNotes,
      agentName: this.state.agents[card.agentId]?.name ?? null,
      findings: card.findingIds.map((id) => this.state.findings[id]),
      lineage: this.lineage(card.id),
      children: card.childIds.map((id) => this.#line(this.state.cards[id])),
      reviews: review.map((r) => ({ id: r.id, status: r.status, outcome: r.outcome, agentName: this.state.agents[r.agentId]?.name ?? null })),
    };
  }

  // ----------------------------------------------------------- housekeeping

  /** Expire stale turns, drop silent queue entries, release cards without activity. */
  tick() {
    const now = this.now();
    let queueChanged = false;
    for (const entry of [...this.state.queue]) {
      const agent = this.state.agents[entry.agentId];
      const expired = entry.turnStartedAt
        ? now - entry.turnStartedAt > this.config.turnSeconds * 1000
        : now - entry.lastPollAt > this.config.queueIdleSeconds * 1000;
      if (!expired) continue;
      this.state.queue.splice(this.state.queue.indexOf(entry), 1);
      agent.state = 'new';
      queueChanged = true;
      if (entry.turnStartedAt) this.state.stats.turnsExpired++;
      this.#event(entry.turnStartedAt ? 'turn_expired' : 'queue_dropped', {
        agentId: agent.id,
        text: entry.turnStartedAt ? `${agent.name}'s turn expired` : `${agent.name} stopped waiting and was dropped from the queue`,
      });
    }
    if (queueChanged) this.emit('queue');
    for (const card of Object.values(this.state.cards)) {
      if (card.status === 'active' && now - card.lastActivityAt > this.config.cardLeaseMinutes * 60_000)
        this.agentGone(card.agentId, `no activity for ${this.config.cardLeaseMinutes} minutes`);
    }
  }

  /** After a restart nobody from the previous run is alive: release everything they held. */
  recover() {
    for (const card of Object.values(this.state.cards)) card.reservedFor = null;
    for (const agent of Object.values(this.state.agents)) {
      if (agent.state !== 'finished' && agent.state !== 'gone') this.agentGone(agent.id, 'board restarted');
    }
    this.state.queue = [];
    Object.assign(this.state.orchestrator, { live: 0, error: null, idle: false });
    this.#dirty();
  }

  setOrchestrator(patch) {
    const o = this.state.orchestrator;
    const before = JSON.stringify(o);
    for (const [k, v] of Object.entries(patch)) if (k in o && v !== undefined) o[k] = v;
    if (patch.target !== undefined) o.target = Math.max(0, Math.min(500, Math.round(Number(patch.target)) || 0));
    if (JSON.stringify(o) !== before) {
      this.#dirty();
      this.emit('orchestrator', o);
    }
    return o;
  }

  /** Everything the UI needs. Tokens never leave the board. */
  snapshot() {
    const s = this.state;
    const agents = {};
    for (const a of Object.values(s.agents)) {
      const { token: _token, ...rest } = a;
      agents[a.id] = rest;
    }
    const cards = {};
    for (const c of Object.values(s.cards)) {
      const { notes, ...rest } = c;
      cards[c.id] = { ...rest, noteCount: notes.length, lastNote: notes.at(-1) ?? null, agentName: s.agents[c.agentId]?.name ?? null };
    }
    return {
      project: s.project,
      config: s.config,
      orchestrator: s.orchestrator,
      stats: s.stats,
      queue: s.queue.map((e, i) => ({
        position: i + 1,
        agentId: e.agentId,
        name: s.agents[e.agentId]?.name,
        idea: e.idea,
        joinedAt: e.joinedAt,
        onTurn: Boolean(e.turnStartedAt),
        turnEndsAt: e.turnStartedAt ? e.turnStartedAt + s.config.turnSeconds * 1000 : null,
      })),
      agents,
      cards,
      findings: s.findings,
      feed: s.feed.slice(-120),
      serverTime: this.now(),
    };
  }
}
