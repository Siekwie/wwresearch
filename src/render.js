// Plain-text renderings of board data for agents. Kept compact on purpose:
// every character here is paid for in tokens by every agent that reads it.

import { short } from './board.js';

export const BOARD_EXPLANATION = `HOW THE BOARD WORKS (shown once)
- Many agents work on the same goal in parallel. The board guarantees that no two of them work on the same idea.
- You are in a queue. Only the agent at position 1 gets to see the board, so nobody pays to read a board that is about to change.
- On your turn you receive every card: ideas already taken, partial results, dead ends. If your idea is already there — in substance, not just in wording — choose a different approach that is NOT on the board, then claim a card.
- Your card is your workspace: note() progress now and then, add_finding() for every insight someone else could reuse. Negative results count.
- Finish with exactly one of: submit_proof, submit_derivation, report_dead_end. Then stop. One agent, one card.
- You never verify your own result. A fresh agent with no stake in it does that.`;

export function statusLabel(c) {
  switch (c.status) {
    case 'active':
      return 'in progress';
    case 'open':
      return 'waiting for an agent';
    case 'proof':
      return { in_review: 'proof · in review', verified: 'proof · VERIFIED', refuted: 'proof · REFUTED', inconclusive: 'proof · review inconclusive', unreviewed: 'proof · unreviewed' }[c.proofStatus] ?? 'proof';
    case 'derivation':
      return c.followupId ? `partial result → continued in ${c.followupId}` : 'partial result';
    case 'dead_end':
      return 'dead end';
    case 'abandoned':
      return 'abandoned · free to retry';
    case 'reviewed':
      return 'review done';
    case 'reported':
      return 'result written';
    default:
      return c.status;
  }
}

function cardLines(c) {
  const lines = [`${c.id} [${statusLabel(c)}] ${c.title} — ${c.approach}`];
  if (c.takeaway) lines.push(`    ↳ ${c.takeaway}`);
  if (c.salvageable) lines.push(`    ↳ may still work: ${c.salvageable}`);
  if (c.openNextStep) lines.push(`    ↳ next step nobody has taken: ${c.openNextStep}`);
  return lines.join('\n');
}

function boardBlock(board, maxCards = 150) {
  const n = board.counts;
  const parts = [
    `${n.cards} cards`,
    `${n.active} in progress`,
    `${n.proofs} proofs (${n.verified} verified, ${n.refuted} refuted)`,
    `${n.derivations} partial results`,
    `${n.deadEnds} dead ends`,
    `${n.findings} findings`,
  ];
  const lines = [`BOARD · ${parts.join(' · ')}`];
  if (board.result && !board.result.finished && board.result.missing)
    lines.push(`STILL MISSING for the goal (checked on ${board.result.cardId}): ${board.result.missing}`);
  if (!board.cards.length) lines.push('(empty — you are the first)');
  for (const c of board.cards.slice(0, maxCards)) lines.push(cardLines(c));
  if (board.cards.length > maxCards)
    lines.push(`… ${board.cards.length - maxCards} older cards not shown. Use search_knowledge("<your idea>") to check them.`);
  if (board.findings.length) {
    lines.push('', 'LATEST FINDINGS (search_knowledge for more)');
    for (const f of board.findings) lines.push(`${f.id} [${f.kind} · ${f.confidence} · ${f.cardId}] ${f.statement}`);
  }
  return lines.join('\n');
}

export function renderTurn(res) {
  const out = [
    `YOUR TURN — the board is yours for the next ${res.secondsLeft}s; nobody else can claim a card until you do. That is enough time to choose well, and what you claim now is what you will work on for hours.`,
    '',
    `Your queued idea: "${short(res.idea, 300)}"`,
    '',
  ];
  if (res.similar.length) {
    out.push('Possibly the same as your idea — check these first:');
    for (const s of res.similar) out.push(`  ! ${s.id} [${s.status}] ${s.title} (word overlap ${s.score})`);
  } else if (res.board.cards.length) {
    out.push('No card shares much wording with your idea. Still read the list: the same idea can be phrased very differently.');
  }
  out.push('', boardBlock(res.board), '');
  out.push(
    'NOW DO EXACTLY ONE OF',
    '- Your idea is not on the board → claim_card(title, approach).',
    '- Your idea is already there, in substance → do not take the first alternative that comes to mind. Think of two or three approaches that are NOT on the board and claim the one most likely to get to the goal: claim_card(title, approach, pivoted_from: "<id of the card that already has your idea>", builds_on: [<ids you start from>]).',
    '  Good starting points: a "may still work" line of a dead end, an obstruction someone found and a way around it, a finding nobody has used yet, what is STILL MISSING. read_card(id) shows a card in full if a line is not enough; there is time for that.',
    '- You have nothing new to add → pass_turn.',
  );
  return out.join('\n');
}

export function renderWaiting(res) {
  return `Waiting — queue position ${res.position}. Call wait_turn again.`;
}

export function renderGate(res) {
  const lines = ['NOT CLAIMED — this looks like a card that already exists:'];
  for (const s of res.similar) lines.push(`  ${s.id} [${s.status}] ${s.title} (word overlap ${s.score})`);
  lines.push(
    '',
    'If it is the same idea: pick a different approach and call claim_card again.',
    'If it only sounds similar: call claim_card again with different_because: "<one sentence on what is substantively different>".',
  );
  return lines.join('\n');
}

const WORK_RULES = `WHILE YOU WORK
- note(text): short progress notes, a few per card — they are the card's lab notebook and keep your lease alive.
- add_finding(statement, kind, confidence): every reusable insight, including negative ones. Reference earlier findings with builds_on / contradicts.
- search_knowledge(query) / read_card(id): look up what others established. Build on it instead of redoing it.

- Do the work for real: run the code, look things up. A result nobody executed is not a result.

HOW YOU FINISH (exactly one, then stop)
- submit_proof: you believe the goal is solved. Give the precise claim and the complete argument. Do not polish or self-certify it — an independent agent reviews it.
- submit_derivation: you solved a part, or the approach survived every attempt to refute it but is not finished. State what is established and the concrete next step; a fresh agent continues from there.
- report_dead_end: the approach does not work. Say exactly why — that reason saves every later agent the same trip.
Be honest about which one it is. A clear dead end is worth more than an inflated proof.
If your environment stopped you (a command was denied, a tool is missing) and you established nothing, do not dress that up as a partial result: call report_dead_end with why_it_fails starting with "BLOCKED:" and the exact command and error.`;

export function renderClaimed(res) {
  return [
    `CLAIMED — ${res.card.id} "${res.card.title}" is yours. The queue has moved on; your research now runs in parallel with everyone else's.`,
    '',
    'START HERE: before you invest hours, take a few minutes to find out whether this exact approach is already known, solved or refuted. Search the web (your knowledge has a cutoff) and the board (search_knowledge), and put what you find into your first note.',
    '',
    WORK_RULES,
  ].join('\n');
}

function notesBlock(notes, title) {
  if (!notes?.length) return [];
  return ['', title, ...notes.map((n) => `- ${n.system ? '[system] ' : ''}${n.text}`)];
}

/** What a previous agent left on a reopened card: findings and files (notes are rendered separately). */
function handoverBlock(b) {
  const out = [];
  if (b.previousFindings?.length) {
    out.push('', 'FINDINGS ALREADY RECORDED ON THIS CARD');
    for (const f of b.previousFindings) out.push(`${f.id} [${f.kind} · ${f.confidence}] ${f.statement}`);
  }
  if (b.previousWorkspaces?.length) out.push('', 'FILES LEFT BY THE PREVIOUS AGENT (scripts, data, partial output — read them before redoing anything)', ...b.previousWorkspaces.map((w) => `- ${w}`));
  return out;
}

export function renderBriefing({ agent, card, briefing: b }, { showToken = false } = {}) {
  const out = [];
  if (showToken) out.push(`You are agent "${agent.name}". Your token: ${agent.token}`, 'Pass this token to every other tool call.', '');
  if (card.kind === 'review') {
    out.push(
      `You are the independent reviewer on ${card.id}. It reviews the proof submitted on ${b.parentId} ("${b.authorCardTitle}").`,
      'You did not write this proof and have no stake in it. Your job is to try to break it.',
      '',
      'GOAL',
      b.goal,
      '',
      'CLAIM',
      b.claim,
      '',
      'SUBMITTED PROOF',
      b.proof,
    );
    if (b.assumptions) out.push('', 'STATED ASSUMPTIONS', b.assumptions);
    if (b.artifacts?.length) out.push('', 'ARTIFACTS (files the author points to)', ...b.artifacts.map((a) => `- ${a}`));
    out.push(...notesBlock(b.previousNotes, 'NOTES LEFT ON THIS REVIEW CARD BY A PREVIOUS REVIEWER'), ...handoverBlock(b));
    out.push(
      '',
      'HOW TO REVIEW',
      "1. Attack it. Check every step, hidden assumptions, circularity, edge cases, and whether the claim really settles the GOAL as stated. Re-derive and re-run instead of trusting. You deliberately cannot see the author's working notes — only what was submitted.",
      '2. Design a test the user can run themselves that does NOT reuse the author\'s reasoning, code or data (a different method, an independent tool, a formal checker, a brute-force check, a known reference).',
      '3. Call submit_review with a verdict (verified / refuted / inconclusive) and the four report sections:',
      '   what_was_found · assessment (why you believe it, or exactly where it breaks) · independent_test · why_independent',
      'Only say "verified" if you could not break it and would defend it yourself. If unsure: "inconclusive". The report is written for the human user — plain, specific, no jargon without explanation.',
      'You may use note() and add_finding() while you work. Then stop: one agent, one card.',
    );
    return out.join('\n');
  }
  if (card.kind === 'check') {
    out.push(
      `You are the result checker on ${card.id}.${b.triggeredBy ? ` A proof on ${b.triggeredBy} was just verified by an independent reviewer.` : ''}`,
      'Your job: decide whether everything established so far reaches the GOAL, and write the result for the user. You do no new research.',
      '',
      'GOAL',
      b.goal,
      '',
      'VERIFIED PROOFS (checked by an agent that did not write them)',
    );
    if (!b.verified.length) out.push('(none)');
    for (const p of b.verified) out.push(`${p.id} "${p.title}": ${p.claim}${p.assumptions ? `\n    assumes: ${short(p.assumptions, 400)}` : ''}${p.review ? `\n    reviewer: ${short(p.review, 500)}` : ''}`);
    if (b.unsettled.length) out.push('', 'PROOFS THAT ARE NOT VERIFIED (do not count them as established)', ...b.unsettled.map((p) => `${p.id} [${p.proofStatus}] ${p.claim}`));
    if (b.partial.length) out.push('', 'PARTIAL RESULTS', ...b.partial.map((p) => `${p.id} [${p.confidence ?? 'unrated'}] ${p.established}`));
    if (b.solidFindings.length) out.push('', 'FINDINGS RATED proven / checked / verified', ...b.solidFindings.map((f) => `${f.id} [${f.kind} · ${f.confidence} · ${f.cardId}] ${f.statement}`));
    if (b.previousResult) out.push('', `THE PREVIOUS RESULT (${b.previousResult.cardId}, ${b.previousResult.finished ? 'finished' : 'not finished'})`, b.previousResult.summary, ...(b.previousResult.missing ? ['Missing then:', b.previousResult.missing] : []));
    out.push(...notesBlock(b.previousNotes, 'NOTES LEFT ON THIS CARD BY A PREVIOUS CHECKER'));
    out.push(
      '',
      'HOW TO CHECK',
      '1. Read the goal exactly, especially what it says counts as solved. read_card(id) shows any proof in full.',
      '2. Decide: is the goal fully reached by the verified proofs — or by established results whose combination is immediate and which you checked yourself? A proof of a special case, a weaker statement or a different claim does not finish the goal.',
      '3. Call submit_result with:',
      '   finished: true or false',
      '   summary: what is established so far, as Markdown bullet points, each naming its card ids. It becomes result.md for the user, so write it for a human.',
      '   missing: what is still needed to reach the goal (required when finished is false). Researchers read it to know what to attack next.',
      '   based_on: the ids your verdict rests on.',
      'Be strict: "finished" stops every agent. Then stop: one agent, one card.',
    );
    return out.join('\n');
  }
  if (!b.parentId) {
    // An idea card whose agent was interrupted: take it over where it stopped.
    out.push(
      `You are taking over ${card.id}: "${card.title}". The agent that claimed it was interrupted before it finished; the idea and everything it left behind are yours now. You skipped the queue.`,
      '',
      'GOAL',
      b.goal,
      '',
      'THE APPROACH OF THIS CARD',
      b.approach,
      ...notesBlock(b.previousNotes, 'LAB NOTEBOOK SO FAR'),
      ...handoverBlock(b),
      '',
      'Continue from where it stopped instead of starting over. Check what is already there first.',
      '',
      WORK_RULES,
    );
    return out.join('\n');
  }
  out.push(
    `You are now working on ${card.id}: "${card.title}". You skipped the queue because this card continues an existing result (${b.parentId}).`,
    '',
    'GOAL',
    b.goal,
    '',
    `INHERITED FROM ${b.parentId} "${b.parentTitle}"`,
    `Approach: ${b.parentApproach}`,
    `Established: ${b.established}`,
    '',
    'YOUR TASK (the next step)',
    b.nextStep,
  );
  if (b.openQuestions) out.push('', 'OPEN QUESTIONS', b.openQuestions);
  if (b.parentFindings?.length) {
    out.push('', `FINDINGS FROM ${b.parentId}`);
    for (const f of b.parentFindings) out.push(`${f.id} [${f.kind} · ${f.confidence}] ${f.statement}`);
  }
  if (b.parentWorkspaces?.length) out.push('', `FILES FROM ${b.parentId} (scripts, data, output — reuse them instead of rewriting)`, ...b.parentWorkspaces.map((w) => `- ${w}`));
  if (b.lineage?.length > 1) out.push('', `Lineage: ${b.lineage.map((l) => l.id).join(' → ')} → ${card.id}`);
  out.push(...notesBlock(b.previousNotes, 'NOTES LEFT ON THIS CARD BY A PREVIOUS AGENT'), ...handoverBlock(b));
  out.push(
    '',
    `You are not the author of what you inherit: sanity-check it before you build on it. read_card("${b.parentId}") shows the full notes.`,
    '',
    WORK_RULES,
  );
  return out.join('\n');
}

export function renderCard(d) {
  const out = [`${d.id} [${statusLabel({ ...d, followupId: d.outcome?.followupId })}] ${d.title}`, `Kind: ${d.kind}${d.agentName ? ` · agent: ${d.agentName}` : ''}`];
  if (d.lineage.length > 1) out.push(`Lineage: ${d.lineage.map((l) => l.id).join(' → ')}`);
  out.push('', 'APPROACH', d.approach);
  const o = d.outcome;
  if (o?.type === 'proof') {
    out.push('', 'CLAIM', o.claim, '', 'PROOF', o.proof);
    if (o.assumptions) out.push('', 'ASSUMPTIONS', o.assumptions);
    if (o.artifacts?.length) out.push('', 'ARTIFACTS', ...o.artifacts.map((a) => `- ${a}`));
  } else if (o?.type === 'derivation') {
    out.push('', 'ESTABLISHED', o.established, '', 'NEXT STEP', o.nextStep);
    if (o.openQuestions) out.push('', 'OPEN QUESTIONS', o.openQuestions);
  } else if (o?.type === 'dead_end') {
    out.push('', 'WHY IT FAILS', o.whyItFails);
    if (o.salvageable) out.push('', 'SALVAGEABLE', o.salvageable);
  } else if (o?.type === 'review') {
    out.push('', `VERDICT: ${o.verdict}`, '', 'WHAT WAS FOUND', o.whatWasFound, '', 'ASSESSMENT', o.assessment, '', 'INDEPENDENT TEST', o.independentTest, '', 'WHY IT IS INDEPENDENT', o.whyIndependent);
    if (o.flaws) out.push('', 'FLAWS', o.flaws);
  } else if (o?.type === 'result') {
    out.push('', `RESULT: ${o.finished ? 'the goal is reached' : 'not finished yet'}`, o.summary);
    if (o.missing) out.push('', 'STILL MISSING', o.missing);
  }
  for (const r of d.reviews) {
    if (r.outcome) out.push('', `REVIEW ${r.id}: ${r.outcome.verdict.toUpperCase()}`, r.outcome.assessment, ...(r.outcome.flaws ? [`Flaws: ${r.outcome.flaws}`] : []));
    else out.push('', `REVIEW ${r.id}: ${r.status}`);
  }
  if (d.findings.length) {
    out.push('', 'FINDINGS');
    for (const f of d.findings) out.push(`${f.id} [${f.kind} · ${f.confidence}] ${f.statement}${f.detail ? `\n    ${short(f.detail, 400)}` : ''}`);
  }
  if (d.notesHidden) out.push('', "NOTES: hidden — you are reviewing this card and must judge the submitted proof on its own.");
  else if (d.notes.length) out.push(...notesBlock(d.notes.slice(-40), `NOTES (${d.notes.length})`));
  if (d.children.length) out.push('', 'CHILD CARDS', ...d.children.map((c) => `${c.id} [${statusLabel(c)}] ${c.title}`));
  return out.join('\n');
}

export function renderSearch(results, query) {
  if (!results.length) return `Nothing on the board matches "${query}".`;
  return results
    .map((r) =>
      r.type === 'finding'
        ? `${r.id} [finding · ${r.kind} · ${r.confidence} · from ${r.cardId}] ${r.statement}${r.detail ? `\n    ${short(r.detail, 300)}` : ''}`
        : cardLines(r),
    )
    .join('\n');
}
