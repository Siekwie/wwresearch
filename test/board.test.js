import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Board, BoardError } from '../src/board.js';

const GOAL = 'Prove that the square root of two is irrational.';

function setup(config = {}) {
  let t = 1_000_000;
  const board = new Board({ goal: GOAL, config, now: () => t });
  return { board, advance: (ms) => (t += ms) };
}

/** Queue an idea, take the turn and claim a card. */
function claim(board, title, approach, extra = {}) {
  const { agent } = board.joinQueue({ idea: `${title}: ${approach}` });
  assert.equal(board.peekTurn(agent.token).status, 'your_turn');
  const res = board.claimCard({ token: agent.token, title, approach, ...extra });
  return { agent, token: agent.token, ...res };
}

const PARITY = ['Parity contradiction', 'Assume a fraction in lowest terms and show numerator and denominator are both even.'];
const PROOF = { claim: 'The square root of two is irrational.', proof: 'Suppose it were p/q in lowest terms; then p and q are both even, a contradiction.' };
const REVIEW = {
  what_was_found: 'A complete proof by contradiction via parity.',
  assessment: 'Every step was checked and holds; nothing is assumed silently.',
  independent_test: 'Brute-force search for integer solutions of p^2 = 2 q^2 up to one million.',
  why_independent: 'The search uses integer arithmetic only and none of the reasoning.',
};

test('only the head of the queue receives the board', () => {
  const { board } = setup();
  const a = board.joinQueue({ idea: 'Use a parity argument on the fraction.' });
  const b = board.joinQueue({ idea: 'Use unique prime factorization.' });
  const c = board.joinQueue({ idea: 'Compute the continued fraction expansion.' });
  assert.deepEqual([a.position, b.position, c.position], [1, 2, 3]);

  const waiting = board.peekTurn(b.agent.token);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.position, 2);
  assert.equal(waiting.board, undefined, 'waiting agents must not get the board');

  const turn = board.peekTurn(a.agent.token);
  assert.equal(turn.status, 'your_turn');
  assert.ok(turn.board.cards);
  assert.equal(board.state.stats.boardReads, 1);

  assert.throws(() => board.claimCard({ token: b.agent.token, title: 'Too early', approach: 'Trying to claim without holding the turn.' }), { code: 'not_your_turn' });
  board.claimCard({ token: a.agent.token, title: PARITY[0], approach: PARITY[1] });
  assert.equal(board.peekTurn(b.agent.token).status, 'your_turn');
  assert.equal(board.peekTurn(c.agent.token).position, 2);
});

test('wait_turn blocks until the agent ahead has claimed', async () => {
  const { board } = setup();
  const a = board.joinQueue({ idea: 'Use a parity argument on the fraction.' });
  const b = board.joinQueue({ idea: 'Use unique prime factorization.' });
  board.peekTurn(a.agent.token);
  let resolved = false;
  const pending = board.waitTurn(b.agent.token, { timeoutMs: 5000 }).then((r) => ((resolved = true), r));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(resolved, false);
  board.claimCard({ token: a.agent.token, title: PARITY[0], approach: PARITY[1] });
  const res = await pending;
  assert.equal(res.status, 'your_turn');
  assert.equal(res.board.cards.length, 1, 'the board already contains the card claimed a moment ago');
});

test('wait_turn returns "waiting" after the timeout', async () => {
  const { board } = setup();
  board.joinQueue({ idea: 'Use a parity argument on the fraction.' });
  const b = board.joinQueue({ idea: 'Use unique prime factorization.' });
  const res = await board.waitTurn(b.agent.token, { timeoutMs: 40 });
  assert.equal(res.status, 'waiting');
  assert.equal(res.position, 2);
});

test('a look-alike card is not created without a justification', () => {
  const { board } = setup();
  claim(board, ...PARITY);
  const { agent } = board.joinQueue({ idea: 'Assume a fraction in lowest terms and show numerator and denominator are both even.' });
  const turn = board.peekTurn(agent.token);
  assert.equal(turn.similar[0].id, 'C-1', 'the board points at the card that looks like the queued idea');

  const refused = board.claimCard({ token: agent.token, title: 'Parity contradiction again', approach: PARITY[1] });
  assert.equal(refused.claimed, false);
  assert.equal(refused.similar[0].id, 'C-1');
  assert.equal(Object.keys(board.state.cards).length, 1);

  const ok = board.claimCard({ token: agent.token, title: 'Parity contradiction again', approach: PARITY[1], different_because: 'Works modulo 4 instead of modulo 2.' });
  assert.equal(ok.claimed, true);
  assert.equal(ok.card.differentBecause, 'Works modulo 4 instead of modulo 2.');
});

test('pivoting away from a taken idea counts as an avoided duplicate', () => {
  const { board } = setup();
  claim(board, ...PARITY);
  const { agent } = board.joinQueue({ idea: 'Assume a fraction in lowest terms and show numerator and denominator are both even.' });
  board.peekTurn(agent.token);
  const res = board.claimCard({ token: agent.token, title: 'Infinite descent', approach: 'Construct from one solution a strictly smaller positive solution and descend forever.' });
  assert.equal(res.claimed, true);
  assert.equal(res.pivoted, true);
  assert.equal(res.card.pivotedFrom, 'C-1');
  assert.equal(board.state.stats.duplicatesAvoided, 1);

  // an explicit pivot counts as well, an original idea does not
  const third = claim(board, 'Rational root theorem', 'Apply the rational root theorem to the polynomial x squared minus two.');
  assert.equal(third.pivoted, false);
  const { agent: d } = board.joinQueue({ idea: 'Something phrased completely differently about evenness.' });
  board.peekTurn(d.token);
  board.claimCard({ token: d.token, title: 'Continued fraction', approach: 'Show the continued fraction expansion never terminates using an exact identity.', pivoted_from: 'C-1' });
  assert.equal(board.state.stats.duplicatesAvoided, 2);
});

test('a turn expires and the queue moves on', () => {
  const { board, advance } = setup({ turnSeconds: 60 });
  const a = board.joinQueue({ idea: 'Use a parity argument on the fraction.' });
  const b = board.joinQueue({ idea: 'Use unique prime factorization.' });
  board.peekTurn(a.agent.token);
  advance(30_000);
  board.peekTurn(b.agent.token); // b keeps polling
  advance(31_000);
  board.tick();
  assert.equal(board.state.stats.turnsExpired, 1);
  assert.throws(() => board.claimCard({ token: a.agent.token, title: PARITY[0], approach: PARITY[1] }), { code: 'not_queued' });
  assert.equal(board.peekTurn(b.agent.token).status, 'your_turn');
  // the agent that lost its turn may queue again
  assert.equal(board.joinQueue({ token: a.agent.token, idea: 'Use a parity argument on the fraction.' }).position, 2);
});

test('agents that stop polling are dropped from the queue', () => {
  const { board, advance } = setup({ queueIdleSeconds: 100 });
  const a = board.joinQueue({ idea: 'Use a parity argument on the fraction.' });
  const b = board.joinQueue({ idea: 'Use unique prime factorization.' });
  advance(101_000);
  board.peekTurn(b.agent.token);
  board.tick();
  assert.equal(board.state.queue.length, 1);
  assert.equal(board.state.queue[0].agentId, b.agent.id);
  assert.throws(() => board.peekTurn(a.agent.token), { code: 'not_queued' });
});

test('one agent, one card', () => {
  const { board } = setup();
  const { token } = claim(board, ...PARITY);
  assert.throws(() => board.joinQueue({ token, idea: 'A second idea while still working on the first.' }), { code: 'has_card' });
  board.note({ token, text: 'Set up the contradiction.' });
  board.reportDeadEnd({ token, why_it_fails: 'The argument needs a lemma that is not available.' });
  for (const call of [() => board.note({ token, text: 'more' }), () => board.joinQueue({ token, idea: 'Let me try another approach now.' }), () => board.submitProof({ token, ...PROOF })])
    assert.throws(call, { code: 'finished' });
});

test('a proof opens a review card for a different agent, who never sees the scratch notes', () => {
  const { board } = setup();
  const author = claim(board, ...PARITY);
  board.note({ token: author.token, text: 'Secret scratch reasoning the reviewer must not be anchored by.' });
  const { card, review } = board.submitProof({ token: author.token, ...PROOF });
  assert.equal(card.status, 'proof');
  assert.equal(card.proofStatus, 'in_review');
  assert.equal(review.kind, 'review');
  assert.equal(review.status, 'open');
  assert.equal(review.parentId, card.id);

  // the author cannot review its own proof
  assert.throws(() => board.enterCard({ token: author.token }), { code: 'finished' });

  const entered = board.enterCard({ card_id: review.id });
  assert.notEqual(entered.agent.id, author.agent.id);
  assert.equal(entered.briefing.claim, PROOF.claim);
  assert.equal(entered.briefing.proof, PROOF.proof);
  assert.equal(JSON.stringify(entered.briefing).includes('Secret scratch'), false);
  const seen = board.cardDetail(card.id, { token: entered.agent.token });
  assert.equal(seen.notesHidden, true);
  assert.deepEqual(seen.notes, []);
  assert.equal(board.cardDetail(card.id).notes.length, 1, 'everyone else can read the notes');

  assert.throws(() => board.submitProof({ token: entered.agent.token, ...PROOF }), { code: 'wrong_card' });
  board.submitReview({ token: entered.agent.token, verdict: 'verified', ...REVIEW });
  assert.equal(board.state.cards[card.id].proofStatus, 'verified');
  assert.equal(board.state.findings[card.outcome.findingId].confidence, 'verified');
  assert.deepEqual(board.state.project.verified, [card.id]);
});

test('a refuted proof becomes knowledge: a refutation finding that contradicts the claim', () => {
  const { board } = setup();
  const author = claim(board, ...PARITY);
  const { card, review } = board.submitProof({ token: author.token, ...PROOF });
  const reviewer = board.enterCard({ card_id: review.id }).agent;
  assert.throws(() => board.submitReview({ token: reviewer.token, verdict: 'refuted', ...REVIEW }), /flaws/);
  board.submitReview({ token: reviewer.token, verdict: 'refuted', ...REVIEW, flaws: 'Step three divides by a quantity that can be zero.' });
  assert.equal(board.state.cards[card.id].proofStatus, 'refuted');
  const refutation = Object.values(board.state.findings).find((f) => f.kind === 'refutation');
  assert.deepEqual(refutation.contradicts, [card.outcome.findingId]);
  assert.equal(board.state.findings[card.outcome.findingId].confidence, 'refuted');
  // the next agent at the head sees the flaw on the board
  const next = board.joinQueue({ idea: 'Repair the gap in the first proof attempt.' });
  const line = board.peekTurn(next.agent.token).board.cards.find((c) => c.id === card.id);
  assert.match(line.takeaway, /REFUTED: Step three divides/);
});

test('a derivation opens a follow-up card that a fresh agent enters without queueing', () => {
  const { board } = setup();
  const first = claim(board, 'Descent', 'Construct from one solution a strictly smaller positive solution and descend forever.');
  board.state.cards[first.card.id].workspaces.push('/work/descent');
  const lemma = board.addFinding({ token: first.token, statement: 'Every solution yields another solution.', kind: 'lemma', confidence: 'proven' });
  const { card, followup } = board.submitDerivation({ token: first.token, established: 'Every solution yields another solution.', next_step: 'Show that the new solution is strictly smaller and positive.' });
  assert.equal(card.status, 'derivation');
  assert.equal(followup.kind, 'followup');
  assert.equal(followup.depth, 1);
  assert.equal(card.outcome.followupId, followup.id);

  const second = board.enterCard({});
  assert.equal(second.card.id, followup.id);
  assert.equal(second.agent.role, 'followup');
  assert.equal(second.briefing.established, 'Every solution yields another solution.');
  assert.deepEqual(second.briefing.parentWorkspaces, ['/work/descent'], 'the follow-up agent is pointed at the files it inherits');
  assert.deepEqual(second.briefing.parentFindings.map((f) => f.id), [lemma.id, card.outcome.findingId]);
  assert.throws(() => board.joinQueue({ token: second.agent.token, idea: 'A follow-up agent must not use the queue.' }), { code: 'wrong_role' });

  const f = board.addFinding({ token: second.agent.token, statement: 'The new solution is smaller.', kind: 'lemma', confidence: 'proven', builds_on: [lemma.id] });
  assert.deepEqual(f.buildsOn, [lemma.id]);
  assert.throws(() => board.addFinding({ token: second.agent.token, statement: 'References nothing real.', kind: 'lemma', confidence: 'proven', builds_on: ['F-999'] }), /unknown ids: F-999/);
  board.submitProof({ token: second.agent.token, ...PROOF });
  assert.deepEqual(board.lineage(followup.id).map((l) => l.id), [card.id, followup.id]);
});

test('follow-up chains stop at maxDepth', () => {
  const { board } = setup({ maxDepth: 1 });
  const first = claim(board, 'Descent', 'Construct from one solution a strictly smaller positive solution and descend forever.');
  board.submitDerivation({ token: first.token, established: 'First partial result of the chain.', next_step: 'Continue with the second part of the chain.' });
  const second = board.enterCard({});
  const res = board.submitDerivation({ token: second.agent.token, established: 'Second partial result of the chain.', next_step: 'This would be a third card in the chain.' });
  assert.equal(res.followup, null);
  assert.equal(board.openCards().length, 0);
});

test('a dead end records the obstruction', () => {
  const { board } = setup();
  const { token, card } = claim(board, 'Decimal digits', 'Compute a million digits and look for a repeating period in the expansion.');
  board.reportDeadEnd({ token, why_it_fails: 'No finite prefix can rule out a long period.', salvageable: 'Rules out small denominators.' });
  const f = board.state.findings[board.state.cards[card.id].outcome.findingId];
  assert.equal(f.kind, 'obstruction');
  assert.equal(board.search({ query: 'period prefix' })[0].id, f.id);
});

test('when an agent disappears a fresh agent takes over its card, with everything left on it', () => {
  const { board } = setup({ maxReopens: 1 });
  const first = board.registerAgent({ role: 'researcher', workspace: '/work/first' });
  board.joinQueue({ token: first.token, idea: 'Use a parity argument on the fraction, carefully.' });
  board.peekTurn(first.token);
  const { card } = board.claimCard({ token: first.token, title: PARITY[0], approach: PARITY[1] });
  board.note({ token: first.token, text: 'Wrote search.py; first run reached 61.' });
  const finding = board.addFinding({ token: first.token, statement: 'The square of an odd number is odd.', kind: 'lemma', confidence: 'proven' });
  board.agentGone(first.id, 'process exited');
  assert.equal(board.state.cards[card.id].status, 'open', 'the idea is not lost');
  assert.throws(() => board.note({ token: first.token, text: 'still here?' }), { code: 'gone' });

  const second = board.enterCard({});
  assert.equal(second.card.id, card.id);
  assert.notEqual(second.agent.id, first.id);
  assert.equal(second.briefing.approach, PARITY[1]);
  assert.ok(second.briefing.previousNotes.some((n) => n.text.includes('first run reached 61')));
  assert.deepEqual(second.briefing.previousFindings.map((f) => f.id), [finding.id]);
  assert.deepEqual(second.briefing.previousWorkspaces, ['/work/first']);

  // after maxReopens the card is given up — and its idea is then free to retry through the queue
  board.agentGone(second.agent.id, 'crashed');
  assert.equal(board.state.cards[card.id].status, 'abandoned');
  const retry = claim(board, ...PARITY);
  assert.equal(retry.claimed, true);

  // a review that is given up leaves its proof marked as unreviewed
  const { review } = board.submitProof({ token: retry.token, ...PROOF });
  const r1 = board.enterCard({ card_id: review.id }).agent;
  board.agentGone(r1.id, 'crashed');
  assert.equal(board.state.cards[review.id].status, 'open');
  const r2 = board.enterCard({ card_id: review.id }).agent;
  board.agentGone(r2.id, 'crashed');
  assert.equal(board.state.cards[review.id].status, 'abandoned');
  assert.equal(board.state.cards[retry.card.id].proofStatus, 'unreviewed');
});

test('cards without activity are released after the lease', () => {
  const { board, advance } = setup({ cardLeaseMinutes: 10 });
  const { token, card } = claim(board, ...PARITY);
  advance(9 * 60_000);
  board.note({ token, text: 'Still working.' });
  advance(9 * 60_000);
  board.tick();
  assert.equal(board.state.cards[card.id].status, 'active');
  advance(2 * 60_000);
  board.tick();
  assert.equal(board.state.cards[card.id].status, 'open', 'released for a fresh agent');
  assert.throws(() => board.note({ token, text: 'too late' }), { code: 'gone' });
});

test('a heartbeat from the agent process keeps the lease, but does not count as showing up', () => {
  const { board, advance } = setup({ cardLeaseMinutes: 10 });
  const { agent, token, card } = claim(board, ...PARITY);
  const calls = agent.calls;
  for (let i = 0; i < 6; i++) {
    advance(9 * 60_000); // a long search: no board call for almost an hour
    assert.equal(board.heartbeat(agent.id), true);
    board.tick();
  }
  assert.equal(board.state.cards[card.id].status, 'active');
  assert.equal(agent.calls, calls, 'heartbeats are not board calls');
  board.note({ token, text: 'The search finished.' });

  // once the process goes quiet, the lease runs out as before
  advance(11 * 60_000);
  board.tick();
  assert.equal(board.state.cards[card.id].status, 'open');
  assert.equal(board.heartbeat(agent.id), false, 'a released agent cannot revive its card');
  assert.equal(board.state.cards[card.id].status, 'open');
});

test('reserved cards cannot be taken by someone else', () => {
  const { board } = setup();
  const author = claim(board, ...PARITY);
  const { review } = board.submitProof({ token: author.token, ...PROOF });
  const reviewer = board.registerAgent({ role: 'reviewer', origin: 'orchestrator', cardId: review.id });
  assert.throws(() => board.enterCard({ card_id: review.id }), { code: 'unavailable' });
  assert.throws(() => board.enterCard({}), { code: 'none_open' });
  assert.equal(board.enterCard({ token: reviewer.token }).card.id, review.id);
  assert.equal(board.enterCard({ token: reviewer.token }).card.id, review.id, 'entering twice is harmless');
});

test('input is validated with messages an agent can act on', () => {
  const { board } = setup();
  assert.throws(() => board.joinQueue({ idea: 'short' }), BoardError);
  assert.throws(() => board.joinQueue({}), /"idea" is required/);
  assert.throws(() => board.peekTurn('wwr_nope'), { code: 'unknown_token' });
  const { token } = claim(board, ...PARITY);
  assert.throws(() => board.addFinding({ token, statement: 'A fine statement.', kind: 'vibes', confidence: 'proven' }), /"kind" must be one of/);
  assert.throws(() => board.submitReview({ token, verdict: 'verified', ...REVIEW }), { code: 'wrong_card' });
  assert.throws(() => new Board({}), /"goal" is required/);
});

test('state survives a restart; interrupted cards are kept and handed to fresh agents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwr-test-'));
  try {
    const board = new Board({ dir, goal: GOAL });
    const done = claim(board, ...PARITY);
    board.reportDeadEnd({ token: done.token, why_it_fails: 'The argument needs a lemma that is not available.' });
    const running = claim(board, 'Descent', 'Construct from one solution a strictly smaller positive solution and descend forever.');
    board.note({ token: running.token, text: 'Half way through the descent argument.' });
    board.joinQueue({ idea: 'An idea that was waiting in the queue.' });
    board.flush();

    const again = new Board({ dir });
    assert.equal(again.resumed, true);
    assert.equal(again.state.project.goal, GOAL);
    again.recover();
    assert.equal(again.state.queue.length, 0);
    assert.equal(again.state.cards[done.card.id].status, 'dead_end');
    assert.equal(again.state.cards[running.card.id].status, 'open');
    assert.equal(again.state.cards[running.card.id].reopens, 0, 'a restart does not count against the card');
    assert.throws(() => again.note({ token: running.token, text: 'hello?' }), { code: 'gone' });
    const takeover = again.enterCard({});
    assert.equal(takeover.card.id, running.card.id);
    assert.ok(takeover.briefing.previousNotes.some((n) => n.text.includes('Half way through')));
    // restarting again and again never wears a card out
    again.recover();
    again.recover();
    assert.equal(again.state.cards[running.card.id].status, 'open');
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === 'dead_end'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the snapshot for the UI never contains agent tokens', () => {
  const { board } = setup();
  const { token } = claim(board, ...PARITY);
  board.joinQueue({ idea: 'Another idea waiting in the queue.' });
  assert.equal(JSON.stringify(board.snapshot()).includes(token), false);
  assert.equal(JSON.stringify(board.snapshot()).includes('wwr_'), false);
});

/** Submit a proof and have a fresh agent verify it. Returns the proof card and the check card it opened. */
function verifiedProof(board, title = PARITY[0], approach = PARITY[1]) {
  const author = claim(board, title, approach);
  const { card, review } = board.submitProof({ token: author.token, ...PROOF });
  const reviewer = board.enterCard({ card_id: review.id });
  const { check } = board.submitReview({ token: reviewer.agent.token, verdict: 'verified', ...REVIEW });
  return { card, check };
}

test('a verified proof opens a result check; refuted ones do not, and one waiting check is enough', () => {
  const { board } = setup();
  const bad = claim(board, 'Decimal expansion', 'Look at the decimal digits of the root and find that they never repeat.');
  const { review } = board.submitProof({ token: bad.token, ...PROOF });
  const r = board.enterCard({ card_id: review.id });
  assert.equal(board.submitReview({ token: r.agent.token, verdict: 'refuted', flaws: 'Only finitely many digits were checked.', ...REVIEW }).check, null);

  const first = verifiedProof(board);
  assert.equal(first.check.kind, 'check');
  assert.equal(first.check.status, 'open');
  assert.equal(first.check.triggeredBy, first.card.id);
  const second = verifiedProof(board, 'Infinite descent', 'Build a smaller solution from any solution of p squared equals two q squared.');
  assert.equal(second.check, null, 'the waiting check will see this proof too');
  assert.equal(board.digest().cards.some((c) => c.id === first.check.id), false, 'check cards are not research ideas');

  const checker = board.enterCard({ card_id: first.check.id });
  assert.equal(checker.agent.role, 'checker');
  assert.deepEqual(checker.briefing.verified.map((p) => p.id).sort(), [first.card.id, second.card.id].sort());
  assert.equal(checker.briefing.unsettled.length, 1, 'the refuted proof is listed as not established');
  assert.throws(() => board.submitProof({ token: checker.agent.token, ...PROOF }), { code: 'wrong_card' });
});

test('a checker writes the result; "not finished" needs what is missing and researchers see it', () => {
  const { board } = setup();
  const { check } = verifiedProof(board);
  const checker = board.enterCard({ card_id: check.id });
  const summary = '- C-1 proves the claim for even numerators only.';
  assert.throws(() => board.submitResult({ token: checker.agent.token, finished: false, summary }), { code: 'invalid' });
  assert.throws(() => board.submitResult({ token: checker.agent.token, finished: 'yes', summary }), { code: 'invalid' });
  board.submitResult({ token: checker.agent.token, finished: false, summary, missing: 'The case of an odd numerator is not covered.' });
  assert.equal(board.state.project.finished, null);
  assert.equal(board.state.project.result.cardId, check.id);
  assert.equal(board.state.cards[check.id].status, 'reported');
  assert.match(board.digest().result.missing, /odd numerator/);
  assert.throws(() => board.note({ token: checker.agent.token, text: 'one more thing' }), { code: 'finished' });
});

test('finished=true marks the goal as reached; no more checks open; the user can override both ways', () => {
  const { board } = setup();
  const seen = [];
  board.on('event', (ev) => seen.push(ev.type));
  const { check } = verifiedProof(board);
  const checker = board.enterCard({ card_id: check.id });
  board.submitResult({ token: checker.agent.token, finished: true, summary: '- C-1: the root of two is irrational (verified).', based_on: ['C-1'] });
  assert.deepEqual(board.state.project.finished, { at: board.now(), by: 'agent', cardId: check.id });
  assert.ok(seen.includes('goal_finished'));
  assert.equal(verifiedProof(board, 'Infinite descent', 'Build a smaller solution from any solution of p squared equals two q squared.').check, null);

  board.setFinished(false);
  assert.equal(board.state.project.finished, null);
  assert.ok(seen.includes('goal_reopened'));
  board.setFinished(true, { by: 'user' });
  assert.equal(board.state.project.finished.by, 'user');
  const n = seen.length;
  board.setFinished(true);
  assert.equal(seen.length, n, 'marking it twice changes nothing');
});

test('the board shows why a dead end failed and what it left open; a large board is shown more briefly', async () => {
  const { renderTurn } = await import('../src/render.js');
  const { board } = setup();
  const why = `The parity argument breaks at step three. ${'It needs the fraction in lowest terms, which the construction does not keep. '.repeat(6)}`.trim();
  const dead = claim(board, ...PARITY);
  board.reportDeadEnd({ token: dead.token, why_it_fails: why, salvageable: 'Running the same argument modulo four keeps the lowest-terms property.' });
  const capped = claim(board, 'Continued fractions', 'Use the periodic continued fraction expansion of the square root of two.');
  const next = board.joinQueue({ idea: 'Use unique prime factorization of both sides.' });
  let turn = board.peekTurn(next.agent.token);
  const line = turn.board.cards.find((c) => c.id === dead.card.id);
  assert.ok(line.takeaway.length > 400, 'on a small board the reason is not cut down to a headline');
  assert.match(line.salvageable, /modulo four/);
  assert.match(renderTurn(turn), /↳ may still work: Running the same argument modulo four/);
  assert.match(renderTurn(turn), /what you claim now is what you will work on for hours/);
  board.passTurn({ token: next.agent.token });

  // a partial result at the end of a chain: nobody was sent on, so its next step is open to anyone
  board.config.maxDepth = 0;
  board.submitDerivation({ token: capped.token, established: 'The expansion is periodic with period one.', next_step: 'Show that a periodic expansion cannot belong to a rational number.' });
  const again = board.joinQueue({ idea: 'Use the rational root theorem on x squared minus two.' });
  turn = board.peekTurn(again.agent.token);
  assert.match(renderTurn(turn), /↳ next step nobody has taken: Show that a periodic expansion/);
  board.passTurn({ token: again.agent.token });

  // 120 cards: each gets the short form again, so the whole board stays readable in one go
  for (let i = 0; i < 120; i++) claim(board, `Variant ${i} of descent`, `Descent variant number ${i}: ${'build a smaller solution from a given one and repeat. '.repeat(12)}`, { different_because: 'A different variant.' });
  const last = board.joinQueue({ idea: 'Something else entirely, with a geometric construction.' });
  turn = board.peekTurn(last.agent.token);
  assert.ok(turn.board.cards.every((c) => c.approach.length <= 240));
  assert.equal(turn.board.cards.find((c) => c.id === dead.card.id).salvageable, null);
  assert.ok(renderTurn(turn).length < 90_000, `the rendered board has ${renderTurn(turn).length} characters`);
});

test('an abandoned card can be handed on again by the user; an abandoned review puts the proof back in review', () => {
  const { board } = setup({ maxReopens: 0 });
  const author = claim(board, ...PARITY);
  const { card: proofCard, review } = board.submitProof({ token: author.token, ...PROOF });
  assert.throws(() => board.reopenCard(review.id), (e) => e instanceof BoardError && e.code === 'unavailable', 'only abandoned cards');
  const reviewer = board.enterCard({ card_id: review.id });
  board.note({ token: reviewer.agent.token, text: 'Half of the cases are checked; rerun check.py to continue.' });
  board.agentGone(reviewer.agent.id, 'no activity for 60 minutes');
  assert.equal(review.status, 'abandoned');
  assert.equal(proofCard.proofStatus, 'unreviewed');

  const reopened = board.reopenCard(review.id.toLowerCase());
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.reopens, 0, 'it gets its retries back');
  assert.equal(proofCard.proofStatus, 'in_review');
  const second = board.enterCard({ card_id: review.id });
  assert.ok(second.briefing.previousNotes.some((n) => /rerun check\.py/.test(n.text)), 'the next reviewer continues from the notes');
  board.submitReview({ token: second.agent.token, verdict: 'verified', ...REVIEW });
  assert.equal(proofCard.proofStatus, 'verified');
  assert.throws(() => board.reopenCard('C-99'), (e) => e instanceof BoardError && e.code === 'not_found');
});

test('a board saved by an older version gets the fields added since', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwr-old-'));
  const board = new Board({ dir, goal: GOAL });
  delete board.state.orchestrator.uncosted;
  board.flush();
  const loaded = new Board({ dir });
  assert.equal(loaded.state.orchestrator.uncosted, 0);
  assert.equal(loaded.setOrchestrator({ uncosted: 2 }).uncosted, 2);
  clearTimeout(loaded.saveTimer);
  fs.rmSync(dir, { recursive: true, force: true });
});
