import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/subprocess.mjs';

test('timeout escalates TERM-ignoring subprocesses to SIGKILL', async () => {
  const startedAt = Date.now();
  const result = await runProcess(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  ], {
    timeoutMs: 300,
    timeoutKillGraceMs: 50,
    allowFailure: true
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(Date.now() - startedAt < 2000);
});

test('resolves after stdout is fully drained', async () => {
  const payloadSize = 128 * 1024;
  const payload = 'x'.repeat(payloadSize);
  const result = await runProcess(process.execPath, [
    '-e',
    "process.stdout.write('x'.repeat(Number(process.argv[1])))",
    String(payloadSize)
  ]);

  assert.equal(result.stdout, payload);
});
