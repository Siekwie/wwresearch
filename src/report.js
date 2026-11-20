// Markdown exports: the full research report and the per-proof review report.

const VERDICT_LABEL = { verified: 'Verified', refuted: 'Refuted', inconclusive: 'Inconclusive' };

function reviewSections(o) {
  const lines = [
    '#### 1. What was found',
    o.whatWasFound,
    '',
    o.verdict === 'verified' ? '#### 2. Why the reviewer believes it is correct' : '#### 2. Assessment',
    o.assessment,
    '',
    '#### 3. How you can test it yourself',
    o.independentTest,
    '',
    '#### 4. Why that test is independent of the research',
    o.whyIndependent,
  ];
  if (o.flaws) lines.push('', '#### Flaws', o.flaws);
  return lines;
}

/** The report a reviewer wrote for the user about one proof. */
export function reviewReport(board, reviewCardId) {
  const s = board.state;
  const review = s.cards[reviewCardId];
  const proof = s.cards[review.parentId];
  const o = review.outcome;
  return [
    `# ${VERDICT_LABEL[o.verdict]}: ${proof.outcome.claim}`,
    '',
    `- Proof card: **${proof.id}** — ${proof.title} (by ${s.agents[proof.agentId]?.name ?? 'unknown'})`,
    `- Review card: **${review.id}** (by ${s.agents[review.agentId]?.name ?? 'unknown'}, an agent that did not work on the proof)`,
    `- Verdict: **${o.verdict}**`,
    '',
    ...reviewSections(o).map((l) => l.replace(/^####/, '##')),
    '',
    '## The submitted proof',
    '',
    proof.outcome.proof,
    ...(proof.outcome.assumptions ? ['', '### Stated assumptions', '', proof.outcome.assumptions] : []),
    ...(proof.outcome.artifacts?.length ? ['', '### Artifacts', '', ...proof.outcome.artifacts.map((a) => `- \`${a}\``)] : []),
    '',
  ].join('\n');
}

/** Everything the swarm learned, as one Markdown document. */
export function fullReport(board) {
  const s = board.state;
  const cards = Object.values(s.cards);
  const work = cards.filter((c) => c.kind !== 'review');
  const reviewOf = (c) => c.childIds.map((id) => s.cards[id]).find((r) => r.kind === 'review' && r.status === 'reviewed');
  const by = (fn) => work.filter(fn);
  const out = [`# Research report: ${s.project.title}`, '', '## Goal', '', s.project.goal, ''];

  const proofs = by((c) => c.status === 'proof');
  out.push(
    '## At a glance',
    '',
    `- ${work.length} approaches explored (${s.stats.duplicatesAvoided} duplicates avoided by the board)`,
    `- ${proofs.filter((c) => c.proofStatus === 'verified').length} proofs verified by an independent agent, ${proofs.filter((c) => c.proofStatus === 'refuted').length} refuted, ${proofs.filter((c) => !['verified', 'refuted'].includes(c.proofStatus)).length} open`,
    `- ${by((c) => c.status === 'derivation').length} partial results, ${by((c) => c.status === 'dead_end').length} dead ends`,
    `- ${Object.keys(s.findings).length} findings in the knowledge graph`,
    '',
  );

  const section = (title, list, render) => {
    if (!list.length) return;
    out.push(`## ${title}`, '');
    for (const c of list) out.push(...render(c), '');
  };

  section('Verified results', proofs.filter((c) => c.proofStatus === 'verified'), (c) => [
    `### ${c.id} · ${c.outcome.claim}`,
    '',
    `*Approach:* ${c.title} — ${c.approach}`,
    '',
    ...reviewSections(reviewOf(c).outcome),
    '',
    '<details><summary>The submitted proof</summary>',
    '',
    c.outcome.proof,
    '',
    '</details>',
  ]);

  section('Proofs that did not survive review', proofs.filter((c) => c.proofStatus === 'refuted'), (c) => [
    `### ${c.id} · ${c.title}`,
    '',
    `*Claimed:* ${c.outcome.claim}`,
    '',
    `*Why it fails:* ${reviewOf(c)?.outcome.flaws ?? '—'}`,
  ]);

  section('Proofs not yet settled', proofs.filter((c) => !['verified', 'refuted'].includes(c.proofStatus)), (c) => [
    `### ${c.id} · ${c.title} (${c.proofStatus})`,
    '',
    `*Claimed:* ${c.outcome.claim}`,
    ...(reviewOf(c) ? ['', `*Reviewer:* ${reviewOf(c).outcome.assessment}`] : []),
  ]);

  section('Partial results', by((c) => c.status === 'derivation'), (c) => [
    `### ${c.id} · ${c.title}`,
    '',
    `*Established:* ${c.outcome.established}`,
    '',
    `*Next step:* ${c.outcome.nextStep}${c.outcome.followupId ? ` (continued in ${c.outcome.followupId})` : ''}`,
  ]);

  section('Dead ends — and what they taught', by((c) => c.status === 'dead_end'), (c) => [
    `### ${c.id} · ${c.title}`,
    '',
    `*Why it fails:* ${c.outcome.whyItFails}`,
    ...(c.outcome.salvageable ? ['', `*Salvageable:* ${c.outcome.salvageable}`] : []),
  ]);

  section('Still running or unfinished', by((c) => ['active', 'open', 'abandoned'].includes(c.status)), (c) => [`- **${c.id}** (${c.status}) ${c.title} — ${c.approach}`]);

  const findings = Object.values(s.findings);
  if (findings.length) {
    out.push('## Knowledge graph: all findings', '', '| Id | Kind | Confidence | From | Statement | Builds on | Contradicts |', '|---|---|---|---|---|---|---|');
    const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
    for (const f of findings)
      out.push(`| ${f.id} | ${f.kind} | ${f.confidence} | ${f.cardId} | ${cell(f.statement)} | ${f.buildsOn.join(', ')} | ${f.contradicts.join(', ')} |`);
    out.push('');
  }
  return out.join('\n');
}
