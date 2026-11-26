import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processRunner, winArg } from '../src/runners.js';

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

// A stand-in for Claude Code: records its arguments, starts a "background job",
// ends its turn (a result line with the cost so far) and then waits in silence
// for the job, as a headless agent does. Later the job ends and so does the agent.
const FAKE_CLAUDE = `
const fs = require('node:fs');
const say = (m) => console.log(JSON.stringify(m));
fs.writeFileSync(process.env.WWR_WORKSPACE + '/argv.json', JSON.stringify(process.argv.slice(2)));
say({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash' }] });
say({ type: 'result', subtype: 'success', total_cost_usd: 0.5, result: 'Waiting for the search to finish.' });
setTimeout(() => {
  say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0.75, result: 'Done.' });
}, 900);
`;

test('winArg quotes only what cmd.exe would split or act on', () => {
  assert.equal(winArg('--mcp-config'), '--mcp-config');
  assert.equal(winArg('mcp__wwresearch,Read,Bash(python3:*)'), 'mcp__wwresearch,Read,Bash(python3:*)');
  assert.equal(winArg('C:\\Users\\Jane Doe\\board\\mcp.json'), '"C:\\Users\\Jane Doe\\board\\mcp.json"');
  assert.equal(winArg('Read,Bash(git status:*)'), '"Read,Bash(git status:*)"');
  assert.equal(winArg('a&b'), '"a&b"');
});

test('Claude Code runner: paths with spaces arrive whole, cost is reported per turn, waiting on a background job counts as alive', { timeout: 40000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwr runner with spaces-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fake.cjs'), FAKE_CLAUDE);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs" "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const spawnAgent = processRunner({ dir, cwd: dir, mcpUrl: 'http://127.0.0.1:1/mcp', allow: ['Bash(git status:*)'], waitBeatMs: 40 });
    const workspace = path.join(dir, 'ws');
    const costs = [];
    const beats = [];
    const handle = spawnAgent({ agent: { id: 'A-1', name: 'fake', token: 'wwr_x' }, role: 'researcher', card: null, prompt: 'hi', workspace, onActivity: () => beats.push(Date.now()), onCost: (c) => costs.push(c) });
    const res = await handle.exited;
    assert.equal(res.error, undefined, `the fake agent failed: ${res.error}`);

    const argv = JSON.parse(fs.readFileSync(path.join(workspace, 'argv.json'), 'utf8'));
    assert.equal(argv[argv.indexOf('--mcp-config') + 1], path.join(dir, 'mcp.json'), 'a path with spaces is one argument');
    assert.match(argv[argv.indexOf('--allowedTools') + 1], /,Bash\(git status:\*\)$/, 'an --allow rule with a space is not cut in two');

    assert.deepEqual(costs, [0.5, 0.75], 'every turn reports the cost of the session so far');
    assert.equal(res.costUsd, 0.75);
    // The agent printed twice, 900 ms apart, and nothing in between.
    const quiet = beats.filter((t) => t > beats[0] + 150 && t < beats[0] + 750);
    assert.ok(quiet.length >= 3, `expected sign-of-life reports while the background job ran, got ${quiet.length}`);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
