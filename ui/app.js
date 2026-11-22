import { createGraph, findingHue } from './graph.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// Agent-written text is untrusted: always escape, then allow only `code` spans.
const prose = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let state = null;
let clockOffset = 0;
let firstRender = true;
let drawer = null; // { type: 'card' | 'finding' | 'goal', id }
let graph = null;
let findingFilter = '';

// --------------------------------------------------------------------- time
const now = () => Date.now() + clockOffset;
function ago(t) {
  const s = Math.max(0, Math.round((now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const clock = (t) => new Date(t).toTimeString().slice(0, 8);
function span(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const timeTag = (t) => `<time data-t="${t}">${ago(t)}</time>`;
setInterval(() => {
  for (const el of document.querySelectorAll('time[data-t]')) el.textContent = ago(Number(el.dataset.t));
  for (const el of document.querySelectorAll('[data-until]')) el.textContent = `${Math.max(0, Math.round((Number(el.dataset.until) - now()) / 1000))}s`;
}, 1000);

// ------------------------------------------------------------ keyed renderer
/** Reconcile a container's children with a list of items, keeping DOM nodes (and their animations) stable. */
function sync(container, items, { tag = 'div', key, html, cls, attrs, empty }) {
  const existing = new Map();
  for (const el of [...container.children]) {
    if (el.dataset.key) existing.set(el.dataset.key, el);
    else el.remove();
  }
  let prev = null;
  for (const item of items) {
    const k = key(item);
    let el = existing.get(k);
    let fresh = false;
    if (el) existing.delete(k);
    else {
      el = document.createElement(tag);
      el.dataset.key = k;
      fresh = !firstRender;
    }
    const markup = html(item);
    if (el.__html !== markup) {
      el.innerHTML = markup;
      el.__html = markup;
    }
    el.className = cls ? cls(item) : '';
    if (fresh) el.classList.add('enter');
    for (const [name, value] of Object.entries(attrs?.(item) ?? {})) el.setAttribute(name, value);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (el !== want) container.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  if (!items.length && empty) container.insertAdjacentHTML('beforeend', `<div class="empty">${empty}</div>`);
}

// -------------------------------------------------------------------- cards
const cardState = (c) => (c.status === 'proof' ? c.proofStatus : c.status);
const reviewOf = (c) => c.childIds.map((id) => state.cards[id]).find((r) => r?.kind === 'review' && r.outcome);

function badge(c) {
  if (c.status === 'open') return 'awaiting agent';
  if (c.status === 'abandoned') return 'abandoned';
  if (c.status === 'proof') return { in_review: 'in review', verified: '✓ verified', refuted: '✗ refuted', inconclusive: 'inconclusive', unreviewed: 'unreviewed' }[c.proofStatus];
  if (c.status === 'reviewed') return { verified: '✓ verified', refuted: '✗ refuted', inconclusive: 'inconclusive' }[c.outcome?.verdict];
  return null;
}

function kindText(c) {
  if (c.kind === 'followup') return `continues ${c.parentId}`;
  if (c.kind === 'review') return `reviews ${c.parentId}`;
  return '';
}

function takeaway(c) {
  const o = c.outcome;
  if (!o) return '';
  const box = (label, text) => `<div class="takeaway"><p class="clamp"><b>${label}</b>${esc(text)}</p></div>`;
  if (o.type === 'derivation') return box('Established', o.established);
  if (o.type === 'dead_end') return box('Why it fails', o.whyItFails);
  if (o.type === 'proof') {
    const review = reviewOf(c);
    if (c.proofStatus === 'refuted' && review?.outcome.flaws) return box('Flaw found', review.outcome.flaws);
    return box('Claim', o.claim);
  }
  return '';
}

function cardHtml(c) {
  const b = badge(c);
  const foot = [];
  if (c.agentName) foot.push(`<span class="agent"><i></i>${esc(c.agentName)}</span>`);
  if (c.pivotedFrom) foot.push(`<span class="chip" title="This agent came with an idea that ${esc(c.pivotedFrom)} already covered, and picked a new one">↪ redirected from ${esc(c.pivotedFrom)}</span>`);
  if (c.outcome?.followupId) foot.push(`<span>→ ${esc(c.outcome.followupId)}</span>`);
  if (c.findingIds.length) foot.push(`<span>${plural(c.findingIds.length, 'finding')}</span>`);
  foot.push(timeTag(c.closedAt ?? c.claimedAt ?? c.createdAt));
  const live = c.status === 'active' && c.lastNote && !c.lastNote.system ? `<p class="live-note clamp">${esc(c.lastNote.text)}</p>` : '';
  return `
    <div class="card-top"><span class="id">${esc(c.id)}</span><span class="kind" title="${esc(kindText(c))}">${c.parentId ? `${c.kind === 'review' ? 'reviews' : '↳'} ${esc(c.parentId)}` : ''}</span><span class="spacer"></span>${b ? `<span class="badge">${b}</span>` : ''}</div>
    <h3>${esc(c.title)}</h3>
    ${c.kind === 'review' ? '' : `<p class="approach clamp">${esc(c.approach)}</p>`}
    ${takeaway(c)}${live}
    <div class="card-foot">${foot.join('')}</div>`;
}

const COLUMNS = [
  { id: 'queue', title: 'Queue', hue: 'var(--accent)', sub: 'Only position 1 sees the board', empty: 'Nobody is waiting.' },
  { id: 'active', title: 'In progress', hue: 'var(--progress)', empty: 'No card is being worked on.' },
  { id: 'partial', title: 'Partial results', hue: 'var(--partial)', empty: 'Solved parts and unrefuted approaches land here — and get continued by a fresh agent.' },
  { id: 'proofs', title: 'Proofs', hue: 'var(--verified)', empty: 'Submitted proofs land here and are checked by an agent that did not write them.' },
  { id: 'dead', title: 'Dead ends', hue: 'var(--dead)', empty: 'Approaches that led nowhere — kept, because the reason is knowledge.' },
];

function columnOf(c) {
  if (c.status === 'active' || c.status === 'open') return 'active';
  if (c.kind === 'review') return null; // finished reviews live on their proof card
  if (c.status === 'derivation') return 'partial';
  if (c.status === 'proof') return 'proofs';
  return 'dead';
}

function renderBoard() {
  const root = $('#columns');
  if (!root.children.length) {
    root.innerHTML = COLUMNS.map(
      (col) => `
      <section class="col" style="--hue:${col.hue}">
        <div class="col-head"><h2>${col.title}</h2><span class="count" id="count-${col.id}"></span></div>
        ${col.sub ? `<div class="col-sub">${col.sub}</div>` : ''}
        <div class="col-body" id="col-${col.id}"></div>
      </section>`,
    ).join('');
  }

  // FLIP: remember where every card was, so cards glide between columns.
  const before = new Map();
  for (const el of root.querySelectorAll('.card')) before.set(el.dataset.key, el.getBoundingClientRect());

  const cards = Object.values(state.cards);
  const groups = { active: [], partial: [], proofs: [], dead: [] };
  for (const c of cards) {
    const col = columnOf(c);
    if (col) groups[col].push(c);
  }
  const recent = (a, b) => (b.closedAt ?? b.claimedAt ?? b.createdAt) - (a.closedAt ?? a.claimedAt ?? a.createdAt) || b.id.localeCompare(a.id, undefined, { numeric: true });
  groups.active.sort((a, b) => a.createdAt - b.createdAt);
  for (const id of ['partial', 'proofs', 'dead']) groups[id].sort(recent);

  for (const col of COLUMNS) {
    const items = col.id === 'queue' ? state.queue : groups[col.id];
    $(`#count-${col.id}`).textContent = items.length || '';
    if (col.id === 'queue') {
      sync($('#col-queue'), items, {
        key: (q) => q.agentId,
        cls: (q) => `q-item${q.onTurn ? ' turn' : ''}`,
        html: (q) => `
          <span class="pos">${q.position}</span>
          <div><b>${esc(q.name)}</b>${q.onTurn ? `<div class="state">reading the board · <span data-until="${q.turnEndsAt}">${Math.max(0, Math.round((q.turnEndsAt - now()) / 1000))}s</span></div>` : ''}
          <p class="clamp">${esc(q.idea)}</p></div>`,
        empty: col.empty,
      });
    } else {
      sync($(`#col-${col.id}`), items, {
        tag: 'article',
        key: (c) => c.id,
        cls: (c) => `card k-${c.kind} s-${cardState(c)}`,
        attrs: (c) => ({ tabindex: 0, role: 'button', 'data-card': c.id }),
        html: cardHtml,
        empty: col.empty,
      });
    }
  }

  if (!firstRender) {
    for (const el of root.querySelectorAll('.card')) {
      const from = before.get(el.dataset.key);
      if (!from) continue;
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      el.classList.remove('enter');
      el.animate([{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 2 }, { transform: 'none', zIndex: 2 }], { duration: 520, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
  }
}

// --------------------------------------------------------------------- feed
const FEED = {
  queue_joined: ['·', 'var(--faint)', true],
  turn_passed: ['·', 'var(--faint)', true],
  turn_expired: ['!', 'var(--review)'],
  queue_dropped: ['!', 'var(--review)'],
  card_claimed: ['◆', 'var(--progress)'],
  card_entered: ['◆', 'var(--progress)'],
  card_opened: ['○', 'var(--muted)', true],
  finding_added: ['+', 'var(--finding)'],
  proof_submitted: ['★', 'var(--review)'],
  derivation_submitted: ['→', 'var(--partial)'],
  dead_end: ['×', 'var(--dead)'],
  card_abandoned: ['!', 'var(--review)'],
};

function renderFeed() {
  const items = state.feed
    .filter((ev) => FEED[ev.type] || ev.type === 'review_submitted')
    .slice(-70)
    .reverse();
  sync($('#feed'), items, {
    tag: 'li',
    key: (ev) => String(ev.seq),
    attrs: (ev) => (ev.cardId ? { 'data-card': ev.type === 'review_submitted' ? ev.parentId : ev.cardId } : {}),
    html: (ev) => {
      let [ico, hue, minor] = FEED[ev.type] ?? [];
      if (ev.type === 'review_submitted') [ico, hue] = ev.verdict === 'verified' ? ['✔', 'var(--verified)'] : ev.verdict === 'refuted' ? ['✘', 'var(--refuted)'] : ['?', 'var(--review)'];
      return `<span class="ico" style="--hue:${hue}">${ico}</span><span class="${minor ? 'minor clamp' : ''}">${esc(ev.text)}</span>${timeTag(ev.at)}`;
    },
  });
}

// ------------------------------------------------------------------- header
function renderHeader() {
  const cards = Object.values(state.cards);
  const o = state.orchestrator;
  document.title = `${state.project.title} · wwresearch`;
  $('#goal').textContent = state.project.title;
  const verified = cards.filter((c) => c.proofStatus === 'verified').length;
  const stats = [
    ['', cards.filter((c) => c.kind === 'idea').length, 'approaches'],
    ['hot', state.stats.duplicatesAvoided, 'duplicates avoided'],
    ['', Object.keys(state.findings).length, 'findings'],
    ['good', verified, 'verified proofs'],
  ];
  if (o.costUsd > 0) stats.push(['', `$${o.costUsd.toFixed(2)}`, 'spent']);
  $('#stats').innerHTML = stats.map(([cls, n, label]) => `<div class="stat ${cls}"><b>${n}</b><span>${label}</span></div>`).join('');

  const controls = [];
  if (o.enabled) {
    controls.push(`
      <div class="stepper" title="Number of agents the orchestrator keeps alive">
        <button data-act="fewer" aria-label="Fewer agents">−</button>
        <div class="value"><b>${o.live} / ${o.target}</b><span>agents live / target</span></div>
        <button data-act="more" aria-label="More agents">+</button>
      </div>
      ${
        o.paused
          ? `<button class="btn primary" data-act="resume" title="Start agents again">Start again</button>`
          : `<button class="btn danger" data-act="shutdown" title="Kill every running agent and everything it started, right now"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.5v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4.4 3.6a5.5 5.5 0 1 0 7.2 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>Shut down</button>`
      }`);
  }
  controls.push(`<button class="btn${o.enabled ? '' : ' primary'}" data-act="dock">Dock an agent</button>`);
  controls.push(`<button class="btn icon" data-act="theme" title="Switch light / dark" aria-label="Switch theme"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/></svg></button>`);
  const html = controls.join('');
  const el = $('#controls');
  if (el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }

  const banners = [];
  if (o.error) banners.push(`<div class="banner bad"><span>⚠ ${esc(o.error)}</span><span class="spacer"></span><button class="btn" data-act="resume">Resume</button></div>`);
  else if (o.paused)
    banners.push(
      `<div class="banner info"><span>${o.live ? `Shutting down — waiting for ${plural(o.live, 'agent')} to exit…` : 'Shut down — no agents are running, and every process they started was stopped too.'} The board stays readable.</span><span class="spacer"></span><button class="btn" data-act="resume">Start again</button></div>`,
    );
  if (verified) banners.push(`<div class="banner good"><span>✔ ${plural(verified, 'proof')} verified by an independent agent. <a href="#reports">Read the ${verified === 1 ? 'report' : 'reports'} →</a></span></div>`);
  if (o.enabled && o.idle && !o.paused)
    banners.push(
      state.project.demo
        ? `<div class="banner info"><span>Demo finished — everything you saw was simulated. Run it on your own question: <code>wwresearch run "&lt;your goal&gt;"</code></span></div>`
        : `<div class="banner info"><span>All agents are done${o.maxIdeas ? ` (the budget of ${o.maxIdeas} ideas is used up)` : ''}.</span><span class="spacer"></span><button class="btn" data-act="more-ideas">Explore ${Math.max(o.target, 4) * 2} more ideas</button></div>`,
    );
  const bh = banners.join('');
  const bel = $('#banners');
  if (bel.__html !== bh) {
    bel.innerHTML = bh;
    bel.__html = bh;
  }
  const reports = cards.filter((c) => c.kind === 'review' && c.outcome).length;
  $('#report-count').textContent = reports || '';
}

// ---------------------------------------------------------------- knowledge
function findingClass(f) {
  if (f.confidence === 'verified') return 'ok';
  if (f.confidence === 'refuted') return 'neg';
  return ['obstruction', 'counterexample', 'refutation'].includes(f.kind) ? 'neu' : '';
}

function findingHtml(f) {
  const rel = [];
  if (f.buildsOn.length) rel.push(`builds on ${f.buildsOn.map(esc).join(', ')}`);
  if (f.contradicts.length) rel.push(`contradicts ${f.contradicts.map(esc).join(', ')}`);
  return `
    <div class="meta"><span class="id">${esc(f.id)}</span><span>${esc(f.kind)} · ${esc(f.confidence)}</span><span class="spacer"></span><span>from ${esc(f.cardId)}</span></div>
    <p class="${f.confidence === 'refuted' ? 'struck' : ''}">${esc(f.statement)}</p>
    ${rel.length ? `<div class="meta" style="margin:5px 0 0">${rel.join(' · ')}</div>` : ''}`;
}

function renderKnowledge() {
  const all = Object.values(state.findings);
  $('#finding-count').textContent = all.length || '';
  const q = findingFilter.trim().toLowerCase();
  const items = all.filter((f) => !q || `${f.id} ${f.kind} ${f.statement} ${f.cardId}`.toLowerCase().includes(q)).reverse();
  sync($('#findings'), items, {
    tag: 'li',
    key: (f) => f.id,
    cls: (f) => `finding ${findingClass(f)}${drawer?.id === f.id ? ' sel' : ''}`,
    attrs: (f) => ({ 'data-finding': f.id, style: `--hue:${findingHue(f)}` }),
    html: findingHtml,
    empty: all.length ? 'No finding matches.' : 'Every reusable insight agents record — lemmas, observations, obstructions — appears here and in the graph.',
  });
  if ($('#view-graph').hidden) return;
  graph ??= createGraph($('#canvas'), {
    onSelect: (id) => (id && id !== 'goal' ? openDrawer({ type: id.startsWith('F-') ? 'finding' : 'card', id }) : id === 'goal' ? openDrawer({ type: 'goal' }) : null),
    onHover: showTip,
  });
  graph.update(state);
}

function showTip(id, ev) {
  const tip = $('#graph-tip');
  if (!id || !state) return void (tip.hidden = true);
  let meta;
  let body;
  if (id === 'goal') [meta, body] = ['Goal', state.project.title];
  else if (id.startsWith('F-')) {
    const f = state.findings[id];
    if (!f) return void (tip.hidden = true);
    [meta, body] = [`${f.id} · ${f.kind} · ${f.confidence} · from ${f.cardId}`, f.statement];
  } else {
    const c = state.cards[id];
    if (!c) return void (tip.hidden = true);
    [meta, body] = [`${c.id} · ${badge(c) ?? cardState(c).replace('_', ' ')}${kindText(c) ? ` · ${kindText(c)}` : ''}`, c.title];
  }
  tip.innerHTML = `<div class="meta">${esc(meta)}</div>${esc(body)}`;
  tip.hidden = false;
  const box = $('#canvas').getBoundingClientRect();
  const x = Math.min(ev.clientX - box.left + 14, box.width - tip.offsetWidth - 8);
  const y = Math.min(ev.clientY - box.top + 14, box.height - tip.offsetHeight - 8);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

function renderLegend() {
  const dot = (hue, label, shape = '') => `<span><i class="${shape}" style="--hue:${hue}"></i>${label}</span>`;
  $('#graph-legend').innerHTML = [
    dot('var(--progress)', 'card · in progress'),
    dot('var(--finding)', 'finding', 'sq'),
    dot('var(--partial)', 'card · partial result'),
    dot('var(--dead)', 'obstruction / dead end', 'sq'),
    dot('var(--review)', 'proof · in review'),
    dot('var(--partial)', 'continued by', 'ln'),
    dot('var(--verified)', 'verified'),
    dot('var(--accent)', 'builds on', 'ln'),
    dot('var(--refuted)', 'refuted'),
    dot('var(--refuted)', 'contradicts', 'ln dash'),
  ].join('');
}

// ------------------------------------------------------------------ reports
function reportSections(o) {
  const sections = [
    ['What was found', o.whatWasFound],
    [o.verdict === 'verified' ? 'Why the reviewer believes it is correct' : 'Assessment', o.assessment],
    ['How you can test it yourself', o.independentTest],
    ['Why that test is independent of the research', o.whyIndependent],
  ];
  return (
    sections.map(([title, body], i) => `<section><span class="n">${i + 1}</span><div><h3>${title}</h3><div class="prose">${prose(body)}</div></div></section>`).join('') +
    (o.flaws ? `<section><span class="n">!</span><div><h3>The flaw</h3><div class="prose">${prose(o.flaws)}</div></div></section>` : '')
  );
}

function reportHtml(review) {
  const proof = state.cards[review.parentId];
  const o = review.outcome;
  const label = { verified: '✓ verified', refuted: '✗ refuted', inconclusive: 'inconclusive' }[o.verdict];
  return `
    <article class="report ${esc(o.verdict)}">
      <div class="report-top"><span class="badge">${label}</span><span>${timeTag(review.closedAt)}</span><span class="spacer"></span><a href="/api/cards/${esc(review.id)}/report.md" target="_blank" rel="noopener">Markdown ↗</a></div>
      <h2>${esc(proof.outcome.claim)}</h2>
      <p class="by">Proof on <button class="link" data-card="${esc(proof.id)}">${esc(proof.id)} · ${esc(proof.title)}</button> by ${esc(proof.agentName ?? 'an agent')} · reviewed by ${esc(review.agentName ?? 'an agent')}, who did not work on it</p>
      ${reportSections(o)}
      <details class="proof"><summary>The submitted proof</summary><div class="prose">${prose(proof.outcome.proof)}</div></details>
    </article>`;
}

function renderReports() {
  const cards = Object.values(state.cards);
  const reviews = cards.filter((c) => c.kind === 'review' && c.outcome).sort((a, b) => b.closedAt - a.closedAt);
  const order = { verified: 0, inconclusive: 1, refuted: 2 };
  reviews.sort((a, b) => order[a.outcome.verdict] - order[b.outcome.verdict] || b.closedAt - a.closedAt);
  const pending = cards.filter((c) => c.status === 'proof' && ['in_review', 'unreviewed'].includes(c.proofStatus));
  const html = `
    <div class="reports">
      <header>
        <h1>Reports for you</h1>
        <p>A proof never certifies itself. Each one is checked by a fresh agent that did not write it, and that agent explains what was found, why it holds, and how you can test it without trusting any of this research.</p>
      </header>
      ${pending.length ? `<ul class="pending">${pending.map((c) => `<li data-card="${esc(c.id)}"><span class="id">${esc(c.id)}</span><span>${esc(c.title)}</span><span class="spacer"></span><span class="badge">${c.proofStatus === 'in_review' ? 'review in progress' : 'unreviewed'}</span></li>`).join('')}</ul>` : ''}
      ${reviews.map(reportHtml).join('')}
      ${!reviews.length && !pending.length ? '<div class="none">No proof has been submitted yet.<br />When an agent believes it solved the goal, an independent agent reviews the proof and its report appears here.</div>' : ''}
    </div>`;
  const el = $('#view-reports');
  if (el.__html !== html) {
    const open = new Set([...el.querySelectorAll('details[open]')].map((d) => d.closest('.report')?.querySelector('h2')?.textContent));
    el.innerHTML = html;
    el.__html = html;
    for (const d of el.querySelectorAll('details')) if (open.has(d.closest('.report')?.querySelector('h2')?.textContent)) d.open = true;
  }
}

// ------------------------------------------------------------------- drawer
const hueFor = (c) => {
  const s = cardState(c);
  const map = { derivation: 'partial', verified: 'verified', refuted: 'refuted', dead_end: 'dead', abandoned: 'dead', in_review: 'review', inconclusive: 'review', unreviewed: 'review', reviewed: 'review', open: 'dead' };
  let name = map[s] ?? 'progress';
  if (c.kind === 'review' && c.outcome) name = { verified: 'verified', refuted: 'refuted' }[c.outcome.verdict] ?? 'review';
  return `--hue:var(--${name});--soft:var(--${name}-soft)`;
};

const cardLink = (id) => `<button class="link" data-card="${esc(id)}">${esc(id)}</button>`;
const refLink = (id) => (id.startsWith('F-') ? `<button class="link" data-finding="${esc(id)}">${esc(id)}</button>` : cardLink(id));

function outcomeHtml(d) {
  const o = d.outcome;
  if (!o) return '';
  if (o.type === 'proof')
    return `<div class="block outcome"><h2>Proof submitted · ${esc(badge(d) ?? '')}</h2>
      <h4>Claim</h4><div class="prose">${prose(o.claim)}</div>
      <h4>Proof</h4><div class="prose">${prose(o.proof)}</div>
      ${o.assumptions ? `<h4>Assumptions</h4><div class="prose">${prose(o.assumptions)}</div>` : ''}
      ${o.artifacts?.length ? `<h4>Artifacts</h4><div class="prose">${o.artifacts.map((a) => `<code>${esc(a)}</code>`).join('\n')}</div>` : ''}</div>`;
  if (o.type === 'derivation')
    return `<div class="block outcome"><h2>Partial result</h2>
      <h4>Established</h4><div class="prose">${prose(o.established)}</div>
      <h4>Next step ${o.followupId ? `· continued in ${cardLink(o.followupId)}` : ''}</h4><div class="prose">${prose(o.nextStep)}</div>
      ${o.openQuestions ? `<h4>Open questions</h4><div class="prose">${prose(o.openQuestions)}</div>` : ''}</div>`;
  if (o.type === 'dead_end')
    return `<div class="block outcome"><h2>Dead end</h2>
      <h4>Why it fails</h4><div class="prose">${prose(o.whyItFails)}</div>
      ${o.salvageable ? `<h4>Worth keeping</h4><div class="prose">${prose(o.salvageable)}</div>` : ''}</div>`;
  if (o.type === 'review') return `<div class="block report ${esc(o.verdict)}" style="padding:16px 18px">${reportSections(o)}</div>`;
  return '';
}

async function renderDrawer() {
  const el = $('#drawer');
  if (!drawer) {
    el.hidden = true;
    $('#scrim').hidden = true;
    return;
  }
  let html = '';
  let style = '';
  const top = (idHtml) => `<div class="drawer-top">${idHtml}<span class="spacer"></span><button class="close" data-act="close" aria-label="Close">×</button></div>`;
  if (drawer.type === 'goal') {
    const p = state.project;
    html = `${top('<span class="badge" style="--hue:var(--accent);--soft:var(--accent-soft)">Goal</span>')}
      <h1>${esc(p.title)}</h1>
      <p class="metaline">Started ${ago(p.createdAt)} · ${state.stats.boardReads} board reads · ${plural(Object.keys(state.agents).length, 'agent')} so far</p>
      <div class="block"><h2>The goal, as given to every agent</h2><div class="prose">${prose(p.goal)}</div></div>
      <div class="block"><h2>Export</h2><p><a class="link" href="/api/report.md" target="_blank" rel="noopener">Everything that was learned, as Markdown ↗</a></p></div>`;
  } else if (drawer.type === 'finding') {
    const f = state.findings[drawer.id];
    if (!f) return closeDrawer();
    const usedBy = Object.values(state.findings).filter((x) => x.buildsOn.includes(f.id) || x.contradicts.includes(f.id));
    style = `--hue:${findingHue(f)};--soft:var(--surface-2)`;
    html = `${top(`<span class="id">${esc(f.id)}</span><span class="badge">${esc(f.kind)} · ${esc(f.confidence)}</span>`)}
      <h1 class="${f.confidence === 'refuted' ? 'struck' : ''}">${esc(f.statement)}</h1>
      <p class="metaline">Recorded ${ago(f.at)} on ${cardLink(f.cardId)} · ${esc(state.cards[f.cardId]?.title ?? '')}</p>
      ${f.detail ? `<div class="block"><h2>Detail</h2><div class="prose">${prose(f.detail)}</div></div>` : ''}
      ${f.buildsOn.length ? `<div class="block"><h2>Builds on</h2><p>${f.buildsOn.map(refLink).join(' · ')}</p></div>` : ''}
      ${f.contradicts.length ? `<div class="block"><h2>Contradicts</h2><p>${f.contradicts.map(refLink).join(' · ')}</p></div>` : ''}
      ${usedBy.length ? `<div class="block"><h2>Referenced by</h2><p>${usedBy.map((x) => refLink(x.id)).join(' · ')}</p></div>` : ''}`;
  } else {
    let d;
    try {
      d = await (await fetch(`/api/cards/${encodeURIComponent(drawer.id)}`)).json();
    } catch {
      return;
    }
    if (!drawer || drawer.id !== d.id) return;
    style = hueFor(d);
    const b = badge(d) ?? (d.status === 'active' ? 'in progress' : d.status.replace('_', ' '));
    const crumbs = d.lineage.length > 1 ? `<div class="crumbs">${d.lineage.map((l) => (l.id === d.id ? `<b>${esc(l.id)}</b>` : cardLink(l.id))).join(' → ')}</div>` : '';
    const dur = d.claimedAt ? ` · ${d.closedAt ? `worked for ${span(d.closedAt - d.claimedAt)}` : `started ${ago(d.claimedAt)}`}` : '';
    const pivot = d.pivotedFrom
      ? `<div class="pivot"><b>↪ Redirected by the board.</b> This agent arrived with the idea “${esc(d.originalIdea)}” — already covered by ${cardLink(d.pivotedFrom)}. It chose this approach instead.</div>`
      : d.differentBecause
        ? `<div class="pivot"><b>${d.flaggedSimilar ? 'The board flagged this as a possible duplicate.' : 'Close to an existing card.'}</b> Why the agent says it is different: “${esc(d.differentBecause)}”</div>`
        : '';
    const reviews = d.reviews.filter((r) => r.outcome && d.kind !== 'review');
    let dock = '';
    if (d.status === 'open') {
      const prompt = await (await fetch(`/api/prompt?role=card&card=${encodeURIComponent(d.id)}`)).text();
      dock = `<div class="block"><h2>Waiting for an agent</h2><p>With an orchestrator running, a fresh agent is spawned into this card automatically. To dock one by hand, give an agent this prompt:</p>${copyBox(prompt)}</div>`;
    }
    html = `${top(`<span class="id">${esc(d.id)}</span><span class="badge">${esc(b)}</span>`)}
      <h1>${esc(d.title)}</h1>
      ${crumbs}
      <p class="metaline">${esc(kindText(d) || 'Idea from the queue')}${d.agentName ? ` · ${esc(d.agentName)}` : ''}${dur}</p>
      ${pivot}
      <div class="block"><h2>${d.kind === 'review' ? 'Task' : 'Approach'}</h2><div class="prose">${prose(d.approach)}</div></div>
      ${d.buildsOn?.length ? `<div class="block"><h2>Builds on</h2><p>${d.buildsOn.map(refLink).join(' · ')}</p></div>` : ''}
      ${dock}
      ${outcomeHtml(d)}
      ${reviews.map((r) => `<div class="block"><h2>Independent review ${cardLink(r.id)} by ${esc(r.agentName ?? 'an agent')}</h2><div class="report ${esc(r.outcome.verdict)}" style="padding:16px 18px">${reportSections(r.outcome)}</div></div>`).join('')}
      ${d.findings.length ? `<div class="block"><h2>Findings</h2>${d.findings.map((f) => `<div class="finding ${findingClass(f)}" data-finding="${esc(f.id)}" style="--hue:${findingHue(f)}">${findingHtml(f)}</div>`).join('')}</div>` : ''}
      ${d.notes.length ? `<div class="block"><h2>Lab notebook</h2><ol class="notes">${d.notes.map((n) => `<li><time>${clock(n.at)}</time><span class="${n.system ? 'sys' : ''}">${prose(n.text)}</span></li>`).join('')}</ol></div>` : ''}
      ${d.children.length ? `<div class="block"><h2>Leads to</h2><p>${d.children.map((c) => `${cardLink(c.id)} ${esc(c.title)}`).join('<br />')}</p></div>` : ''}`;
  }
  const scroll = el.__key === `${drawer.type}:${drawer.id}` ? el.scrollTop : 0;
  if (el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
  el.setAttribute('style', style);
  el.__key = `${drawer.type}:${drawer.id}`;
  el.hidden = false;
  $('#scrim').hidden = false;
  el.scrollTop = scroll;
}

function openDrawer(target) {
  drawer = target;
  graph?.select(target.type === 'goal' ? 'goal' : target.id);
  renderDrawer();
  if (state && !$('#view-graph').hidden) renderKnowledge();
}

function closeDrawer() {
  drawer = null;
  graph?.select(null);
  renderDrawer();
}

// --------------------------------------------------------------------- dock
const copyBox = (text) => `<div class="copy"><pre>${esc(text)}</pre><button class="btn" data-act="copy">Copy</button></div>`;

async function openDock() {
  const mcp = `${location.origin}/mcp`;
  const prompt = await (await fetch('/api/prompt?role=researcher')).text();
  const dialog = $('#dock');
  dialog.innerHTML = `
    <h1>Dock an agent onto this board</h1>
    <p>Any agent that speaks MCP can join — in any number, from any machine that can reach this address.</p>
    <ol>
      <li>Connect the agent to the board (once). For Claude Code:${copyBox(`claude mcp add --transport http wwresearch ${mcp}`)}</li>
      <li>Send it to work. In Claude Code, run <code>/mcp__wwresearch__researcher</code> — or paste this prompt into any agent:${copyBox(prompt)}</li>
      <li>Follow-up and review cards skip the queue: <code>/mcp__wwresearch__open_card</code> docks an agent into the next card that is waiting.</li>
    </ol>
    <p style="margin-top:14px">No MCP? Every tool is also a plain HTTP call: <code>POST ${esc(location.origin)}/api/tool/join_queue</code></p>
    <div class="foot"><button class="btn primary" data-act="close-dock">Done</button></div>`;
  dialog.showModal();
}

// ------------------------------------------------------------------ routing
function route() {
  const view = ['board', 'graph', 'reports'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'board';
  for (const name of ['board', 'graph', 'reports']) $(`#view-${name}`).hidden = name !== view;
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('on', a.dataset.view === view);
  if (!state) return;
  if (view === 'graph') {
    renderKnowledge();
    graph?.wake();
  }
}

function render() {
  if (!state) return;
  renderHeader();
  renderBoard();
  renderFeed();
  renderKnowledge();
  renderReports();
  if (drawer) renderDrawer();
  firstRender = false;
}

// ------------------------------------------------------------------- events
async function setOrchestrator(patch) {
  await fetch('/api/orchestrator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
}

document.addEventListener('click', (ev) => {
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (act) {
    const o = state?.orchestrator;
    if (act === 'more') setOrchestrator({ target: o.target + 1 });
    else if (act === 'fewer') setOrchestrator({ target: Math.max(0, o.target - 1) });
    else if (act === 'shutdown') {
      const n = o.live;
      const msg = `Shut down ${plural(n, 'agent')} now?\n\nEvery running agent and everything it started (shells, scripts, background computations) is killed immediately. Their cards keep their notes and files and are handed to fresh agents when you start again.`;
      if (n && !confirm(msg)) return;
      fetch('/api/shutdown', { method: 'POST' });
    }
    else if (act === 'resume') setOrchestrator({ paused: false });
    else if (act === 'more-ideas') setOrchestrator({ maxIdeas: o.maxIdeas + Math.max(o.target, 4) * 2 });
    else if (act === 'dock') openDock();
    else if (act === 'close-dock') $('#dock').close();
    else if (act === 'close') closeDrawer();
    else if (act === 'theme') {
      const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
      document.documentElement.dataset.theme = dark ? 'light' : 'dark';
      try {
        localStorage.setItem('wwr-theme', document.documentElement.dataset.theme);
      } catch {
        /* private mode */
      }
    } else if (act === 'copy') {
      const btn = ev.target.closest('button');
      navigator.clipboard?.writeText(btn.parentElement.querySelector('pre').textContent).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1400);
      });
    }
    return;
  }
  const finding = ev.target.closest('[data-finding]')?.dataset.finding;
  if (finding) return openDrawer({ type: 'finding', id: finding });
  const card = ev.target.closest('[data-card]')?.dataset.card;
  if (card) return openDrawer({ type: 'card', id: card });
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && drawer && !$('#dock').open) closeDrawer();
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('.card')) {
    ev.preventDefault();
    openDrawer({ type: 'card', id: ev.target.dataset.card });
  }
});
$('#scrim').addEventListener('click', closeDrawer);
$('#goal').addEventListener('click', () => openDrawer({ type: 'goal' }));
$('#dock').addEventListener('click', (ev) => ev.target === ev.currentTarget && ev.currentTarget.close());
$('#finding-filter').addEventListener('input', (ev) => {
  findingFilter = ev.target.value;
  if (state) renderKnowledge();
});
window.addEventListener('hashchange', route);

// --------------------------------------------------------------------- data
let loading = false;
let again = false;
async function load() {
  if (loading) return void (again = true);
  loading = true;
  try {
    const res = await fetch('/api/state');
    state = await res.json();
    clockOffset = state.serverTime - Date.now();
    render();
  } catch {
    /* the event stream reports the connection state */
  }
  loading = false;
  if (again) {
    again = false;
    load();
  }
}

function connect() {
  const conn = $('#conn');
  const es = new EventSource('/api/events');
  es.onopen = () => {
    conn.className = 'conn live';
    conn.lastElementChild.textContent = 'live';
    load();
  };
  es.addEventListener('change', load);
  es.onerror = () => {
    conn.className = 'conn lost';
    conn.lastElementChild.textContent = 'board offline — retrying';
  };
}

try {
  const saved = localStorage.getItem('wwr-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch {
  /* private mode */
}
renderLegend();
route();
load();
connect();
