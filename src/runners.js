// Runners turn "the orchestrator wants an agent" into a real process.
//
// Built in: Claude Code (headless). Anything else that can talk MCP — or plain
// HTTP — works through a custom command: it receives the prompt on stdin and
// everything else through WWR_* environment variables.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_NAME } from './mcp.js';

const WINDOWS = process.platform === 'win32';

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
 */
export function processRunner({ dir, cwd, mcpUrl, command = null, model = null, allow = [], permissions = 'auto', maxBudgetUsd = 0, extraArgs = [] }) {
  const logDir = path.join(dir, 'logs');
  const promptDir = path.join(dir, 'prompts');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(promptDir, { recursive: true });
  const mcpConfig = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: mcpUrl } } }, null, 2));

  return function spawnAgent({ agent, role, card, prompt, workspace }) {
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

    let child;
    if (command) {
      child = spawn(command, { cwd, env, shell: true, detached: !WINDOWS, stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      const args = ['-p', '--mcp-config', mcpConfig, '--output-format', 'stream-json', '--verbose'];
      // The board, files and the web are always pre-approved, so no agent stalls on them.
      if (permissions === 'full') args.push('--dangerously-skip-permissions');
      else args.push('--permission-mode', permissions === 'safe' ? 'acceptEdits' : 'auto', '--allowedTools', [...SAFE_TOOLS, ...allow].join(','));
      if (model) args.push('--model', model);
      if (maxBudgetUsd > 0) args.push('--max-budget-usd', String(maxBudgetUsd));
      args.push(...extraArgs);
      child = spawn('claude', args, { cwd, env, shell: WINDOWS, detached: !WINDOWS, stdio: ['pipe', 'pipe', 'pipe'] });
    }

    const log = fs.createWriteStream(path.join(logDir, `${agent.id}-${agent.name}.log`));
    let costUsd = 0;
    let buffer = '';
    let stderrTail = '';
    child.stdout.on('data', (chunk) => {
      log.write(chunk);
      // Claude Code's stream-json ends with a "result" line that carries the cost.
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.includes('"result"')) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'result' && typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd;
        } catch {
          /* not JSON — a custom agent's own output */
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      log.write(chunk);
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-400);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    const exited = new Promise((resolve) => {
      let settled = false;
      const finish = (code, spawnError) => {
        if (settled) return;
        settled = true;
        log.end();
        const failed = spawnError || (code !== 0 && code !== null);
        resolve({ code, costUsd, error: failed ? spawnError ?? (stderrTail.trim().split('\n').pop() || `exit code ${code}`) : undefined });
      };
      // A command that cannot be started emits "error" and may never emit "close".
      child.on('error', (err) => finish(-1, err.code === 'ENOENT' ? `command not found: ${command ?? 'claude'}` : err.message));
      child.on('close', (code) => finish(code, null));
    });

    return {
      exited,
      // Kill the agent together with everything it started (shells, scripts),
      // otherwise a stopped run keeps computing — and spending — in the background.
      kill() {
        if (child.exitCode !== null || !child.pid) return;
        try {
          if (WINDOWS) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill());
          else process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill();
        }
      },
    };
  };
}
