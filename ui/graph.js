// Knowledge graph: a small force-directed layout in plain SVG. No libraries.
//
// Nodes: the goal, every card, every finding. Edges: which card an idea or
// finding belongs to, which result continues which, what builds on what, and
// what contradicts what.

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs = {}, parent = null) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};

const NEGATIVE = new Set(['obstruction', 'counterexample', 'refutation']);

export function cardHue(c) {
  if (c.status === 'proof' || c.kind === 'review') {
    const v = c.kind === 'review' ? c.outcome?.verdict : c.proofStatus;
    if (v === 'verified') return 'var(--verified)';
    if (v === 'refuted') return 'var(--refuted)';
    if (c.kind === 'review' && c.status === 'open') return 'var(--faint)';
    return 'var(--review)';
  }
  return { active: 'var(--progress)', open: 'var(--faint)', derivation: 'var(--partial)', dead_end: 'var(--dead)', abandoned: 'var(--dead)' }[c.status] ?? 'var(--faint)';
}

export function findingHue(f) {
  if (f.confidence === 'verified') return 'var(--verified)';
  if (f.confidence === 'refuted') return 'var(--refuted)';
  return NEGATIVE.has(f.kind) ? 'var(--dead)' : 'var(--finding)';
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function createGraph(root, { onSelect, onHover }) {
  const svg = svgEl('svg');
  root.prepend(svg);
  const defs = svgEl('defs', {}, svg);
  for (const [id, color] of [['builds', 'var(--accent)'], ['parent', 'var(--partial)'], ['contradicts', 'var(--refuted)']]) {
    const m = svgEl('marker', { id: `arrow-${id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
    svgEl('path', { d: 'M0 1 L10 5 L0 9 z', style: `fill:${color}` }, m);
  }
  const viewport = svgEl('g', {}, svg);
  const edgeLayer = svgEl('g', {}, viewport);
  const nodeLayer = svgEl('g', {}, viewport);
  const labelLayer = svgEl('g', {}, viewport);

  const nodes = new Map();
  let edges = [];
  let alpha = 0;
  let raf = null;
  let selected = null;
  let hovered = null;
  let userMoved = false;
  const view = { x: 0, y: 0, k: 1 };

  // ------------------------------------------------------------------ data
  function update(state) {
    const wanted = new Map();
    const links = [];
    wanted.set('goal', { type: 'goal', r: 25, charge: 3.2, hue: null, inner: 'GOAL', label: '' });
    for (const c of Object.values(state.cards)) {
      const review = c.kind === 'review';
      wanted.set(c.id, { type: 'card', r: review ? 9 : 15, charge: review ? 1.2 : 2.2, hue: cardHue(c), inner: review ? '' : c.id, label: review ? '' : clip(c.title, 26), anchor: c.parentId ?? 'goal' });
      if (review) links.push({ s: c.parentId, t: c.id, type: 'review', len: 52, k: 0.5 });
      else if (c.parentId) links.push({ s: c.parentId, t: c.id, type: 'parent', len: 120, k: 0.4 });
      else links.push({ s: 'goal', t: c.id, type: 'root', len: 215, k: 0.22 });
      for (const ref of c.buildsOn ?? []) links.push({ s: ref, t: c.id, type: 'builds', len: 130, k: 0.03 });
    }
    for (const f of Object.values(state.findings)) {
      wanted.set(f.id, { type: 'finding', r: 6.5, charge: 1, hue: findingHue(f), inner: '', label: '', anchor: f.cardId });
      links.push({ s: f.cardId, t: f.id, type: 'owns', len: 50, k: 0.55 });
      for (const ref of f.buildsOn) links.push({ s: ref, t: f.id, type: 'builds', len: 130, k: 0.03 });
      for (const ref of f.contradicts) links.push({ s: f.id, t: ref, type: 'contradicts', len: 110, k: 0.05 });
    }

    let changed = false;
    for (const [id, spec] of wanted) {
      let n = nodes.get(id);
      if (!n) {
        const a = nodes.get(spec.anchor);
        const angle = Math.random() * Math.PI * 2;
        const dist = a ? 30 + Math.random() * 30 : 0;
        n = { id, x: (a?.x ?? 0) + Math.cos(angle) * dist, y: (a?.y ?? 0) + Math.sin(angle) * dist, vx: 0, vy: 0, fixed: id === 'goal' };
        n.g = svgEl('g', { class: `g-node ${spec.type}` }, nodeLayer);
        n.g.dataset.id = id;
        n.shape = spec.type === 'finding' ? svgEl('rect', { x: -6, y: -6, width: 12, height: 12, rx: 3 }, n.g) : svgEl('circle', {}, n.g);
        n.inner = svgEl('text', {}, n.g);
        n.label = svgEl('text', { class: 'g-label' }, labelLayer);
        nodes.set(id, n);
        changed = true;
      }
      Object.assign(n, { type: spec.type, r: spec.r, charge: spec.charge });
      if (spec.type !== 'finding') n.shape.setAttribute('r', spec.r);
      if (spec.hue) n.shape.style.fill = spec.hue;
      n.inner.textContent = spec.inner;
      n.label.textContent = spec.label;
    }
    for (const [id, n] of nodes) {
      if (wanted.has(id)) continue;
      n.g.remove();
      n.label.remove();
      nodes.delete(id);
      changed = true;
    }
    const valid = links.filter((l) => nodes.has(l.s) && nodes.has(l.t));
    if (valid.length !== edges.length) changed = true;
    edgeLayer.replaceChildren();
    edges = valid.map((l) => {
      const attrs = { class: `g-edge t-${l.type}` };
      if (['builds', 'parent', 'contradicts'].includes(l.type)) attrs['marker-end'] = `url(#arrow-${l.type})`;
      return { ...l, a: nodes.get(l.s), b: nodes.get(l.t), line: svgEl('line', attrs, edgeLayer) };
    });
    applyFocus();
    alpha = Math.max(alpha, changed ? 0.8 : 0.05);
    start();
  }

  // ------------------------------------------------------------ simulation
  function step() {
    const list = [...nodes.values()];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = dx * dx + dy * dy;
        }
        if (d2 > 360000) continue;
        const d = Math.sqrt(d2);
        let f = (alpha * 950 * a.charge * b.charge) / d2;
        const overlap = a.r + b.r + 16 - d;
        if (overlap > 0) f += overlap * 0.12;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = ((d - e.len) / d) * alpha * e.k * 0.5;
      e.a.vx += dx * f;
      e.a.vy += dy * f;
      e.b.vx -= dx * f;
      e.b.vy -= dy * f;
    }
    for (const n of list) {
      if (n.fixed || n.dragging) {
        n.vx = n.vy = 0;
        continue;
      }
      n.vx = (n.vx - n.x * 0.006 * alpha) * 0.74;
      n.vy = (n.vy - n.y * 0.006 * alpha) * 0.74;
      n.x += n.vx;
      n.y += n.vy;
    }
    alpha *= 0.988;
  }

  function fit(instant = false) {
    const box = svg.getBoundingClientRect();
    if (!box.width || !nodes.size) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes.values()) {
      minX = Math.min(minX, n.x - n.r - 60);
      maxX = Math.max(maxX, n.x + n.r + 60);
      minY = Math.min(minY, n.y - n.r - 30);
      maxY = Math.max(maxY, n.y + n.r + 44);
    }
    const k = Math.max(0.3, Math.min(1.35, box.width / (maxX - minX), box.height / (maxY - minY)));
    const tx = box.width / 2 - ((minX + maxX) / 2) * k;
    const ty = box.height / 2 - ((minY + maxY) / 2) * k;
    const ease = instant ? 1 : 0.08;
    view.k += (k - view.k) * ease;
    view.x += (tx - view.x) * ease;
    view.y += (ty - view.y) * ease;
  }

  function draw() {
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    for (const n of nodes.values()) {
      n.g.setAttribute('transform', `translate(${n.x} ${n.y})`);
      n.label.setAttribute('x', n.x);
      n.label.setAttribute('y', n.y + n.r + 12);
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const pad = e.b.r + 3;
      e.line.setAttribute('x1', e.a.x + (dx / d) * e.a.r);
      e.line.setAttribute('y1', e.a.y + (dy / d) * e.a.r);
      e.line.setAttribute('x2', e.b.x - (dx / d) * pad);
      e.line.setAttribute('y2', e.b.y - (dy / d) * pad);
    }
  }

  function frame() {
    raf = null;
    if (root.offsetParent === null) return; // hidden: resume on the next update
    step();
    if (!userMoved) fit();
    draw();
    if (alpha > 0.004) start();
  }

  function start() {
    raf ??= requestAnimationFrame(frame);
  }

  // ----------------------------------------------------------- interaction
  function neighbours(id) {
    const near = new Set([id]);
    for (const e of edges) {
      if (e.s === id) near.add(e.t);
      if (e.t === id) near.add(e.s);
    }
    return near;
  }

  function applyFocus() {
    const focus = hovered ?? selected;
    svg.classList.toggle('focus', Boolean(focus && nodes.has(focus)));
    const near = focus ? neighbours(focus) : new Set();
    for (const n of nodes.values()) {
      n.g.classList.toggle('near', near.has(n.id));
      n.label.classList.toggle('near', near.has(n.id));
      n.g.classList.toggle('sel', n.id === selected);
    }
    for (const e of edges) e.line.classList.toggle('near', Boolean(focus) && (e.s === focus || e.t === focus));
  }

  const toWorld = (ev) => {
    const box = svg.getBoundingClientRect();
    return { x: (ev.clientX - box.left - view.x) / view.k, y: (ev.clientY - box.top - view.y) / view.k };
  };

  let drag = null;
  svg.addEventListener('pointerdown', (ev) => {
    const g = ev.target.closest?.('.g-node');
    const start0 = { x: ev.clientX, y: ev.clientY };
    if (g) {
      const n = nodes.get(g.dataset.id);
      drag = { node: n, start: start0, moved: false };
      n.dragging = true;
    } else {
      drag = { pan: true, start: start0, vx: view.x, vy: view.y, moved: false };
      svg.classList.add('panning');
    }
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) {
      const g = ev.target.closest?.('.g-node');
      const id = g?.dataset.id ?? null;
      if (id !== hovered) {
        hovered = id;
        applyFocus();
      }
      onHover?.(id, ev);
      return;
    }
    if (Math.hypot(ev.clientX - drag.start.x, ev.clientY - drag.start.y) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.pan) {
      userMoved = true;
      view.x = drag.vx + ev.clientX - drag.start.x;
      view.y = drag.vy + ev.clientY - drag.start.y;
      draw();
    } else {
      const p = toWorld(ev);
      drag.node.x = p.x;
      drag.node.y = p.y;
      alpha = Math.max(alpha, 0.3);
      start();
    }
  });
  const release = (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    if (d.node) {
      d.node.dragging = false;
      if (!d.moved) {
        select(d.node.id);
        onSelect?.(d.node.id);
      }
    } else if (!d.moved && ev.type === 'pointerup') {
      select(null);
      onSelect?.(null);
    }
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('pointerleave', () => {
    if (hovered) {
      hovered = null;
      applyFocus();
    }
    onHover?.(null);
  });
  svg.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      userMoved = true;
      const box = svg.getBoundingClientRect();
      const px = ev.clientX - box.left;
      const py = ev.clientY - box.top;
      const k = Math.max(0.2, Math.min(3, view.k * Math.exp(-ev.deltaY * 0.0015)));
      view.x = px - ((px - view.x) / view.k) * k;
      view.y = py - ((py - view.y) / view.k) * k;
      view.k = k;
      draw();
    },
    { passive: false },
  );
  svg.addEventListener('dblclick', () => {
    userMoved = false;
    alpha = Math.max(alpha, 0.1);
    start();
  });

  function select(id) {
    selected = id;
    applyFocus();
  }

  return {
    update,
    select,
    /** Call when the graph becomes visible again. */
    wake() {
      if (!userMoved) fit(true);
      alpha = Math.max(alpha, 0.15);
      start();
    },
  };
}
