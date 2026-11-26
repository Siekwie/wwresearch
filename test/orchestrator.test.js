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
  // the verified proof gets a result checker, also directly
  await until(() => spawned.length === 5);
  assert.equal(spawned[4].role, 'checker');
  board.enterCard({ token: spawned[4].agent.token });
  board.submitResult({ token: spawned[4].agent.token, finished: false, summary: '- The statement is proven for the base case only.', missing: 'The general case is still open.' });
  spawned[4].exit({ code: 0 });
  await until(() => idle);
  assert.equal(board.state.cards[card.id].proofStatus, 'verified');
  assert.equal(spawned.length, 5, 'the idea budget is respected');
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

test('output from an agent busy with a long run keeps its card; a silent agent is released and killed', async () => {
  let t = 1_000_000;
  const board = new Board({ goal: 'Find a proof of the statement.', config: { cardLeaseMinutes: 60 }, now: () => t });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 1, maxIdeas: 1, heartbeatMs: 0 }).start();
  await until(() => spawned.length === 1);
  const a = spawned[0];
  board.joinQueue({ token: a.agent.token, idea: 'A first idea for the statement.' });
  board.peekTurn(a.agent.token);
  board.claimCard({ token: a.agent.token, title: 'First idea', approach: 'Try the first idea carefully and in detail.' });

  // three hours of waiting on a search, printing a heartbeat now and then
  for (let i = 0; i < 6; i++) {
    t += 30 * 60_000;
    a.onActivity();
    board.tick();
  }
  assert.equal(board.state.cards['C-1'].status, 'active');
  assert.equal(a.killed, false);

  // then the process goes quiet: the lease runs out and the process is stopped
  t += 61 * 60_000;
  board.tick();
  await until(() => a.killed);
  assert.equal(board.state.cards['C-1'].status, 'open');
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

test('a verified proof gets a checker; when it finds the goal reached every agent is stopped', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 2, retryDelayMs: 1 }).start();
  await until(() => spawned.length === 2);
  const [author, other] = spawned;
  board.joinQueue({ token: author.agent.token, idea: 'A first idea for the statement.' });
  board.peekTurn(author.agent.token);
  board.claimCard({ token: author.agent.token, title: 'First idea', approach: 'Try the first idea carefully and in detail.' });
  board.submitProof({ token: author.agent.token, ...PROOF });
  author.exit({ code: 0 });
  await until(() => spawned.some((s) => s.role === 'reviewer'));
  const reviewer = spawned.find((s) => s.role === 'reviewer');
  board.enterCard({ token: reviewer.agent.token });
  board.submitReview({ token: reviewer.agent.token, verdict: 'verified', what_was_found: 'A complete proof of the statement.', assessment: 'Every step holds and was re-derived.', independent_test: 'Check all cases by brute force.', why_independent: 'Brute force shares no reasoning with the proof.' });
  reviewer.exit({ code: 0 });
  await until(() => spawned.some((s) => s.role === 'checker'));
  const checker = spawned.find((s) => s.role === 'checker');
  assert.match(checker.prompt, /result checker/);
  board.enterCard({ token: checker.agent.token });

  let reason = null;
  orch.on('shutdown', (e) => (reason = e.reason));
  board.submitResult({ token: checker.agent.token, finished: true, summary: '- C-1 proves the statement (verified).' });
  assert.equal(reason, 'the goal is reached');
  assert.equal(board.state.orchestrator.paused, true);
  assert.ok(other.killed && checker.killed, 'every live agent was stopped');
  const count = spawned.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawned.length, count, 'nothing new is spawned');
  orch.stop();
});

test('the demo swarm runs to completion against the real server', async () => {
  const board = new Board({ goal: DEMO_GOAL, demo: true });
  const srv = createServer({ board, mcp: createMcp(board), port: 0 });
  const { url } = await srv.listen();
  const orch = new Orchestrator({ board, spawnAgent: simRunner({ apiUrl: url, speed: 400 }), target: 5, maxIdeas: DEMO_IDEAS, lenses: false, stopWhenFinished: false });
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
  // the first verified proof opened a result check, whose agent found the goal reached
  assert.equal(board.state.project.finished?.by, 'agent');
  assert.equal(board.state.cards[board.state.project.finished.cardId].kind, 'check');
  assert.match(board.state.project.result.summary, /verified/);
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

test('the agent count is a hard cap: after a restart reopened cards wait for a free slot', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  // the previous run: five agents, each in the middle of a card
  for (let i = 1; i <= 5; i++) {
    const { agent } = board.joinQueue({ idea: `Idea number ${i} for the statement, unlike the others.` });
    board.peekTurn(agent.token);
    board.claimCard({ token: agent.token, title: `Idea ${i}`, approach: `Approach number ${i}, described in enough detail.`, different_because: 'It is a different idea.' });
  }
  board.recover(); // the board is started again
  assert.equal(board.openCards().length, 5);

  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 2, maxIdeas: 5 });
  board.setOrchestrator({ ideasSpawned: 5 });
  orch.start();
  await until(() => spawned.length === 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawned.length, 2, 'two agents, not one per reopened card');
  assert.deepEqual(spawned.map((s) => s.card.id), ['C-1', 'C-2'], 'oldest cards first');

  // a card is closed: its agent no longer counts, the next card gets its agent at once
  board.enterCard({ token: spawned[0].agent.token });
  board.reportDeadEnd({ token: spawned[0].agent.token, why_it_fails: 'It does not generalise beyond the base case.' });
  await until(() => spawned.length === 3);
  assert.equal(spawned[2].card.id, 'C-3');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawned.length, 3);

  // a proof: its review goes before the research cards that are still waiting
  board.enterCard({ token: spawned[1].agent.token });
  const { review } = board.submitProof({ token: spawned[1].agent.token, ...PROOF });
  await until(() => spawned.length === 4);
  assert.equal(spawned[3].card.id, review.id);

  // the user raises the number: the remaining cards are picked up, and never more than that
  board.setOrchestrator({ target: 4 });
  await until(() => spawned.length === 6);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawned.length, 6);
  assert.equal(board.openCards().filter((c) => !c.reservedFor).length, 0);
  orch.stop();
});

test('costs are added up as agents report them; agents stopped before reporting are counted', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 2, maxIdeas: 2 }).start();
  await until(() => spawned.length === 2);
  const [a, b] = spawned;
  a.onCost(1.5);
  assert.equal(board.state.orchestrator.costUsd, 1.5, 'the cost is on the board before the agent exits');
  a.onCost(2.25); // the session total after its next turn
  assert.equal(board.state.orchestrator.costUsd, 2.25);
  board.joinQueue({ token: a.agent.token, idea: 'A first idea for the statement.' });
  a.exit({ code: 0, costUsd: 2.25 });
  await until(() => board.state.orchestrator.live === 1);
  assert.equal(board.state.orchestrator.costUsd, 2.25, 'the final report is not added a second time');
  assert.equal(board.state.orchestrator.uncosted, 0);

  // b worked on the board, then was stopped in the middle of its first turn
  board.joinQueue({ token: b.agent.token, idea: 'A second idea for the statement.' });
  b.exit({ code: 1 });
  await until(() => board.state.orchestrator.live === 0);
  assert.equal(board.state.orchestrator.costUsd, 2.25);
  assert.equal(board.state.orchestrator.uncosted, 1, 'the total is marked as a lower bound');
  orch.stop();
});

test('Ctrl+C reaching an agent first is an interruption, not a failure of its card', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 1, maxIdeas: 1 }).start();
  await until(() => spawned.length === 1);
  const a = spawned[0];
  board.joinQueue({ token: a.agent.token, idea: 'A first idea for the statement.' });
  board.peekTurn(a.agent.token);
  board.claimCard({ token: a.agent.token, title: 'First idea', approach: 'Try the first idea carefully and in detail.' });
  a.exit({ code: 3221225786, error: 'exit code 3221225786' }); // Windows: the console's Ctrl+C killed the agent
  await until(() => board.state.agents[a.agent.id].state === 'gone');
  assert.equal(board.state.agents[a.agent.id].endReason, 'interrupted with Ctrl+C');
  assert.equal(board.state.cards['C-1'].status, 'open');
  assert.equal(board.state.cards['C-1'].reopens, 0, 'it does not use up a retry');
  orch.stop();
});

test('notes about the machine can be computed for every agent', async () => {
  const board = new Board({ goal: 'Find a proof of the statement.' });
  const { spawned, spawnAgent } = manualRunner();
  const orch = new Orchestrator({ board, spawnAgent, target: 1, notes: () => [`${board.state.orchestrator.target} agents share this machine.`] }).start();
  await until(() => spawned.length === 1);
  assert.match(spawned[0].prompt, /YOUR ENVIRONMENT\n- 1 agents share this machine\./);
  board.setOrchestrator({ target: 2 });
  await until(() => spawned.length === 2);
  assert.match(spawned[1].prompt, /- 2 agents share this machine\./);
  orch.stop();
});
