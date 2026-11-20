#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Board } from '../src/board.js';
import { createMcp } from '../src/mcp.js';
import { createServer } from '../src/server.js';
import { Orchestrator } from '../src/orchestrator.js';
import { processRunner } from '../src/runners.js';
import { simRunner, DEMO_GOAL, DEMO_TITLE, DEMO_IDEAS } from '../src/demo.js';
import { fullReport, reviewReport } from '../src/report.js';
import { researcherPrompt, cardPrompt } from '../src/prompts.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
const DEFAULT_PORT = 4777;

const HELP = `wwresearch ${VERSION} — a shared research board for parallel AI agents

Usage
  wwresearch demo                      Watch a simulated swarm (no model, no API key, no cost)
  wwresearch run "<goal>" [options]    Start the board and a swarm of agents working on the goal
  wwresearch serve ["<goal>"]          Start only the board; dock agents yourself
  wwresearch status                    Print the state of the board in this directory
  wwresearch report [-o FILE]          Export everything that was learned as Markdown
  wwresearch prompt [researcher|card]  Print the prompt that docks an agent onto the board
  wwresearch mcp [--url URL]           stdio ⇄ HTTP bridge for MCP clients without HTTP support

Options for run
  -n, --agents N          Agents to keep alive at all times (default 4; adjustable live in the UI)
      --max-ideas N       Stop sending new researchers after N ideas (default 24, 0 = unlimited)
      --goal-file FILE    Read the goal from a file
      --model NAME        Model for Claude Code agents (e.g. sonnet, opus)
      --allow TOOL        Allow an extra tool for agents, repeatable, e.g. --allow "Bash(python3:*)"
      --yolo              Agents skip all permission checks. Only inside a sandbox or container!
      --agent-cmd CMD     Use your own agent command instead of Claude Code. It gets the prompt on
                          stdin and WWR_MCP_URL, WWR_AGENT_TOKEN, WWR_PROMPT_FILE … in its environment
      --agent-timeout MIN Kill agents that run longer than MIN minutes (default 120, 0 = never)
      --max-budget-usd X  Spending cap per agent, passed to Claude Code
      --no-lenses         Do not give researchers individual thinking nudges
      --fresh             Archive an existing board in this directory and start over

Options for demo
      --speed X           Time multiplier (default 1)

Common options
  -p, --port N            Port (default ${DEFAULT_PORT}; the next free one is used if taken)
      --host HOST         Interface to bind (default 127.0.0.1)
      --dir DIR           Where the board keeps its state (default ./.wwresearch)
      --no-open           Do not open the browser
  -h, --help · -v, --version

Agents dock via MCP at http://localhost:${DEFAULT_PORT}/mcp, for example:
  claude mcp add --transport http wwresearch http://localhost:${DEFAULT_PORT}/mcp
`;

// ------------------------------------------------------------------ helpers

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { dim: paint(2), bold: paint(1), green: paint(32), red: paint(31), yellow: paint(33), blue: paint(34), magenta: paint(35), cyan: paint(36) };

function die(message) {
  console.error(`${c.red('error')} ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = { allow: [] };
  const positional = [];
  const spec = {
    '-n': 'agents', '--agents': 'agents', '--max-ideas': 'maxIdeas', '--goal-file': 'goalFile', '--model': 'model', '--allow': 'allow',
    '--agent-cmd': 'agentCmd', '--agent-timeout': 'agentTimeout', '--max-budget-usd': 'maxBudgetUsd', '-p': 'port', '--port': 'port',
    '--host': 'host', '--dir': 'dir', '--speed': 'speed', '-o': 'out', '--out': 'out', '--url': 'url',
  };
  const bools = { '--yolo': 'yolo', '--no-lenses': 'noLenses', '--fresh': 'fresh', '--no-open': 'noOpen', '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version' };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    if (arg.startsWith('--') && arg.includes('=')) [arg, value] = [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)];
    if (bools[arg]) flags[bools[arg]] = true;
    else if (spec[arg]) {
      value ??= argv[++i];
      if (value === undefined) die(`${arg} needs a value`);
      if (spec[arg] === 'allow') flags.allow.push(value);
      else flags[spec[arg]] = value;
    } else if (arg.startsWith('-') && arg !== '-') die(`Unknown option ${arg}. See wwresearch --help.`);
    else positional.push(arg);
  }
  return { flags, positional };
}

function number(value, name, fallback, { min = 0, integer = true } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) die(`--${name} must be ${integer ? 'a whole number' : 'a number'} ≥ ${min}`);
  return n;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser available — the URL is printed anyway */
  }
}

const EVENT_STYLE = {
  queue_joined: ['·', c.dim], turn_started: ['·', c.dim], turn_passed: ['·', c.dim], turn_expired: ['!', c.yellow], queue_dropped: ['!', c.yellow],
  card_claimed: ['◆', c.blue], card_entered: ['◆', c.blue], card_opened: ['○', c.cyan], note: null, finding_added: ['+', c.magenta],
  proof_submitted: ['★', c.yellow], derivation_submitted: ['→', c.cyan], dead_end: ['×', c.dim], card_abandoned: ['!', c.yellow], agent_gone: null, project_created: null,
};

function logEvent(ev) {
  let style = EVENT_STYLE[ev.type];
  if (ev.type === 'review_submitted') style = ev.verdict === 'verified' ? ['✔', c.green] : ev.verdict === 'refuted' ? ['✘', c.red] : ['?', c.yellow];
  if (ev.type === 'agent_gone' && !/process exited|board restarted/.test(ev.text)) style = ['!', c.yellow];
  if (!style) return;
  const time = new Date(ev.at).toTimeString().slice(0, 8);
  console.log(`  ${c.dim(time)}  ${style[1](style[0])} ${ev.type === 'review_submitted' && ev.verdict === 'verified' ? c.bold(ev.text) : ev.text}`);
}

async function listen(board, mcp, flags) {
  const host = flags.host ?? '127.0.0.1';
  const wanted = number(flags.port, 'port', DEFAULT_PORT);
  for (let port = wanted; ; port++) {
    const srv = createServer({ board, mcp, host, port });
    try {
      const info = await srv.listen();
      if (!['127.0.0.1', 'localhost', '::1'].includes(host))
        console.log(`\n  ${c.yellow('warning')} the board is reachable from your network on ${host}:${info.port} and has no authentication.`);
      return { srv, ...info };
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || flags.port !== undefined || port > wanted + 30) die(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another with --port.` : err.message);
    }
  }
}

function banner(rows) {
  console.log(`\n  ${c.bold('wwresearch')} ${c.dim(VERSION)}\n`);
  for (const [k, v] of rows) console.log(`  ${c.dim(k.padEnd(8))}${v}`);
  console.log('');
}

function readGoal(flags, positional) {
  if (flags.goalFile) {
    if (!fs.existsSync(flags.goalFile)) die(`Goal file not found: ${flags.goalFile}`);
    return fs.readFileSync(flags.goalFile, 'utf8').trim();
  }
  return positional.join(' ').trim() || null;
}

function openBoard(flags, goal) {
  const dir = path.resolve(flags.dir ?? '.wwresearch');
  const stateFile = path.join(dir, 'state.json');
  if (fs.existsSync(stateFile) && flags.fresh) {
    const archive = `${dir}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    fs.renameSync(dir, archive);
    console.log(`  ${c.dim(`Archived the previous board to ${path.relative(process.cwd(), archive)}`)}`);
  }
  if (fs.existsSync(stateFile)) {
    const board = new Board({ dir });
    if (goal && goal !== board.state.project.goal)
      die(`This directory already holds a board for a different goal:\n  "${board.state.project.title}"\nRun without a goal to resume it, or add --fresh to archive it and start over.`);
    board.recover();
    return { board, dir, resumed: true };
  }
  if (!goal) die('No goal given and no existing board in this directory.\n  wwresearch run "Prove or disprove that …"\n  wwresearch demo   (to just watch how it works)');
  return { board: new Board({ dir, goal }), dir, resumed: false };
}

function lifecycle({ board, srv, orchestrator }) {
  const ticker = setInterval(() => board.tick(), 2000);
  let closing = false;
  const shutdown = async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log(`\n  ${c.dim('Shutting down…')}`);
    clearInterval(ticker);
    orchestrator?.stop();
    board.flush();
    await Promise.race([srv.close(), new Promise((r) => setTimeout(r, 1500))]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // A long research run should survive a stray failed promise.
  process.on('unhandledRejection', (err) => console.error(`  ${c.red('internal error')} ${err?.stack ?? err}`));
}

function writeReviewReports(board, dir) {
  board.on('event', (ev) => {
    if (ev.type !== 'review_submitted') return;
    try {
      const file = path.join(dir, 'reports', `${ev.parentId}-${ev.verdict}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, reviewReport(board, ev.cardId));
      if (ev.verdict === 'verified') console.log(`  ${' '.repeat(8)}  ${c.green('→')} report for you: ${path.relative(process.cwd(), file)}`);
    } catch (err) {
      console.error(`  ${c.red('could not write the review report:')} ${err.message}`);
    }
  });
}

// ----------------------------------------------------------------- commands

async function cmdRun(flags, positional) {
  const { board, dir, resumed } = openBoard(flags, readGoal(flags, positional));
  const mcp = createMcp(board, { version: VERSION });
  const { srv, url, mcpUrl } = await listen(board, mcp, flags);
  const agents = number(flags.agents, 'agents', 4);
  const maxIdeas = number(flags.maxIdeas, 'max-ideas', 24);
  const timeoutMin = number(flags.agentTimeout, 'agent-timeout', 120);
  const spawnAgent = processRunner({
    dir,
    cwd: process.cwd(),
    mcpUrl,
    command: flags.agentCmd ?? null,
    model: flags.model ?? null,
    allow: flags.allow,
    yolo: Boolean(flags.yolo),
    maxBudgetUsd: number(flags.maxBudgetUsd, 'max-budget-usd', 0, { integer: false }),
  });
  if (resumed) board.setOrchestrator({ ideasSpawned: Object.values(board.state.cards).filter((card) => card.kind === 'idea').length });
  const orchestrator = new Orchestrator({
    board,
    spawnAgent,
    target: agents,
    maxIdeas,
    lenses: !flags.noLenses,
    agentTimeoutMs: timeoutMin * 60_000,
    workspaceFor: (agent) => path.join(dir, 'workspaces', `${agent.id}-${agent.name}`),
  });

  banner([
    ['Goal', board.state.project.title + (resumed ? c.dim('  (resumed)') : '')],
    ['Board', c.cyan(url)],
    ['MCP', mcpUrl],
    ['Agents', `${agents} × ${flags.agentCmd ? 'custom command' : `Claude Code${flags.model ? ` (${flags.model})` : ''}`}${maxIdeas ? c.dim(`  · up to ${maxIdeas} ideas`) : ''}${flags.yolo ? c.yellow('  · permissions skipped') : ''}`],
    ['State', path.relative(process.cwd(), dir) || '.'],
  ]);
  board.on('event', logEvent);
  writeReviewReports(board, dir);
  board.on('orchestrator', (o) => {
    if (o.error && o.error !== cmdRun.lastError) console.log(`\n  ${c.red('paused')} ${o.error}\n  ${c.dim(`Agent logs: ${path.relative(process.cwd(), path.join(dir, 'logs'))}`)}\n`);
    cmdRun.lastError = o.error;
  });
  orchestrator.on('idle', () => {
    const s = board.digest().counts;
    console.log(`\n  ${c.bold('All agents are done.')} ${s.ideas} approaches · ${s.verified} verified · ${s.derivations} partial results · ${s.deadEnds} dead ends`);
    console.log(`  ${c.dim('The board stays up. Raise the agent count in the UI to continue, or press Ctrl+C. Export with: wwresearch report')}\n`);
  });
  lifecycle({ board, srv, orchestrator });
  orchestrator.start();
  if (!flags.noOpen && process.stdout.isTTY) openBrowser(url);
}

async function cmdServe(flags, positional) {
  const { board, dir, resumed } = openBoard(flags, readGoal(flags, positional));
  const mcp = createMcp(board, { version: VERSION });
  const { srv, url, mcpUrl } = await listen(board, mcp, flags);
  banner([
    ['Goal', board.state.project.title + (resumed ? c.dim('  (resumed)') : '')],
    ['Board', c.cyan(url)],
    ['MCP', mcpUrl],
  ]);
  console.log(`  Dock an agent:\n    ${c.bold(`claude mcp add --transport http wwresearch ${mcpUrl}`)}\n    then, inside Claude Code:  ${c.bold('/mcp__wwresearch__researcher')}\n`);
  board.on('event', logEvent);
  writeReviewReports(board, dir);
  lifecycle({ board, srv });
  if (!flags.noOpen && process.stdout.isTTY) openBrowser(url);
}

async function cmdDemo(flags) {
  const speed = number(flags.speed, 'speed', 1, { min: 0.1, integer: false });
  const board = new Board({ goal: DEMO_GOAL, title: DEMO_TITLE, demo: true });
  const mcp = createMcp(board, { version: VERSION });
  const { srv, url, mcpUrl } = await listen(board, mcp, flags);
  const orchestrator = new Orchestrator({
    board,
    spawnAgent: simRunner({ apiUrl: mcpUrl.replace(/\/mcp$/, ''), speed }),
    target: number(flags.agents, 'agents', 5),
    maxIdeas: DEMO_IDEAS,
    lenses: false,
  });
  banner([
    ['Demo', 'a simulated swarm — no model, no API key, no cost'],
    ['Goal', board.state.project.title],
    ['Board', c.cyan(url)],
  ]);
  board.on('event', logEvent);
  orchestrator.on('idle', () => {
    const s = board.digest().counts;
    console.log(`\n  ${c.bold('Demo finished.')} ${s.ideas} distinct approaches from ${DEMO_IDEAS} researchers · ${board.state.stats.duplicatesAvoided} duplicates avoided · ${s.verified} proofs verified · ${s.refuted} refuted · ${s.deadEnds} dead ends`);
    console.log(`  ${c.dim(`The board stays up at ${url} — press Ctrl+C to quit.`)}`);
    console.log(`  ${c.dim('Now try it for real:')} wwresearch run "<your research goal>"\n`);
  });
  lifecycle({ board, srv, orchestrator });
  orchestrator.start();
  if (!flags.noOpen && process.stdout.isTTY) openBrowser(url);
}

function loadBoard(flags) {
  const dir = path.resolve(flags.dir ?? '.wwresearch');
  if (!fs.existsSync(path.join(dir, 'state.json'))) die(`No board found in ${dir}. Start one with: wwresearch run "<goal>"`);
  const board = new Board({ dir });
  board.dir = null; // read-only: never write from a reporting command
  return board;
}

function cmdStatus(flags) {
  const board = loadBoard(flags);
  const d = board.digest();
  const n = d.counts;
  console.log(`\n  ${c.bold(d.title)}\n`);
  console.log(`  ${n.ideas} approaches · ${n.active} in progress · ${n.verified} verified · ${n.refuted} refuted · ${n.derivations} partial · ${n.deadEnds} dead ends · ${n.findings} findings · ${board.state.stats.duplicatesAvoided} duplicates avoided\n`);
  const mark = { active: c.blue('◆'), open: c.cyan('○'), proof: c.yellow('★'), derivation: c.cyan('→'), dead_end: c.dim('×'), abandoned: c.dim('!') };
  for (const card of d.cards.slice().reverse()) {
    const status = card.status === 'proof' ? `proof · ${card.proofStatus}` : card.status.replace('_', ' ');
    console.log(`  ${mark[card.status] ?? ' '} ${card.id.padEnd(5)} ${c.dim(`[${status}]`)} ${card.title}`);
  }
  console.log('');
}

function cmdReport(flags) {
  const report = fullReport(loadBoard(flags));
  if (flags.out) {
    fs.writeFileSync(flags.out, report);
    console.log(`Wrote ${flags.out}`);
  } else process.stdout.write(report);
}

function cmdPrompt(flags, positional) {
  const board = loadBoard(flags);
  const goal = board.state.project.goal;
  process.stdout.write(positional[0] === 'card' ? cardPrompt({ goal, kind: 'followup' }) : researcherPrompt({ goal }));
}

/** Bridge for MCP clients that only speak stdio: forwards each JSON-RPC line to the board. */
function cmdMcp(flags) {
  const url = flags.url ?? `http://127.0.0.1:${flags.port ?? DEFAULT_PORT}/mcp`;
  const rl = readline.createInterface({ input: process.stdin });
  let pending = 0;
  let closed = false;
  const maybeExit = () => closed && pending === 0 && process.exit(0);
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    pending++;
    let id = null;
    try {
      id = JSON.parse(line).id ?? null;
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: line });
      if (res.status !== 202) process.stdout.write(`${JSON.stringify(await res.json())}\n`);
    } catch (err) {
      if (id !== null) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `wwresearch board not reachable at ${url}: ${err.message}` } })}\n`);
    }
    pending--;
    maybeExit();
  });
  rl.on('close', () => {
    closed = true;
    maybeExit();
  });
}

// --------------------------------------------------------------------- main

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = positional.shift();

if (flags.version) console.log(VERSION);
else if (flags.help || !command) process.stdout.write(HELP);
else if (command === 'run') await cmdRun(flags, positional);
else if (command === 'serve') await cmdServe(flags, positional);
else if (command === 'demo') await cmdDemo(flags);
else if (command === 'status') cmdStatus(flags);
else if (command === 'report') cmdReport(flags);
else if (command === 'prompt') cmdPrompt(flags, positional);
else if (command === 'mcp') cmdMcp(flags);
else die(`Unknown command "${command}". See wwresearch --help.`);
