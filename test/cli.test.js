import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Board } from '../src/board.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wwresearch.js');

/** Start `wwresearch serve` in `cwd`, wait until `done()` holds (or the process exits), stop it, return what it printed. */
async function serve(cwd, args, done) {
  const child = spawn(process.execPath, [BIN, 'serve', '--no-open', '--port', '0', ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const deadline = Date.now() + 15_000;
  while (child.exitCode === null && Date.now() < deadline && !done(out)) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  await exited;
  return out;
}

test('editing the goal file and starting again continues the same board on the new goal', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wwr-cli-'));
  try {
    const dir = path.join(cwd, '.wwresearch');
    const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    const oldGoal = 'Raise the proven minimum size of sorting networks for 13 inputs.';
    const newGoal = 'Raise the proven lower bound on the size of sorting networks for 13 inputs, or find a smaller network.\n\nA bound without a checkable certificate does not count.';

    // the board of an earlier run: one card that was in progress when it was stopped
    const board = new Board({ dir, goal: oldGoal });
    const { agent } = board.joinQueue({ idea: 'Enumerate the first layers up to symmetry and bound the rest.' });
    board.peekTurn(agent.token);
    board.claimCard({ token: agent.token, title: 'Layer enumeration', approach: 'Enumerate the first two layers up to symmetry, then bound what the remaining layers need.' });
    board.flush();

    fs.writeFileSync(path.join(cwd, 'goal.md'), `${newGoal}\r\n`);
    const out = await serve(cwd, ['--goal-file', 'goal.md'], () => fs.existsSync(path.join(cwd, 'result.md')) && state().project.goal === newGoal);

    assert.doesNotMatch(out, /already holds a board/);
    assert.match(out, /The goal changed\. The board is kept/);
    assert.match(out, /resumed with a changed goal/);
    const s = state();
    assert.equal(s.project.goal, newGoal);
    assert.equal(s.project.goalHistory[0].goal, oldGoal);
    assert.equal(s.cards['C-1'].title, 'Layer enumeration', 'the card of the earlier run is still on the board');
    assert.equal(s.cards['C-1'].status, 'open', 'and waits for a fresh agent');
    assert.match(fs.readFileSync(path.join(cwd, 'result.md'), 'utf8'), /certificate does not count/, 'result.md is about the new goal at once');
    assert.equal(fs.readdirSync(cwd).filter((f) => f.startsWith('.wwresearch')).length, 1, 'nothing was archived');

    // starting again with the unchanged file is a plain resume
    const again = await serve(cwd, ['--goal-file', 'goal.md'], (o) => /MCP/.test(o));
    assert.match(again, /\(resumed\)/);
    assert.doesNotMatch(again, /The goal changed/);
    assert.equal(state().project.goalHistory.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
