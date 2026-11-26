// Runners turn "the orchestrator wants an agent" into a real process.
//
// Built in: Claude Code (headless). Anything else that can talk MCP — or plain
// HTTP — works through a custom command: it receives the prompt on stdin and
// everything else through WWR_* environment variables.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME } from './mcp.js';

const WINDOWS = process.platform === 'win32';
const JOB_WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobwrap.ps1');

/**
 * Start an agent so that it and everything it starts can be stopped as one:
 * on Windows inside a Job Object (see jobwrap.ps1), elsewhere as its own
 * process group. Either way at lower CPU priority, so the desktop stays usable.
 */
/** One argument for a cmd.exe command line: quoted when it holds a space or a character cmd would act on. */
export const winArg = (arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

function spawnTree({ command, file, args = [] }, { cwd, env }) {
  if (WINDOWS) {
    // cmd.exe runs it. Arguments are quoted here, because a board directory or
    // an --allow rule with a space in it would otherwise fall apart into two.
    const commandLine = command ?? [file, ...args].map(winArg).join(' ');
    const ps = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', JOB_WRAPPER];
    return spawn('powershell.exe', ps, { cwd, env: { ...env, WWR_JOB_CMD: commandLine }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const opts = { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] };
  const child = command ? spawn(command, { ...opts, shell: true }) : spawn(file, args, opts);
  try {
    if (child.pid) os.setPriority(child.pid, 10); // inherited by everything it starts
  } catch {
    /* not permitted: run at normal priority */
  }
  return child;
}

/** Stop a process tree started by spawnTree. `force` skips the polite request. */
export function killTree(child, { force = false } = {}) {
  if (!child.pid) return;
  if (WINDOWS) {
    // Kills the wrapper and its tree; closing the wrapper's job kills the rest.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    return;
  }
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* group already gone */
    }
  };
  if (force) return signal('SIGKILL');
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 5000).unref();
}

export const SAFE_TOOLS = [`mcp__${SERVER_NAME}`, 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebSearch', 'WebFetch'];

/**
 * @param {object} opts
 * @param {string} opts.dir        board directory (logs, prompts and workspaces live here)
 * @param {string} opts.cwd        working directory of the agents
 * @param {string} opts.mcpUrl     URL of the board's MCP endpoint
 * @param {string} [opts.command]  custom shell command instead of Claude Code
 * @param {string} [opts.model]    model passed to Claude Code
 * @param {string[]} [opts.allow]  extra allowed tools for Claude Code, e.g. "Bash(python3:*)"
 * @param {'auto'|'full'|'safe'} [opts.permissions]
 *   auto: shell, files and web, with Claude Code's own safety checks on what gets run (default)
 *   full: no permission checks at all — sandbox only
 *   safe: board, files and web only; shell commands only as listed in `allow`
 * @param {number} [opts.maxBudgetUsd] per-agent spending cap passed to Claude Code
 * @param {string[]} [opts.extraArgs]  extra arguments appended to the Claude Code command
 * @param {number} [opts.waitBeatMs]   how often an agent that waits on background jobs is reported as alive
 */
export function processRunner({ dir, cwd, mcpUrl, command = null, model = null, allow = [], permissions = 'auto', maxBudgetUsd = 0, extraArgs = [], waitBeatMs = 30_000 }) {
  const logDir = path.join(dir, 'logs');
  const promptDir = path.join(dir, 'prompts');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(promptDir, { recursive: true });
  const mcpConfig = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: mcpUrl } } }, null, 2));

  return function spawnAgent({ agent, role, card, prompt, workspace, onActivity = () => {}, onCost = () => {} }) {
    const promptFile = path.join(promptDir, `${agent.id}.md`);
    fs.writeFileSync(promptFile, prompt);
    if (workspace) fs.mkdirSync(workspace, { recursive: true });
    const env = {
      ...process.env,
      WWR_MCP_URL: mcpUrl,
      WWR_MCP_CONFIG: mcpConfig,
      WWR_API_URL: mcpUrl.replace(/\/mcp$/, '/api/tool'),
      WWR_PROMPT_FILE: promptFile,
      WWR_AGENT_TOKEN: agent.token,
      WWR_AGENT_NAME: agent.name,
      WWR_AGENT_ROLE: role,
      WWR_CARD_ID: card?.id ?? '',
      WWR_WORKSPACE: workspace ?? '',
    };

    let target = { command };
    if (!command) {
      const args = ['-p', '--mcp-config', mcpConfig, '--output-format', 'stream-json', '--verbose'];
      // The board, files and the web are always pre-approved, so no agent stalls on them.
      if (permissions === 'full') args.push('--dangerously-skip-permissions');
      else args.push('--permission-mode', permissions === 'safe' ? 'acceptEdits' : 'auto', '--allowedTools', [...SAFE_TOOLS, ...allow].join(','));
      if (model) args.push('--model', model);
      if (maxBudgetUsd > 0) args.push('--max-budget-usd', String(maxBudgetUsd));
      args.push(...extraArgs);
      target = { file: 'claude', args };
    }
    const child = spawnTree(target, { cwd, env });

    const log = fs.createWriteStream(path.join(logDir, `${agent.id}-${agent.name}.log`));
    let costUsd = 0;
    let buffer = '';
    let stderrTail = '';
    let backgroundJobs = 0;
    // An agent that started a job in the background and ended its turn to wait
    // for it prints nothing until the job is done — for hours, on a long search.
    // Claude Code says which background jobs are running; while there are any,
    // the agent is waiting, not dead.
    const waitBeat = setInterval(() => backgroundJobs > 0 && onActivity(), waitBeatMs);
    waitBeat.unref?.();
    child.stdout.on('data', (chunk) => {
      log.write(chunk);
      // Any output means the process is alive. Claude Code prints a heartbeat
      // every 30 s while a shell command runs in the foreground.
      onActivity();
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.includes('"result"') && !line.includes('"background_tasks_changed"')) continue;
        try {
          const msg = JSON.parse(line);
          // Every turn ends with a "result" line that carries the cost of the
          // session so far. Passing it on right away keeps the total right when
          // the agent is stopped later, in the middle of a turn.
          if (msg.type === 'result' && typeof msg.total_cost_usd === 'number') {
            costUsd = msg.total_cost_usd;
            onCost(costUsd);
          } else if (msg.type === 'system' && msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) backgroundJobs = msg.tasks.length;
        } catch {
          /* not JSON — a custom agent's own output */
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      log.write(chunk);
      onActivity();
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-400);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    const exited = new Promise((resolve) => {
      let settled = false;
      const finish = (code, spawnError) => {
        if (settled) return;
        settled = true;
        clearInterval(waitBeat);
        log.end();
        const failed = spawnError || (code !== 0 && code !== null);
        resolve({ code, costUsd, error: failed ? spawnError ?? (stderrTail.trim().split('\n').pop() || `exit code ${code}`) : undefined });
      };
      // A command that cannot be started emits "error" and may never emit "close".
      child.on('error', (err) => finish(-1, err.code === 'ENOENT' ? `command not found: ${WINDOWS ? 'powershell.exe' : command ?? 'claude'}` : err.message));
      // The agent is done: anything it left running in the background goes with it.
      // (On Windows the job wrapper already did this.)
      child.on('exit', () => !WINDOWS && killTree(child, { force: true }));
      child.on('close', (code) => finish(code, null));
    });

    let killed = false;
    return {
      exited,
      // Kill the agent together with everything it started (shells, scripts),
      // otherwise a stopped run keeps computing — and spending — in the background.
      kill() {
        if (killed) return;
        killed = true;
        killTree(child);
      },
    };
  };
}
