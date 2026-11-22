import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processRunner } from '../src/runners.js';

// A fake agent that starts a long-running background process (like an agent's
// `nohup ./search &`), records its pid, and then either exits or keeps running.
const AGENT = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const bg = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
bg.unref();
fs.writeFileSync(process.env.WWR_WORKSPACE + '/bg.pid', String(bg.pid));
if (process.env.STAY) setInterval(() => {}, 1000);
`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(fn, ms) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

function setup(stay) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwr-runner-'));
  const script = path.join(dir, 'agent.cjs');
  fs.writeFileSync(script, AGENT);
  if (stay) process.env.STAY = '1';
  else delete process.env.STAY;
  const spawnAgent = processRunner({ dir, cwd: dir, mcpUrl: 'http://127.0.0.1:1/mcp', command: `"${process.execPath}" "${script}"` });
  const workspace = path.join(dir, 'ws');
  const handle = spawnAgent({ agent: { id: 'A-1', name: 'test', token: 'wwr_x' }, role: 'researcher', card: null, prompt: 'hi', workspace });
  delete process.env.STAY;
  const pidFile = path.join(workspace, 'bg.pid');
  return { dir, handle, pid: async () => ((await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'), 20000)) ? Number(fs.readFileSync(pidFile, 'utf8')) : null) };
}

test('background processes an agent leaves behind die when it exits', { timeout: 40000 }, async () => {
  const { dir, handle, pid } = setup(false);
  const bg = await pid();
  assert.ok(bg, 'the fake agent started its background process');
  await handle.exited;
  assert.ok(await until(() => !alive(bg), 5000), `background process ${bg} survived the agent`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('killing an agent kills everything it started', { timeout: 40000 }, async () => {
  const { dir, handle, pid } = setup(true);
  const bg = await pid();
  assert.ok(bg && alive(bg));
  handle.kill();
  const res = await handle.exited;
  assert.notEqual(res.code, 0);
  assert.ok(await until(() => !alive(bg), 5000), `background process ${bg} survived the kill`);
  fs.rmSync(dir, { recursive: true, force: true });
});
