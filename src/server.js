// HTTP front door: the MCP endpoint for agents, a JSON API + live event stream
// for the web UI, and the static UI itself. No dependencies.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardError } from './board.js';
import { fullReport, reviewReport } from './report.js';
import { researcherPrompt, cardPrompt } from './prompts.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400 });
  }
}

/**
 * @param {object} opts
 * @param {import('./board.js').Board} opts.board
 * @param {ReturnType<import('./mcp.js').createMcp>} opts.mcp
 * @param {string} [opts.host]  interface to bind (default 127.0.0.1)
 * @param {number} [opts.port]  0 = pick a free port
 */
export function createServer({ board, mcp, host = '127.0.0.1', port = 4777 }) {
  const streams = new Set();
  const exposed = !LOCAL_HOSTS.has(host);

  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, { 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(isText ? body : JSON.stringify(body));
  };

  function guard(req) {
    // DNS-rebinding and cross-site protection: when bound to localhost, only
    // answer requests addressed to localhost, and only same-origin browser writes.
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!exposed && !LOCAL_HOSTS.has(hostname)) return 'Host not allowed';
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET') {
      try {
        if (new URL(origin).host !== req.headers.host) return 'Cross-origin requests are not allowed';
      } catch {
        return 'Bad Origin header';
      }
    }
    return null;
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const blocked = guard(req);
    if (blocked) return send(res, 403, { error: blocked });

    // ---- agents: Model Context Protocol (Streamable HTTP, stateless)
    if (p === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed. POST JSON-RPC messages to this endpoint.' } }, { allow: 'POST' });
      let message;
      try {
        message = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const reply = await mcp.handle(message, { signal: abort.signal });
      if (reply === null) {
        res.writeHead(202);
        return res.end();
      }
      return send(res, 200, reply);
    }

    // ---- agents without MCP: every tool is also a plain POST
    if (p.startsWith('/api/tool/') && req.method === 'POST') {
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const result = await mcp.callTool(decodeURIComponent(p.slice('/api/tool/'.length)), await readJson(req), { signal: abort.signal });
      return send(res, result.isError ? (result.code === 'unknown_tool' ? 404 : 409) : 200, { ok: !result.isError, text: result.text, data: result.data ?? null, code: result.code ?? null });
    }

    // ---- web UI
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, board.snapshot());
    if (p.startsWith('/api/cards/') && req.method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/cards/'.length));
      if (id.endsWith('/report.md')) {
        const card = board.state.cards[id.slice(0, -'/report.md'.length).toUpperCase()];
        if (!card || card.kind !== 'review' || !card.outcome) return send(res, 404, 'No review report for this card');
        return send(res, 200, reviewReport(board, card.id), { 'content-type': 'text/markdown; charset=utf-8' });
      }
      return send(res, 200, board.cardDetail(id));
    }
    if (p === '/api/report.md' && req.method === 'GET') return send(res, 200, fullReport(board), { 'content-type': 'text/markdown; charset=utf-8' });
    if (p === '/api/prompt' && req.method === 'GET') {
      const goal = board.state.project.goal;
      const role = url.searchParams.get('role') ?? 'researcher';
      const cardId = url.searchParams.get('card');
      const card = cardId ? board.state.cards[cardId.toUpperCase()] : null;
      return send(res, 200, role === 'researcher' ? researcherPrompt({ goal }) : cardPrompt({ goal, cardId: card?.id, kind: card?.kind ?? 'followup' }));
    }
    if (p === '/api/orchestrator' && req.method === 'POST') {
      const body = await readJson(req);
      const patch = {};
      if (body.target !== undefined) patch.target = body.target;
      if (body.paused !== undefined) patch.paused = Boolean(body.paused);
      if (Number.isInteger(body.maxIdeas) && body.maxIdeas >= 0) patch.maxIdeas = body.maxIdeas;
      if (patch.paused === false) patch.error = null;
      return send(res, 200, board.setOrchestrator(patch));
    }
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 1500\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET') return serveStatic(res, p);
    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof BoardError) return send(res, err.code === 'not_found' ? 404 : 409, { error: err.message, code: err.code });
      send(res, err.status ?? 500, { error: err.message });
    });
  });

  // Live updates: one tiny "something changed" ping, coalesced; the UI refetches.
  let pingTimer = null;
  const onChange = () => {
    if (pingTimer) return;
    pingTimer = setTimeout(() => {
      pingTimer = null;
      for (const s of streams) s.write(`event: change\ndata: ${board.state.seq.event}\n\n`);
    }, 60);
  };
  board.on('change', onChange);
  const heartbeat = setInterval(() => {
    for (const s of streams) s.write(': keep-alive\n\n');
  }, 20_000);
  heartbeat.unref();

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const actual = server.address().port;
          const shown = exposed ? host : 'localhost';
          resolve({ port: actual, url: `http://${shown}:${actual}`, mcpUrl: `http://${exposed ? host : '127.0.0.1'}:${actual}/mcp` });
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      clearTimeout(pingTimer);
      board.off('change', onChange);
      for (const s of streams) s.end();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
