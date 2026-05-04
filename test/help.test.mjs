import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../src/subprocess.mjs';
import { assertIncludes } from './helpers/assertions.mjs';

test('help is side-effect free', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crl-help-'));
  try {
    const result = await runProcess(process.execPath, [join(process.cwd(), 'bin/prloop.mjs'), '--help'], { cwd: dir });
    assert.equal(result.code, 0);
    assertIncludes(result.stdout, 'prloop run');
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run and resume reject status-only --state flag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crl-state-flag-'));
  try {
    for (const command of ['run', 'resume']) {
      const result = await runProcess(process.execPath, [
        join(process.cwd(), 'bin/prloop.mjs'),
        command,
        '--state', 'custom-state',
        '--json'
      ], { cwd: dir, allowFailure: true });
      assert.equal(result.code, 2);
      const error = JSON.parse(result.stderr);
      assert.equal(error.reason, 'USAGE');
      assert.match(error.message, /--state is only supported for status/);
    }
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
