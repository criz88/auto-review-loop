import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, redact } from '../src/log.mjs';
import { StateStore } from '../src/state/store.mjs';
import { buildClaudeSandboxProfile } from '../src/runner/claude.mjs';

test('redaction covers common token and credential forms', () => {
  assert.equal(redact('ghp_abcdefghijklmnopqrstuvwxyz'), '[REDACTED]');
  assert.equal(redact('github_pat_abcdefghijklmnopqrstuvwxyz_1234567890'), '[REDACTED]');
  assert.equal(redact('glpat-abcdefghijklmnopqrstuvwxyz_1234567890'), '[REDACTED]');
  assert.equal(redact('sk-abcdefghijklmnopqrstuvwxyz_1234567890'), '[REDACTED]');
  assert.equal(redact('token=abc123'), 'token=[REDACTED]');
  assert.equal(redact('password=swordfish'), 'password=[REDACTED]');
  assert.equal(redact('https://user:pass@example.com/repo.git'), 'https://[REDACTED]@example.com/repo.git');
  assert.equal(redact('Authorization: Bearer secret-value'), 'Authorization: Bearer [REDACTED]');
});

test('logger redacts secret-shaped object keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crl-log-'));
  try {
    const logger = new Logger(dir);
    const entry = { token: 'abc', nested: { password: 'pw' } };
    await logger.event('test', entry);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(logger.path, 'utf8');
    assert.match(raw, /"token":"\[REDACTED\]"/);
    assert.match(raw, /"password":"\[REDACTED\]"/);
    assert.doesNotMatch(raw, /abc|pw/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lock acquisition is atomic and rejects second owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crl-lock-'));
  try {
    const a = new StateStore(dir);
    const b = new StateStore(dir);
    await a.acquireLock({ pr: 'OWNER/REPO#1', worktree: dir, branch: 'main' });
    await assert.rejects(
      () => b.acquireLock({ pr: 'OWNER/REPO#1', worktree: dir, branch: 'main' }),
      /Active cloud-review-loop lock exists/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claude sandbox profile allows live Claude paths without broad home reads', () => {
  const profile = buildClaudeSandboxProfile({
    worktree: '/repo',
    stateDir: '/repo/.git/cloud-review-loop/state/run',
    claudeExecutable: '/Users/alice/.local/share/claude/versions/2.1.119',
    homeDir: '/Users/alice'
  });
  assert.match(profile, /\(allow network\*\)/);
  assert.doesNotMatch(profile, /\(allow file-read\*\)\s*$/m);
  assert.doesNotMatch(profile, /\(subpath "\/Users"\)/);
  assert.doesNotMatch(profile, /\(subpath "\/Users\/alice"\)/);
  assert.doesNotMatch(profile, /HOME/);
  assert.match(profile, /\(subpath "\/repo"\)/);
  assert.match(profile, /\(subpath "\/Users\/alice\/\.claude"\)/);
  assert.match(profile, /\(subpath "\/Users\/alice\/\.claude\.json"\)/);
  assert.match(profile, /\(subpath "\/Users\/alice\/\.local\/share\/claude"\)/);
  assert.match(profile, /\(subpath "\/Users\/alice\/Library\/Keychains"\)/);
  assert.match(profile, /\(subpath "\/Library\/Application Support\/ClaudeCode"\)/);
  assert.match(profile, /\(subpath "\/usr\/share"\)/);
  assert.match(profile, /\(allow mach-lookup\)/);
});
