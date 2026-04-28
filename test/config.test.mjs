import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDuration } from '../src/duration.mjs';
import { loadConfig } from '../src/config.mjs';
import { parseFlags } from '../src/cli.mjs';
import { parsePrRef } from '../src/github/pr-ref.mjs';

test('duration parsing accepts supported units and rejects invalid values', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('0'), 0);
  assert.throws(() => parseDuration('-1s'), /Invalid/);
  assert.throws(() => parseDuration('1.5s'), /Invalid/);
  assert.throws(() => parseDuration('10d'), /Invalid/);
  assert.throws(() => parseDuration(''), /Invalid/);
});

test('PR references parse supported formats', () => {
  assert.deepEqual(parsePrRef('https://github.com/OWNER/REPO/pull/123'), {
    owner: 'OWNER',
    repo: 'REPO',
    number: 123,
    fullName: 'OWNER/REPO'
  });
  assert.equal(parsePrRef('OWNER/REPO#7').number, 7);
  assert.equal(parsePrRef('7', 'OWNER/REPO').fullName, 'OWNER/REPO');
  assert.throws(() => parsePrRef('7'), /Numeric --pr requires/);
  assert.throws(() => parsePrRef('https://example.com/x/y/pull/1'), /Unsupported/);
});

test('config precedence uses CLI over config over defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crl-config-'));
  try {
    await writeFile(join(dir, '.cloud-review-loop.json'), JSON.stringify({
      defaultRunner: 'claude',
      pollInterval: '10m',
      trustedReviewActors: ['config-review'],
      trustedCleanActors: ['config-clean'],
      trustedAckActors: ['config-ack']
    }));
    const flags = parseFlags([
      '--runner', 'codex',
      '--trusted-review-actor', 'cli-review',
      '--trusted-clean-actor', 'cli-clean',
      '--trusted-ack-actor', 'cli-ack'
    ]);
    const { config } = await loadConfig(dir, flags);
    assert.equal(config.defaultRunner, 'codex');
    assert.equal(config.pollIntervalMs, 600_000);
    assert.deepEqual(config.trustedReviewActors, ['cli-review']);
    assert.deepEqual(config.trustedCleanActors, ['cli-clean']);
    assert.deepEqual(config.trustedAckActors, ['cli-ack']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TOML config path is rejected with JSON-only diagnostic', async () => {
  await assert.rejects(
    () => loadConfig(process.cwd(), { config: 'config.toml' }),
    /Only JSON config is supported/
  );
});
