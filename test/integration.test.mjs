import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../src/subprocess.mjs';
import { identitySlug, normalizeStateIdentity, StateStore } from '../src/state/store.mjs';
import { parsePrRef } from '../src/github/pr-ref.mjs';
import { makeFakeBin } from './helpers/fake-bin.mjs';
import { withTempRepo } from './helpers/temp-repo.mjs';

test('fixture-backed loop fixes findings, commits, pushes, then exits clean', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const ghState = JSON.parse(await readFile(join(fake.stateDir, 'gh-state.json'), 'utf8'));
    const triggers = ghState.comments.filter((comment) => comment.body === '@codex review');
    assert.equal(triggers.length, 2);
    const log = await runProcess('git', ['log', '--oneline', '-2'], { cwd: root });
    assert.match(log.stdout, /Address Codex review findings \(round 1\)/);
    const subject = await readFile(join(root, 'subject.txt'), 'utf8');
    assert.match(subject, /fixed by codex/);
  });
});

test('unacknowledged trigger is deleted and reposted', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_SKIP_ACK_FIRST: '1'
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--trigger-ack-timeout', '1s',
      '--review-timeout', '30s'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const ghState = JSON.parse(await readFile(join(fake.stateDir, 'gh-state.json'), 'utf8'));
    assert.equal(ghState.deleted.length, 1);
    assert.equal(ghState.comments.filter((comment) => comment.body === '@codex review').length, 2);
  });
});

test('dirty initial worktree fails before posting a trigger', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(root, 'dirty.txt'), 'dirty\n'));
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000, allowFailure: true });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Dirty worktree/);
    const runState = await readRunState({ stateRoot: join(root, '.git', 'cloud-review-loop', 'state'), root });
    assert.equal(runState.runState, 'failed');
    assert.equal(runState.failure.reason, 'DIRTY_WORKTREE');
    const stateFile = join(fake.stateDir, 'gh-state.json');
    await assert.rejects(() => readFile(stateFile, 'utf8'));
  });
});

test('runner git control tampering fails before commit and push', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_CODEX_TAMPER_GIT: '1'
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000, allowFailure: true });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Runner modified git control state/);
    const log = await runProcess('git', ['log', '--oneline'], { cwd: root });
    assert.doesNotMatch(log.stdout, /Address Codex review findings/);
  });
});

test('generated state and log paths do not count as runner fixes', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_CODEX_NO_WORKTREE_EDIT: '1',
      FAKE_CODEX_RESULT_STATUS: 'no_op'
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s',
      '--state-dir', '.cloud-review-loop/state',
      '--log-dir', '.cloud-review-loop/logs'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000, allowFailure: true });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /NO_FIX_PRODUCED/);
    const log = await runProcess('git', ['log', '--oneline'], { cwd: root });
    assert.doesNotMatch(log.stdout, /Address Codex review findings/);
  });
});

test('max runner failures is enforced and persisted', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_CODEX_FAIL: '1'
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s',
      '--max-runner-failures', '1'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000, allowFailure: true });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /max runner failures reached/);
    const state = await readRunState({ stateRoot: join(root, '.git', 'cloud-review-loop', 'state'), root });
    assert.equal(state.runState, 'failed');
    assert.equal(state.runnerFailures, 1);
    assert.equal(state.failure.reason, 'MAX_RUNNER_FAILURES');
  });
});

test('runner failures below the configured maximum are retried in process', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_CODEX_FAIL_COUNT: '1'
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s',
      '--max-runner-failures', '2'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const ghState = JSON.parse(await readFile(join(fake.stateDir, 'gh-state.json'), 'utf8'));
    assert.equal(ghState.runnerCount, 2);
    const state = await readRunState({ stateRoot: join(root, '.git', 'cloud-review-loop', 'state'), root });
    assert.equal(state.runState, 'succeeded');
    assert.equal(state.runnerFailures, 1);
  });
});

test('review timeout bounds trigger acknowledgement polling', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_SKIP_ACK_FIRST: '1'
    };
    const started = Date.now();
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--review-timeout', '1s',
      '--trigger-ack-timeout', '30s'
    ], { cwd: process.cwd(), env, timeoutMs: 5_000, allowFailure: true });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /review timeout reached while waiting for trigger acknowledgement/);
    assert.ok(Date.now() - started < 5_000);
  });
});

test('late inline findings after runner spawn are replayed before next trigger', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_LATE_AFTER_SPAWN: '1'
    };
    await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });
    const ghState = JSON.parse(await readFile(join(fake.stateDir, 'gh-state.json'), 'utf8'));
    assert.equal(ghState.runnerCount, 2);
    assert.equal(ghState.comments.filter((comment) => comment.body === '@codex review').length, 2);
    const state = await readRunState({ stateRoot: join(root, '.git', 'cloud-review-loop', 'state'), root });
    assert.equal(state.runState, 'succeeded');
    assert.ok(state.rounds.some((round) => round.state === 'pushed' && round.findings?.comments?.some((comment) => comment.id === 602)));
  });
});

test('late trusted reviews after runner spawn are replayed before next trigger', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_LATE_REVIEW_AFTER_SPAWN: '1'
    };
    await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });
    const ghState = JSON.parse(await readFile(join(fake.stateDir, 'gh-state.json'), 'utf8'));
    assert.equal(ghState.runnerCount, 2);
    assert.equal(ghState.comments.filter((comment) => comment.body === '@codex review').length, 2);
    const state = await readRunState({ stateRoot: join(root, '.git', 'cloud-review-loop', 'state'), root });
    assert.equal(state.runState, 'succeeded');
    assert.ok(state.rounds.some((round) => round.state === 'pushed' && round.findings?.reviews?.some((review) => review.id === 502)));
    assert.ok(state.rounds.some((round) => round.state === 'pushed' && round.findings?.comments?.some((comment) => comment.id === 603)));
  });
});

test('allow-runner-commit accepts clean runner commit as produced fix', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_CODEX_COMMIT: '1'
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s',
      '--allow-runner-commit'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const log = await runProcess('git', ['log', '--oneline', '-2'], { cwd: root });
    assert.match(log.stdout, /Runner fix/);
    assert.doesNotMatch(log.stdout, /Address Codex review findings \(round 1\)/);
    const state = await readRunState({ stateRoot: join(root, '.git', 'cloud-review-loop', 'state'), root });
    assert.equal(state.runState, 'succeeded');
    assert.ok(state.rounds.some((round) => round.state === 'pushed' && round.toolCommitSha));
  });
});

test('GitHub rate-limit retry emits backoff log event', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_RATE_LIMIT_ONCE: '1'
    };
    await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });
    const logText = await readRunLog({ logRoot: join(root, '.git', 'cloud-review-loop', 'logs'), root });
    assert.match(logText, /"type":"github_backoff"/);
  });
});

test('resume from interrupted fixing with no diff and no result fails reconciliation', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const store = new StateStore(join(stateRoot, identitySlug(identity)));
    await store.write({
      schemaVersion: 1,
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'fixing',
        trigger: { id: 1, created_at: '2026-04-28T18:00:00Z' },
        localHeadBeforeRunner: head
      }],
      processedCommentIds: [],
      processedReviewIds: [],
      processedInlineCommentIds: []
    });
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--resume',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000, allowFailure: true });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /manual reconciliation required/);
    const state = await store.read();
    assert.equal(state.runState, 'failed');
    assert.equal(state.failure.reason, 'RESUME_FIXING_RECONCILIATION');
  });
});

test('resume from interrupted fixing reconciles dirty runner edits before validation', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const stateDir = join(stateRoot, identitySlug(identity));
    const store = new StateStore(stateDir);
    await store.write({
      schemaVersion: 1,
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'fixing',
        trigger: { id: 100, created_at: '2026-04-28T18:00:01.000Z' },
        localHeadBeforeRunner: head,
        processedReviewIds: [],
        processedInlineCommentIds: []
      }],
      processedCommentIds: [],
      processedReviewIds: [],
      processedInlineCommentIds: []
    });
    await writeFile(join(root, 'subject.txt'), 'initial\ninterrupted edit\n');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'runner-result.json'), JSON.stringify({
      schemaVersion: 1,
      status: 'fixed',
      reviewFingerprint: 'fake',
      summary: 'interrupted edit present',
      tests: [],
      noOpReason: null
    }));
    await writeFile(join(fake.stateDir, 'gh-state.json'), JSON.stringify({
      calls: [],
      comments: [{ id: 100, body: '@codex review', created_at: '2026-04-28T18:00:01.000Z', user: { login: 'tool-user' } }],
      deleted: [],
      nextId: 101
    }));
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--resume',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });

    assert.equal(result.code, 0);
    const state = await store.read();
    assert.equal(state.runState, 'succeeded');
    assert.ok(state.rounds.some((round) => round.state === 'pushed'));
    const subject = await readFile(join(root, 'subject.txt'), 'utf8');
    assert.match(subject, /interrupted edit/);
    assert.match(subject, /fixed by codex/);
  });
});

test('state directories are scoped by normalized identity', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head
    };
    const args = [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s'
    ];
    await runProcess(process.execPath, args, { cwd: process.cwd(), env, timeoutMs: 30_000 });
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const expectedState = join(root, '.git', 'cloud-review-loop', 'state', identitySlug(identity), 'state.json');
    const state = JSON.parse(await readFile(expectedState, 'utf8'));
    assert.equal(state.identity.pr, 'OWNER/REPO#123');
    assert.equal(state.runState, 'succeeded');
  });
});

async function readRunState({ stateRoot, root }) {
  const pr = parsePrRef('OWNER/REPO#123');
  const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
  return JSON.parse(await readFile(join(stateRoot, identitySlug(identity), 'state.json'), 'utf8'));
}

async function readRunLog({ logRoot, root }) {
  const pr = parsePrRef('OWNER/REPO#123');
  const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
  const dir = join(logRoot, identitySlug(identity));
  const files = await readdir(dir);
  const chunks = await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')));
  return chunks.join('\n');
}
