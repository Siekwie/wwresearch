import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Board } from '../src/board.js';
import { createMcp } from '../src/mcp.js';
import { createServer } from '../src/server.js';

let board;
let srv;
let base;
let nextId = 1;

before(async () => {
  board = new Board({ goal: 'Prove that the square root of two is irrational.', config: { pollSeconds: 1 } });
  srv = createServer({ board, mcp: createMcp(board, { version: '9.9.9' }), port: 0 });
  base = (await srv.listen()).url;
});
after(() => srv.close());

async function rpc(method, params, { raw = false } = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const body = await res.json();
  return raw ? { res, body } : body.result;
}

const call = async (name, args) => {
  const result = await rpc('tools/call', { name, arguments: args });
  return { text: result.content[0].text, isError: result.isError };
};
const tokenIn = (text) => text.match(/wwr_[0-9a-f]+/)[0];

test('MCP handshake', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(init.serverInfo.name, 'wwresearch');
  assert.equal(init.serverInfo.version, '9.9.9');
  assert.ok(init.capabilities.tools);
  assert.match(init.instructions, /join_queue/);

  const unknown = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.match(unknown.protocolVersion, /^20\d\d-/, 'falls back to a version the server supports');

  const note = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');
  assert.deepEqual(await rpc('ping'), {});
});

test('MCP lists well-formed tools and prompts', async () => {
  const { tools } = await rpc('tools/list');
  assert.deepEqual(
    tools.map((t) => t.name),
    ['join_queue', 'wait_turn', 'claim_card', 'pass_turn', 'enter_card', 'note', 'add_finding', 'search_knowledge', 'read_card', 'submit_proof', 'submit_derivation', 'report_dead_end', 'submit_review'],
  );
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    for (const r of t.inputSchema.required) assert.ok(t.inputSchema.properties[r], `${t.name}: required "${r}" is not a property`);
    assert.equal(t.handler, undefined);
  }
  const { prompts } = await rpc('prompts/list');
  assert.deepEqual(prompts.map((p) => p.name), ['researcher', 'open_card']);
  const prompt = await rpc('prompts/get', { name: 'researcher' });
  assert.match(prompt.messages[0].content.text, /square root of two/);
});

test('a full research loop over MCP', async () => {
  const joined = await call('join_queue', { idea: 'Assume a fraction in lowest terms and derive a parity contradiction.' });
  assert.equal(joined.isError, false);
  assert.match(joined.text, /HOW THE BOARD WORKS/);
  assert.match(joined.text, /YOUR TURN/, 'first in line gets the board immediately');
  const token = tokenIn(joined.text);

  const second = await call('join_queue', { idea: 'Compare the exponent of two on both sides of the equation.' });
  assert.match(second.text, /Queue position: 2/);
  assert.doesNotMatch(second.text, /BOARD ·/, 'a waiting agent is not shown the board');
  const token2 = tokenIn(second.text);
  assert.match((await call('wait_turn', { token: token2 })).text, /^Waiting — queue position 2/);

  const early = await call('note', { token, text: 'too early' });
  assert.equal(early.isError, true);
  assert.match(early.text, /ERROR \(no_card\)/);

  assert.match((await call('claim_card', { token, title: 'Parity contradiction', approach: 'Assume lowest terms and show that numerator and denominator are both even.' })).text, /CLAIMED — C-1/);
  const turn2 = await call('wait_turn', { token: token2 });
  assert.match(turn2.text, /YOUR TURN/);
  assert.match(turn2.text, /C-1 \[in progress\] Parity contradiction/);
  assert.match((await call('pass_turn', { token: token2 })).text, /left the queue/);

  assert.match((await call('note', { token, text: 'Wrote down the setup.' })).text, /Noted on C-1/);
  assert.match((await call('add_finding', { token, statement: 'If n squared is even then n is even.', kind: 'lemma', confidence: 'proven' })).text, /Recorded F-1/);
  assert.match((await call('search_knowledge', { query: 'even squared' })).text, /F-1 \[finding · lemma/);
  const submitted = await call('submit_proof', { token, claim: 'The square root of two is irrational.', proof: 'Suppose it is p/q in lowest terms. Then both p and q are even, which is a contradiction.' });
  assert.match(submitted.text, /independent agent will review it in C-2/);

  const review = await call('enter_card', {});
  assert.match(review.text, /You are the independent reviewer on C-2/);
  assert.match(review.text, /SUBMITTED PROOF/);
  assert.doesNotMatch(review.text, /Wrote down the setup/);
  const reviewer = tokenIn(review.text);
  assert.match((await call('read_card', { card_id: 'C-1', token: reviewer })).text, /NOTES: hidden/);
  const done = await call('submit_review', {
    token: reviewer,
    verdict: 'verified',
    what_was_found: 'A complete parity proof of the irrationality.',
    assessment: 'Each inference was checked independently and holds.',
    independent_test: 'Brute-force search for solutions of p^2 = 2 q^2 below one million.',
    why_independent: 'It uses integer arithmetic only, not the argument.',
  });
  assert.match(done.text, /Review recorded: verified \(C-1\)/);

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.cards['C-1'].proofStatus, 'verified');
  const report = await (await fetch(`${base}/api/cards/C-2/report.md`)).text();
  assert.match(report, /^# Verified: The square root of two is irrational\./);
  assert.match(report, /## 4\. Why that test is independent/);
  assert.match(await (await fetch(`${base}/api/report.md`)).text(), /## Verified results/);
});

test('protocol errors', async () => {
  const unknownMethod = await rpc('does/not/exist', {}, { raw: true });
  assert.equal(unknownMethod.body.error.code, -32601);
  const unknownTool = await rpc('tools/call', { name: 'nope', arguments: {} }, { raw: true });
  assert.equal(unknownTool.body.error.code, -32602);
  const garbage = await fetch(`${base}/mcp`, { method: 'POST', body: '{not json' });
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).error.code, -32700);
  const get = await fetch(`${base}/mcp`);
  assert.equal(get.status, 405);
  const batch = await (await fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]) })).json();
  assert.equal(batch.length, 1);
});

test('every tool is also a plain HTTP POST', async () => {
  const res = await fetch(`${base}/api/tool/join_queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea: 'Use the rational root theorem on a quadratic polynomial.' }) });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.data.token, /^wwr_/);
  assert.equal(body.data.position, 1);
  const bad = await fetch(`${base}/api/tool/note`, { method: 'POST', body: JSON.stringify({ token: 'wwr_wrong', text: 'x' }) });
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).code, 'unknown_token');
  assert.equal((await fetch(`${base}/api/tool/nope`, { method: 'POST', body: '{}' })).status, 404);
});

test('the UI and the event stream are served', async () => {
  const html = await (await fetch(base)).text();
  assert.match(html, /<title>wwresearch<\/title>/);
  assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/cards/C-999`)).status, 404);

  const got = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/events`, (res) => {
      res.on('data', (chunk) => {
        if (String(chunk).includes('event: change')) {
          req.destroy();
          resolve(true);
        }
      });
    });
    req.on('error', reject);
    setTimeout(() => board.setOrchestrator({ target: 3 }), 50);
  });
  assert.equal(got, true);
  const o = await (await fetch(`${base}/api/orchestrator`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 7, paused: true }) })).json();
  assert.equal(o.target, 7);
  assert.equal(o.paused, true);
});

test('the shut down button pauses the board and tells the orchestrator', async () => {
  board.setOrchestrator({ paused: false });
  let heard = 0;
  const listener = () => heard++;
  board.on('shutdown', listener);
  const res = await fetch(`${base}/api/shutdown`, { method: 'POST' });
  board.off('shutdown', listener);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).orchestrator.paused, true);
  assert.equal(heard, 1);
});

test('requests from other sites and rebinding hosts are refused', async () => {
  const port = new URL(base).port;
  const status = (headers, method = 'GET', path = '/api/state') =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end(method === 'POST' ? '{}' : undefined);
    });
  assert.equal(await status({ host: 'evil.example.com' }), 403);
  assert.equal(await status({ host: `localhost:${port}` }), 200);
  assert.equal(await status({ host: `localhost:${port}`, origin: 'https://evil.example.com' }, 'POST', '/api/orchestrator'), 403);
  assert.equal(await status({ host: `localhost:${port}`, origin: `http://localhost:${port}` }, 'POST', '/api/orchestrator'), 200);
});

test('an interrupted idea card is taken over through enter_card', async () => {
  const b = new Board({ goal: 'Find a small sorting network for sixteen inputs.' });
  const mcp = createMcp(b);
  const first = b.registerAgent({ role: 'researcher', workspace: '/work/A-1' });
  await mcp.callTool('join_queue', { token: first.token, idea: 'Simulated annealing over comparator lists.' });
  await mcp.callTool('claim_card', { token: first.token, title: 'Annealing', approach: 'Simulated annealing over fixed-length comparator lists.' });
  await mcp.callTool('note', { token: first.token, text: 'anneal.py reaches 62 comparators after 5 minutes.' });
  b.recover(); // the board was restarted while the agent was working

  const res = await mcp.callTool('enter_card', {});
  assert.match(res.text, /You are taking over C-1: "Annealing"/);
  assert.match(res.text, /anneal\.py reaches 62 comparators/);
  assert.match(res.text, /FILES LEFT BY THE PREVIOUS AGENT[\s\S]*\/work\/A-1/);
  assert.match(res.text, /Continue from where it stopped/);
  assert.match(res.text, /BLOCKED:/, 'agents are told how to report an environment that stops them');
});
