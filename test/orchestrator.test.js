import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../src/board.js';
import { createMcp } from '../src/mcp.js';
import { createServer } from '../src/server.js';
import { Orchestrator } from '../src/orchestrator.js';
import { simRunner, DEMO_GOAL, DEMO_IDEAS, APPROACHES } from '../src/demo.js';

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** An in-process agent runner whose agents are controlled by the test. */
function manualRunner() {
  const spawned = [];
  const spawnAgent = (ctx) => {
    let exit;
    const exited = new Promise((r) => (exit = r));
    const rec = { ...ctx, exit, killed: false };
    spawned.push(rec);
    return { exited, kill: () => ((rec.killed = true), exit({ code: 143 })) };
  };
  return { spawned, spawnAgent };
}

const PROOF = { claim: 'The statement holds for all cases.', proof: 'A complete argument that covers every case in detail, step by step.' };

test('job 1: the orchestrator keeps the configured number of agents alive', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 3, lenses: true }).start();
  await until(() => spawned.length === 3);
  assert.ok(spawned.every((s) => s.role === 'researcher'));
  assert.match(spawned[0].prompt, new RegExp(spawned[0].agent.token), 'each agent is handed its own token');
  assert.notEqual(spawned[0].prompt, spawned[1].prompt.replace(spawned[1].agent.token, spawned[0].agent.token), 'researchers get different thinking nudges');

  // an agent that did its job and exits is replaced
  const a = spawned[0];
  board.joinQueue({ token: a.agent.token, idea: 'A first idea for the statement.' });
  board.peekTurn(a.agent.token);
  board.claimCard({ token: a.agent.token, title: 'First idea', approach: 'Try the first idea carefully and in detail.' });
  board.reportDeadEnd({ token: a.agent.token, why_it_fails: 'It does not generalise beyond the base case.' });
  a.exit({ code: 0 });
  await until(() => spawned.length === 4);
  assert.equal(board.state.orchestrator.live, 3);

  // the user changes the number: up spawns, down lets agents run out
  board.setOrchestrator({ target: 5 });
  await until(() => spawned.length === 6);
  board.setOrchestrator({ target: 1 });
  spawned[1].exit({ code: 0 });
  spawned[2].exit({ code: 0 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawned.length, 6, 'no replacement while above the target');
  assert.equal(board.state.orchestrator.live, 3);

  board.setOrchestrator({ paused: true, target: 10 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawned.length, 6, 'nothing is spawned while paused');
  orch.stop();
  assert.ok(spawned.slice(3).every((s) => s.killed));
});

test('job 2: proof and follow-up cards get an agent directly, without the queue', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 1, maxIdeas: 1 }).start();
  await until(() => spawned.length === 1);
  const author = spawned[0].agent;
  board.joinQueue({ token: author.token, idea: 'A first idea for the statement.' });
  board.peekTurn(author.token);
  board.claimCard({ token: author.token, title: 'First idea', approach: 'Try the first idea carefully and in detail.' });
  const { followup } = board.submitDerivation({ token: author.token, established: 'The base case holds.', next_step: 'Extend the base case to all cases.' });

  // even before the author's process is gone, the follow-up card has its agent
  await until(() => spawned.length === 2);
  assert.equal(spawned[1].role, 'followup');
  assert.equal(spawned[1].card.id, followup.id);
  assert.match(spawned[1].prompt, /enter_card/);
  assert.equal(board.state.queue.length, 0);
  spawned[0].exit({ code: 0 });

  const second = board.enterCard({ token: spawned[1].agent.token });
  assert.equal(second.card.id, followup.id);
  const { card, review } = board.submitProof({ token: spawned[1].agent.token, ...PROOF });
  await until(() => spawned.length === 3);
  assert.equal(spawned[2].role, 'reviewer');
  assert.equal(spawned[2].card.id, review.id);
  assert.notEqual(spawned[2].agent.id, spawned[1].agent.id, 'the reviewer is never the author');
  spawned[1].exit({ code: 0 });

  // a reviewer that dies is replaced by a fresh one
  board.enterCard({ token: spawned[2].agent.token });
  spawned[2].exit({ code: 1, error: 'crashed' });
  await until(() => spawned.length === 4);
  assert.equal(spawned[3].role, 'reviewer');
  board.enterCard({ token: spawned[3].agent.token });
  board.submitReview({ token: spawned[3].agent.token, verdict: 'verified', what_was_found: 'A proof of the statement.', assessment: 'Checked every step; it holds.', independent_test: 'Run an exhaustive check for small cases.', why_independent: 'It does not use the argument at all.' });
  let idle = false;
  orch.on('idle', () => (idle = true));
  spawned[3].exit({ code: 0 });
  await until(() => idle);
  assert.equal(board.state.cards[card.id].proofStatus, 'verified');
  assert.equal(spawned.length, 4, 'the idea budget is respected');
  orch.stop();
});

test('an agent that closed its card but keeps running is stopped after a grace period', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 1, maxIdeas: 1, finishGraceMs: 20 }).start();
  await until(() => spawned.length === 1);
  const a = spawned[0].agent;
  board.joinQueue({ token: a.token, idea: 'A first idea for the statement.' });
  board.peekTurn(a.token);
  board.claimCard({ token: a.token, title: 'First idea', approach: 'Try the first idea carefully and in detail.' });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(spawned[0].killed, false, 'a working agent is left alone');
  board.reportDeadEnd({ token: a.token, why_it_fails: 'It does not generalise beyond the base case.' });
  await until(() => spawned[0].killed);
  await until(() => board.state.orchestrator.live === 0);
  assert.equal(board.state.cards['C-1'].status, 'dead_end', 'its result stands');
  orch.stop();
});

test('stopping the orchestrator leaves cards in place for the next start', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 1 }).start();
  await until(() => spawned.length === 1);
  const a = spawned[0].agent;
  board.joinQueue({ token: a.token, idea: 'A first idea for the statement.' });
  board.peekTurn(a.token);
  board.claimCard({ token: a.token, title: 'First idea', approach: 'Try the first idea carefully and in detail.' });
  orch.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned[0].killed, true);
  assert.equal(board.state.cards['C-1'].reopens, 0);
  board.recover();
  assert.equal(board.state.cards['C-1'].status, 'open');
  assert.equal(board.state.cards['C-1'].reopens, 0);
});

test('agents that never reach the board pause the orchestrator instead of burning the budget', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  let spawns = 0;
  const spawnAgent = () => (spawns++, { exited: Promise.resolve({ code: 127, error: 'command not found: claude' }), kill() {} });
  const orch = new Orchestrator({ board, spawnAgent, target: 2, maxIdeas: 50, retryDelayMs: 1 }).start();
  await until(() => board.state.orchestrator.paused);
  assert.match(board.state.orchestrator.error, /without ever contacting the board — command not found: claude/);
  assert.ok(spawns <= 6, `spawned ${spawns} times`);
  assert.equal(board.state.orchestrator.ideasSpawned, 0, 'failed launches do not count as ideas');
  const before = spawns;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(spawns, before);
  orch.stop();
});

test('the demo swarm runs to completion against the real server', async () => {
  const board = new Board({ goal: DEMO_GOAL, demo: true });
  const srv = createServer({ board, mcp: createMcp(board), port: 0 });
  const { url } = await srv.listen();
  const orch = new Orchestrator({ board, spawnAgent: simRunner({ apiUrl: url, speed: 400 }), target: 5, maxIdeas: DEMO_IDEAS, lenses: false });
  const idle = new Promise((r) => orch.on('idle', r));
  orch.start();
  await idle;
  orch.stop();
  await srv.close();

  const cards = Object.values(board.state.cards);
  const ideas = cards.filter((c) => c.kind === 'idea');
  assert.equal(ideas.length, APPROACHES.length, 'every scripted approach was explored exactly once');
  assert.equal(new Set(ideas.map((c) => c.title)).size, ideas.length, 'no two agents worked on the same idea');
  assert.equal(board.state.stats.duplicatesAvoided, 7);
  assert.equal(cards.filter((c) => c.proofStatus === 'verified').length, 5);
  assert.equal(cards.filter((c) => c.proofStatus === 'refuted').length, 1);
  assert.equal(cards.filter((c) => c.status === 'dead_end').length, 4);
  assert.equal(cards.filter((c) => ['active', 'open'].includes(c.status)).length, 0);
  // nobody reviewed their own work
  for (const r of cards.filter((c) => c.kind === 'review')) assert.notEqual(r.agentId, board.state.cards[r.parentId].agentId);
  // one agent, one card
  const perAgent = new Map();
  for (const c of cards) perAgent.set(c.agentId, (perAgent.get(c.agentId) ?? 0) + 1);
  assert.ok([...perAgent.values()].every((n) => n === 1));
  // the repaired proof builds on the refutation of the broken one
  const refutation = Object.values(board.state.findings).find((f) => f.kind === 'refutation');
  assert.ok(cards.some((c) => c.buildsOn?.includes(refutation.id)));
});

test('shut down kills every live agent, hands cards on and spawns nothing until started again', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 2, retryDelayMs: 1 }).start();
  await until(() => spawned.length === 2);
  const author = spawned[0].agent;
  board.joinQueue({ token: author.token, idea: 'A first idea for the statement.' });
  board.peekTurn(author.token);
  board.claimCard({ token: author.token, title: 'First idea', approach: 'Try the first idea carefully and in detail.' });
  const { followup } = board.submitDerivation({ token: author.token, established: 'The base case holds.', next_step: 'Extend the base case to all cases.' });
  spawned[0].exit({ code: 0 });
  await until(() => spawned.some((s) => s.role === 'followup'));
  const worker = spawned.find((s) => s.role === 'followup');
  board.enterCard({ token: worker.agent.token });
  await until(() => board.state.orchestrator.live === 2);

  let stopped = null;
  orch.on('shutdown', (e) => (stopped = e.agents));
  board.emit('shutdown'); // what POST /api/shutdown does
  assert.equal(stopped, 2);
  assert.ok(spawned.slice(1).every((s) => s.killed), 'every live agent was killed');
  await until(() => board.state.orchestrator.live === 0);
  const o = board.state.orchestrator;
  assert.equal(o.paused, true);
  assert.equal(o.error, null, 'agents we killed are not reported as failed launches');
  assert.equal(board.state.agents[worker.agent.id].endReason, 'shut down from the board');
  const card = board.state.cards[followup.id];
  assert.equal(card.status, 'open', 'the follow-up card waits for a fresh agent');
  assert.equal(card.reopens, 0, 'a shutdown does not use up a retry');
  await new Promise((r) => setTimeout(r, 30));
  const count = spawned.length;
  assert.equal(count, 3, 'nothing is spawned while shut down');

  board.setOrchestrator({ paused: false });
  await until(() => spawned.length >= count + 2);
  assert.ok(spawned.slice(count).some((s) => s.role === 'followup' && s.card.id === followup.id), 'starting again picks the card up');
  orch.stop();
});
