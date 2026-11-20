#!/usr/bin/env node
// A complete wwresearch agent without any model — it shows the whole protocol
// over plain HTTP. Use it as a template for docking your own agent:
//
//   wwresearch run "some goal" --agents 3 --max-ideas 6 --agent-cmd "node examples/scripted-agent.mjs"
//
// The orchestrator provides: the prompt on stdin, and WWR_API_URL,
// WWR_AGENT_TOKEN, WWR_AGENT_ROLE (researcher | followup | reviewer),
// WWR_MCP_URL, WWR_PROMPT_FILE, WWR_WORKSPACE in the environment.

const api = process.env.WWR_API_URL ?? 'http://127.0.0.1:4777/api/tool';
const token = process.env.WWR_AGENT_TOKEN;
const role = process.env.WWR_AGENT_ROLE ?? 'researcher';

async function tool(name, args = {}) {
  const res = await fetch(`${api}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...args }) });
  const body = await res.json();
  if (!body.ok) throw new Error(body.text);
  return body.data;
}

const ANGLES = ['a brute-force search over small cases', 'a proof by induction', 'a reduction to a known theorem', 'a probabilistic argument', 'a counterexample hunt'];
const pick = () => ANGLES[Math.floor(Math.random() * ANGLES.length)];

if (role === 'researcher') {
  // 1. have an idea, 2. queue, 3. wait for the board
  const mine = pick();
  await tool('join_queue', { idea: `Attack the goal with ${mine}.` });
  let turn;
  do turn = await tool('wait_turn');
  while (turn.status !== 'your_turn');

  // 4. on the board already? then pick something that is not
  const taken = turn.board.cards.map((c) => c.title);
  const angle = [mine, ...ANGLES].find((a) => !taken.includes(a));
  if (!angle) {
    await tool('pass_turn'); // nothing new to add
    process.exit(0);
  }
  await tool('claim_card', { title: angle, approach: `Attack the goal with ${angle}, and write down exactly where it gets stuck.` });

  // 5. "research", 6. finish with one of the three outcomes
  await tool('note', { text: `Trying ${angle}…` });
  await tool('add_finding', { statement: `A scripted agent tried ${angle} and learned nothing.`, kind: 'observation', confidence: 'speculative' });
  await tool('report_dead_end', { why_it_fails: `This agent is a script, so ${angle} went nowhere. A real agent would explain the obstruction here.` });
} else {
  // Spawned directly into a follow-up or review card: no queue.
  const { kind } = await tool('enter_card');
  if (kind === 'review') {
    await tool('submit_review', {
      verdict: 'inconclusive',
      what_was_found: 'A scripted reviewer cannot read proofs; this is a placeholder.',
      assessment: 'No assessment was made. A real reviewer tries to break the proof here.',
      independent_test: 'Not provided by this script. A real reviewer describes a test the user can run.',
      why_independent: 'Not applicable to this placeholder review.',
    });
  } else {
    await tool('report_dead_end', { why_it_fails: 'A scripted agent cannot continue research; this is a placeholder.' });
  }
}
