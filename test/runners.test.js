import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processRunner } from '../src/runners.js';

// A fake agent that starts a long-running background process (like an agent's
// `nohup ./search &`), records its pid, and then either exits or keeps running.
// On Windows it even detaches (the job still holds it). On POSIX `detached`
// means setsid, which deliberately leaves the process group; `nohup … &` doesn't.
const AGENT = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const bg = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform === 'win32', stdio: 'ignore' });
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

test('output from the agent process is reported as activity', { timeout: 40000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwr-runner-'));
  const script = path.join(dir, 'talk.cjs');
  fs.writeFileSync(script, "let n = 0; const t = setInterval(() => { console.log('tick ' + n); if (++n === 3) clearInterval(t); }, 50);");
  const spawnAgent = processRunner({ dir, cwd: dir, mcpUrl: 'http://127.0.0.1:1/mcp', command: `"${process.execPath}" "${script}"` });
  let beats = 0;
  const handle = spawnAgent({ agent: { id: 'A-1', name: 'talk', token: 'wwr_x' }, role: 'researcher', card: null, prompt: 'hi', workspace: path.join(dir, 'ws'), onActivity: () => beats++ });
  await handle.exited;
  assert.ok(beats >= 1, 'printing something counts as being alive');
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
