// Agent-facing interface: the tool table plus a minimal, dependency-free
// Model Context Protocol server (JSON-RPC 2.0; initialize, tools, prompts).

import { BoardError, FINDING_KINDS, CONFIDENCE, VERDICTS } from './board.js';
import { BOARD_EXPLANATION, renderTurn, renderWaiting, renderGate, renderClaimed, renderBriefing, renderCard, renderSearch } from './render.js';
import { researcherPrompt, cardPrompt } from './prompts.js';

export const SERVER_NAME = 'wwresearch';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOKEN = { type: 'string', description: 'Your agent token (from join_queue or enter_card).' };
const IDS = (what) => ({ type: 'array', items: { type: 'string' }, description: what });

export function createTools(board) {
  const tools = [];
  const add = (name, description, properties, required, handler, readOnly = false) =>
    tools.push({
      name,
      description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
      handler,
    });

  add(
    'join_queue',
    'Step 1 for a new idea. Put your idea into the queue of the research board. You must already have ONE concrete approach in mind, but do not work on it yet. Returns your agent token and queue position. If you are first in line you receive the board immediately.',
    {
      idea: { type: 'string', description: 'Your approach in 1–3 sentences: what you would try and why it might work.' },
      token: { type: 'string', description: 'Only if you were given a token in your instructions or already have one.' },
      agent_name: { type: 'string', description: 'Optional display name.' },
    },
    ['idea'],
    async ({ idea, token, agent_name }) => {
      const { agent, position } = board.joinQueue({ token, idea, name: agent_name });
      const out = [`You are agent "${agent.name}". Your token: ${agent.token}`, 'Pass this token to every other tool call.', ''];
      if (!agent.briefed) {
        agent.briefed = true;
        out.push(BOARD_EXPLANATION, '');
      }
      if (position === 1) out.push(renderTurn(board.peekTurn(agent.token)));
      else out.push(`Queue position: ${position}. Do not research yet. Call wait_turn now — it blocks until it is your turn; call it again whenever it returns "waiting".`);
      return { text: out.join('\n'), data: { agentId: agent.id, name: agent.name, token: agent.token, position } };
    },
  );

  add(
    'wait_turn',
    'Step 2. Blocks (up to about a minute) until you reach the head of the queue. Returns either "waiting" with your position — call it again — or "YOUR TURN" together with the whole board. The board is only ever shown to the agent at the head.',
    { token: TOKEN },
    ['token'],
    async ({ token }, { signal } = {}) => {
      const res = await board.waitTurn(token, { signal });
      if (res.status === 'waiting') return { text: renderWaiting(res), data: { status: 'waiting', position: res.position } };
      return { text: renderTurn(res), data: { status: 'your_turn', idea: res.idea, similar: res.similar, secondsLeft: res.secondsLeft, board: res.board } };
    },
    true,
  );

  add(
    'claim_card',
    'Step 3, only on your turn. Create a card for an approach that is NOT yet on the board and claim it. This ends your turn and starts your research. If the board thinks the card duplicates an existing one it is not created and you are told why.',
    {
      token: TOKEN,
      title: { type: 'string', description: 'Short name of the approach (a few words).' },
      approach: { type: 'string', description: 'What exactly you will try, specific enough that another agent can tell whether their idea is the same.' },
      pivoted_from: { type: 'string', description: 'If your original idea was already on the board: the id of the card that had it (e.g. "C-4").' },
      different_because: { type: 'string', description: 'Only if the board flagged a look-alike card: one sentence on what is substantively different.' },
      builds_on: IDS('Ids of findings or cards this approach builds on (e.g. a dead end you want to get around).'),
    },
    ['token', 'title', 'approach'],
    async (args) => {
      const res = board.claimCard(args);
      if (!res.claimed) return { text: renderGate(res), data: { claimed: false, similar: res.similar } };
      return { text: renderClaimed(res), data: { claimed: true, cardId: res.card.id, pivoted: res.pivoted } };
    },
  );

  add(
    'pass_turn',
    'Leave the queue without claiming a card — because you have nothing new to add, or to re-queue at the back with a different idea (new_idea).',
    { token: TOKEN, new_idea: { type: 'string', description: 'Optional: re-enter the queue at the back with this idea.' } },
    ['token'],
    async (args) => {
      const res = board.passTurn(args);
      if (res.requeued) return { text: `Re-queued at position ${res.position}. Call wait_turn.`, data: { requeued: true, position: res.position } };
      return { text: 'You left the queue. If you have nothing to add, you are done — stop now.', data: { requeued: false } };
    },
  );

  add(
    'enter_card',
    'For agents that were sent directly into an existing card (a follow-up or a proof review) — these skip the queue. Returns your briefing. Call it with the token from your instructions; without a token it assigns you the next open card (or the one named by card_id).',
    { token: { type: 'string', description: 'The token from your instructions, if you were given one.' }, card_id: { type: 'string', description: 'Optional: a specific open card, e.g. "C-12".' } },
    [],
    async ({ token, card_id }) => {
      const res = board.enterCard({ token, card_id });
      return { text: renderBriefing(res, { showToken: !token }), data: { agentId: res.agent.id, name: res.agent.name, token: res.agent.token, cardId: res.card.id, kind: res.card.kind, briefing: res.briefing } };
    },
  );

  add(
    'note',
    "Append a short progress note to your card's lab notebook (visible to the user and to agents that build on your card). A few per card is enough. Also keeps your claim on the card alive.",
    { token: TOKEN, text: { type: 'string', description: 'What you just tried, saw or decided.' } },
    ['token', 'text'],
    async (args) => {
      const res = board.note(args);
      return { text: `Noted on ${res.card.id}.`, data: { cardId: res.card.id, count: res.count } };
    },
  );

  add(
    'add_finding',
    'Record one reusable insight in the shared knowledge graph: a lemma, an observation, an obstruction, a counterexample, a technique. Negative results are as valuable as positive ones. One self-contained statement per finding.',
    {
      token: TOKEN,
      statement: { type: 'string', description: 'The insight as one self-contained sentence or two. Someone without your context must understand it.' },
      kind: { type: 'string', enum: FINDING_KINDS.filter((k) => k !== 'refutation'), description: 'What kind of insight this is.' },
      confidence: { type: 'string', enum: CONFIDENCE, description: 'proven = rigorous argument; checked = tested numerically/empirically; likely; speculative.' },
      detail: { type: 'string', description: 'Optional: the argument, data or pointer to files backing the statement.' },
      builds_on: IDS('Ids of findings/cards this one builds on.'),
      contradicts: IDS('Ids of findings this one contradicts.'),
    },
    ['token', 'statement', 'kind', 'confidence'],
    async (args) => {
      const f = board.addFinding(args);
      return { text: `Recorded ${f.id}.`, data: { findingId: f.id } };
    },
  );

  add(
    'search_knowledge',
    'Search everything all agents have established so far — findings and cards, including dead ends. Use it before redoing work someone may already have done.',
    { query: { type: 'string', description: 'Keywords or a short description.' }, limit: { type: 'number', description: 'Max results (default 8).' } },
    ['query'],
    async ({ query, limit }) => {
      const results = board.search({ query, limit });
      return { text: renderSearch(results, query), data: { results } };
    },
    true,
  );

  add(
    'read_card',
    'Read one card in full: approach, notes, findings, outcome and reviews.',
    { token: TOKEN, card_id: { type: 'string', description: 'e.g. "C-7"' } },
    ['token', 'card_id'],
    async ({ card_id, token }) => {
      // The token is mandatory so that a reviewer cannot sidestep the rule that
      // it never sees the working notes of the proof it reviews.
      if (!token) throw new BoardError('invalid', '"token" is required.');
      const detail = board.cardDetail(card_id, { token });
      return { text: renderCard(detail), data: { card: detail } };
    },
    true,
  );

  add(
    'submit_proof',
    'Outcome 1 of 3 — you believe the goal is solved. Closes your card and hands the proof to an independent reviewer. State the exact claim and the complete argument; do not self-certify. After this call you are done.',
    {
      token: TOKEN,
      claim: { type: 'string', description: 'Precisely what you claim to have shown.' },
      proof: { type: 'string', description: 'The complete argument, self-contained. The reviewer sees this text and the artifacts — not your notes.' },
      artifacts: IDS('Paths of files that are part of the proof (code, data, formal proofs).'),
      assumptions: { type: 'string', description: 'Everything the proof takes for granted.' },
      summary: { type: 'string', description: 'Two or three sentences for the board.' },
      builds_on: IDS('Ids of findings/cards the proof relies on.'),
    },
    ['token', 'claim', 'proof'],
    async (args) => {
      const { card, review } = board.submitProof(args);
      return { text: `Proof recorded on ${card.id}. An independent agent will review it in ${review.id}. You are done — stop now.`, data: { cardId: card.id, reviewCardId: review.id } };
    },
  );

  add(
    'submit_derivation',
    'Outcome 2 of 3 — a part is solved, or your approach survived every attempt to refute it but is not finished. Closes your card; a fresh agent continues with your next step. After this call you are done.',
    {
      token: TOKEN,
      established: { type: 'string', description: 'What is now established (or: the approach and why it could not be refuted).' },
      next_step: { type: 'string', description: 'The concrete next step for the agent that continues. It starts with no context except this card.' },
      followup_title: { type: 'string', description: 'Optional short title for the follow-up card.' },
      confidence: { type: 'string', enum: CONFIDENCE, description: 'How solid the established part is.' },
      open_questions: { type: 'string', description: 'What you could not resolve.' },
      summary: { type: 'string', description: 'Two or three sentences for the board.' },
      builds_on: IDS('Ids of findings/cards this relies on.'),
    },
    ['token', 'established', 'next_step'],
    async (args) => {
      const { card, followup } = board.submitDerivation(args);
      return {
        text: `Partial result recorded on ${card.id}. ${followup ? `A fresh agent continues in ${followup.id}.` : 'The follow-up chain reached its maximum depth, so no new card was opened; the result stays on the board.'} You are done — stop now.`,
        data: { cardId: card.id, followupCardId: followup?.id ?? null },
      };
    },
  );

  add(
    'report_dead_end',
    'Outcome 3 of 3 — the approach leads nowhere. Closes your card. The reason goes into the knowledge graph so nobody repeats the trip. After this call you are done.',
    {
      token: TOKEN,
      why_it_fails: { type: 'string', description: 'The precise reason the approach fails — the obstruction, not just "it did not work".' },
      salvageable: { type: 'string', description: 'Anything worth keeping: a sub-result, a variant that might still work.' },
      summary: { type: 'string', description: 'Two or three sentences for the board.' },
      builds_on: IDS('Ids of findings/cards this relates to.'),
    },
    ['token', 'why_it_fails'],
    async (args) => {
      const { card } = board.reportDeadEnd(args);
      return { text: `Dead end recorded on ${card.id}. That knowledge is now available to everyone. You are done — stop now.`, data: { cardId: card.id } };
    },
  );

  add(
    'submit_review',
    'Reviewers only. Close your review card with a verdict and the report for the human user. After this call you are done.',
    {
      token: TOKEN,
      verdict: { type: 'string', enum: VERDICTS, description: 'verified = you tried to break it and could not; refuted = you found a real flaw; inconclusive = you cannot tell.' },
      what_was_found: { type: 'string', description: 'Report section 1: what was found, in plain language.' },
      assessment: { type: 'string', description: 'Report section 2: why you believe the proof is correct — or exactly where and why it breaks.' },
      independent_test: { type: 'string', description: 'Report section 3: how the user can test the result on their own, step by step.' },
      why_independent: { type: 'string', description: "Report section 4: why that test is really independent of the research (does not reuse the author's reasoning, code or data)." },
      flaws: { type: 'string', description: 'Required when refuted: the flaw, stated so that later agents can avoid or repair it.' },
    },
    ['token', 'verdict', 'what_was_found', 'assessment', 'independent_test', 'why_independent'],
    async (args) => {
      const { parent, verdict } = board.submitReview(args);
      return { text: `Review recorded: ${verdict} (${parent.id}). The user has your report. You are done — stop now.`, data: { verdict, proofCardId: parent.id } };
    },
  );

  return tools;
}

export function createMcp(board, { version = '0.0.0' } = {}) {
  const tools = createTools(board);
  const byName = new Map(tools.map((t) => [t.name, t]));

  /** Run a tool. Domain errors come back as results (isError) so the agent can read and react to them. */
  async function callTool(name, args, ctx) {
    const tool = byName.get(name);
    if (!tool) return { text: `Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(', ')}.`, isError: true, code: 'unknown_tool' };
    try {
      return await tool.handler(args && typeof args === 'object' ? args : {}, ctx);
    } catch (err) {
      if (err instanceof BoardError) return { text: `ERROR (${err.code}): ${err.message}`, isError: true, code: err.code };
      throw err;
    }
  }

  const prompts = [
    {
      name: 'researcher',
      description: 'Dock this agent onto the board as a researcher: think of an approach, queue, claim a card, work on it.',
      render: () => researcherPrompt({ goal: board.state.project.goal }),
    },
    {
      name: 'open_card',
      description: 'Dock this agent onto the next open follow-up or review card (skips the queue).',
      render: () => {
        const open = board.openCards().find((c) => !c.reservedFor);
        return cardPrompt({ goal: board.state.project.goal, kind: open?.kind ?? 'followup' });
      },
    },
  ];

  const instructions =
    'Shared research board for parallel agents. New idea: join_queue → wait_turn → claim_card → work (note, add_finding) → finish with submit_proof | submit_derivation | report_dead_end. Sent into an existing card: enter_card → work → finish (reviewers: submit_review). One agent, one card.';

  async function dispatch(msg, ctx) {
    const { method, params = {} } = msg;
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'WorldWideResearch board', version },
          instructions,
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: tools.map(({ handler: _h, ...t }) => t) };
      case 'tools/call': {
        if (!params.name || !byName.has(params.name)) throw rpcError(-32602, `Unknown tool: ${params.name}`);
        const res = await callTool(params.name, params.arguments, ctx);
        return { content: [{ type: 'text', text: res.text }], isError: Boolean(res.isError) };
      }
      case 'prompts/list':
        return { prompts: prompts.map((p) => ({ name: p.name, description: p.description, arguments: [] })) };
      case 'prompts/get': {
        const p = prompts.find((x) => x.name === params.name);
        if (!p) throw rpcError(-32602, `Unknown prompt: ${params.name}`);
        return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.render() } }] };
      }
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      default:
        throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  /**
   * Handle one JSON-RPC message (or a batch). Returns the response to send, or
   * null when nothing has to be sent back (notifications).
   */
  async function handle(message, ctx) {
    if (Array.isArray(message)) {
      const out = (await Promise.all(message.map((m) => handle(m, ctx)))).filter(Boolean);
      return out.length ? out : null;
    }
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0')
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const isRequest = typeof message.method === 'string' && message.id !== undefined && message.id !== null;
    if (!isRequest) return null; // notification or a client response: nothing to answer
    try {
      return { jsonrpc: '2.0', id: message.id, result: await dispatch(message, ctx) };
    } catch (err) {
      if (err?.rpc) return { jsonrpc: '2.0', id: message.id, error: { code: err.code, message: err.message } };
      return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `Internal error: ${err?.message ?? err}` } };
    }
  }

  return { tools, prompts, callTool, handle };
}

function rpcError(code, message) {
  const err = new Error(message);
  err.rpc = true;
  err.code = code;
  return err;
}
