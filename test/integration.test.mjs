import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../src/subprocess.mjs';
import { identitySlug, normalizeStateIdentity, StateStore } from '../src/state/store.mjs';
import { parsePrRef } from '../src/github/pr-ref.mjs';
import { makeFakeBin } from './helpers/fake-bin.mjs';
import { withTempRepo } from './helpers/temp-repo.mjs';
import { buildToolCommitIntent, buildToolCommitMessage } from '../src/loop/tool-commit.mjs';

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
    const triggers = ghState.comments.filter((comment) => comment.body.startsWith('@codex review'));
    assert.equal(triggers.length, 2);
    const log = await runProcess('git', ['log', '--oneline', '-2'], { cwd: root });
    assert.match(log.stdout, /Address Codex review findings \(round 1\)/);
    const subject = await readFile(join(root, 'subject.txt'), 'utf8');
    assert.match(subject, /fixed by codex/);
  });
});

const canRunClaudeSandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

test('fixture-backed Claude lane completes two finding fix push rounds', {
  skip: canRunClaudeSandbox ? false : 'Claude runner requires macOS sandbox-exec'
}, async () => {
  await withTempRepo(async ({ root, head }) => {
    const fake = await makeFakeBin({ stateDir: join(root, '.fake-gh-state') });
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_FINDING_ROUNDS: '2'
    };
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'run',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--runner', 'claude',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s',
      '--max-runner-failures', '1'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const ghState = JSON.parse(await readFile(join(fake.stateDir, 'gh-state.json'), 'utf8'));
    assert.equal(ghState.runnerCount, 2);
    assert.equal(ghState.comments.filter((comment) => comment.body.startsWith('@codex review')).length, 3);
    const subject = await readFile(join(root, 'subject.txt'), 'utf8');
    assert.equal(subject.match(/fixed by claude/g)?.length, 2);
    const log = await runProcess('git', ['log', '--oneline', '-2'], { cwd: root });
    assert.match(log.stdout, /Address Codex review findings \(round 2\)/);
    assert.match(log.stdout, /Address Codex review findings \(round 1\)/);
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
    assert.equal(ghState.comments.filter((comment) => comment.body.startsWith('@codex review')).length, 2);
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

test('broad generated root overrides are rejected before clean checks', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    await writeFile(join(root, 'dirty.txt'), 'dirty\n');
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
      '--state-dir', '.',
      '--log-dir', '.cloud-review-loop/logs'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000, allowFailure: true });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--state-dir must not resolve to the worktree root or an ancestor/);
    const stateFile = join(fake.stateDir, 'gh-state.json');
    await assert.rejects(() => readFile(stateFile, 'utf8'));
  });
});

test('generated root overrides cannot cover tracked worktree files', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'real-source.txt'), 'tracked\n');
    await runProcess('git', ['add', 'src/real-source.txt'], { cwd: root });
    await runProcess('git', ['commit', '-m', 'Add source fixture'], { cwd: root });
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
      '--state-dir', 'src',
      '--log-dir', '.cloud-review-loop/logs'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000, allowFailure: true });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--state-dir must not contain tracked worktree files/);
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

test('status --json reports stable resume action for existing runner output', async () => {
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const stateDir = join(stateRoot, identitySlug(identity));
    const store = new StateStore(stateDir);
    await store.write({
      schemaVersion: 1,
      runId: identitySlug(identity),
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'fixing',
        trigger: { id: 100, created_at: '2026-04-28T18:00:01.000Z' },
        localHeadBeforeRunner: head,
        remoteHeadBeforeRunner: head,
        findings: makeFindings(head),
        findingsFingerprint: 'fake',
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

    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'status',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--json'
    ], { cwd: process.cwd(), timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.kind, 'prloop.status');
    assert.equal(status.run.state, 'active');
    assert.equal(status.run.phase, 'fixing');
    assert.equal(status.run.recommendedAction, 'commit_existing_diff');
    assert.equal(status.run.resumable, true);
    assert.equal(status.latestRound.number, 1);
  });
});

test('status --json reports unproven local head as manual reconciliation', async () => {
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const stateDir = join(stateRoot, identitySlug(identity));
    const store = new StateStore(stateDir);
    await store.write({
      schemaVersion: 1,
      runId: identitySlug(identity),
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'fixing',
        trigger: { id: 100, created_at: '2026-04-28T18:00:01.000Z' },
        localHeadBeforeRunner: head,
        remoteHeadBeforeRunner: head,
        findings: makeFindings(head),
        findingsFingerprint: 'fake',
        processedReviewIds: [],
        processedInlineCommentIds: []
      }],
      processedCommentIds: [],
      processedReviewIds: [],
      processedInlineCommentIds: []
    });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'runner-result.json'), JSON.stringify({
      schemaVersion: 1,
      status: 'fixed',
      reviewFingerprint: 'fake',
      summary: 'local commit present',
      tests: [],
      noOpReason: null
    }));
    await writeFile(join(root, 'subject.txt'), 'initial\nlocal commit\n');
    await runProcess('git', ['add', 'subject.txt'], { cwd: root });
    await runProcess('git', [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'Local commit'
    ], { cwd: root });

    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'status',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--json'
    ], { cwd: process.cwd(), timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.run.recommendedAction, 'manual_reconcile');
    assert.equal(status.run.resumable, false);
  });
});

test('status --json reports proven tool commit local head reconciliation as resumable', async () => {
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const runId = identitySlug(identity);
    const stateDir = join(stateRoot, runId);
    const store = new StateStore(stateDir);
    const round = {
      number: 1,
      localHeadBeforeRunner: head,
      findingsFingerprint: 'fake'
    };
    const toolCommitIntent = buildToolCommitIntent({ state: { runId }, round });
    await store.write({
      schemaVersion: 1,
      runId,
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'fixing',
        trigger: { id: 100, created_at: '2026-04-28T18:00:01.000Z' },
        localHeadBeforeRunner: head,
        remoteHeadBeforeRunner: head,
        findings: makeFindings(head),
        findingsFingerprint: 'fake',
        toolCommitIntent,
        processedReviewIds: [],
        processedInlineCommentIds: []
      }],
      processedCommentIds: [],
      processedReviewIds: [],
      processedInlineCommentIds: []
    });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'runner-result.json'), JSON.stringify({
      schemaVersion: 1,
      status: 'fixed',
      reviewFingerprint: 'fake',
      summary: 'tool commit present',
      tests: [],
      noOpReason: null
    }));
    await writeFile(join(root, 'subject.txt'), 'initial\ntool commit\n');
    await runProcess('git', ['add', 'subject.txt'], { cwd: root });
    await runProcess('git', [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      buildToolCommitMessage(toolCommitIntent)
    ], { cwd: root });

    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'status',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--json'
    ], { cwd: process.cwd(), timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.run.recommendedAction, 'reconcile_local_head');
    assert.equal(status.run.resumable, true);
  });
});

test('status --json reports precondition action when fixing git metadata is unavailable', async () => {
  await withTempRepo(async ({ root, head }) => {
    const stateDir = join(root, '.git', 'cloud-review-loop', 'state', 'missing-git');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: join(root, 'missing-worktree'), branch: 'feature/test' });
    const store = new StateStore(stateDir);
    await store.write({
      schemaVersion: 1,
      runId: 'missing-git',
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'fixing',
        trigger: { id: 100, created_at: '2026-04-28T18:00:01.000Z' },
        localHeadBeforeRunner: head,
        remoteHeadBeforeRunner: head,
        findings: makeFindings(head),
        findingsFingerprint: 'fake',
        processedReviewIds: [],
        processedInlineCommentIds: []
      }],
      processedCommentIds: [],
      processedReviewIds: [],
      processedInlineCommentIds: []
    });
    await writeFile(join(stateDir, 'runner-result.json'), JSON.stringify({
      schemaVersion: 1,
      status: 'fixed',
      reviewFingerprint: 'fake',
      summary: 'interrupted edit present',
      tests: [],
      noOpReason: null
    }));

    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'status',
      '--state', join(stateDir, 'state.json'),
      '--json'
    ], { cwd: process.cwd(), timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.git.available, false);
    assert.equal(status.run.recommendedAction, 'fix_precondition');
    assert.equal(status.run.resumable, false);
  });
});

test('run --json emits structured failure reason', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    await writeFile(join(root, 'dirty.txt'), 'dirty\n');
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
      '--json',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test',
      '--trusted-review-actor', 'codex-bot',
      '--trusted-clean-actor', 'codex-bot',
      '--trusted-ack-actor', 'codex-bot',
      '--poll-interval', '0'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000, allowFailure: true });
    assert.equal(result.code, 3);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.kind, 'prloop.error');
    assert.equal(failure.ok, false);
    assert.equal(failure.reason, 'DIRTY_WORKTREE');
    assert.equal(failure.exitCode, 3);
    assert.equal(failure.resumable, true);
  });
});

test('status --json classifies non-repo worktree before resolving git paths', async () => {
  await withTempRepo(async ({ root }) => {
    await rm(join(root, '.git'), { recursive: true, force: true });
    const result = await runProcess(process.execPath, [
      join(process.cwd(), 'bin/prloop.mjs'),
      'status',
      '--json',
      '--pr', 'OWNER/REPO#123',
      '--worktree', root,
      '--branch', 'feature/test'
    ], { cwd: process.cwd(), timeoutMs: 30_000, allowFailure: true });

    assert.equal(result.code, 3);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.kind, 'prloop.error');
    assert.equal(failure.ok, false);
    assert.equal(failure.reason, 'NOT_GIT_REPO');
    assert.equal(failure.exitCode, 3);
    assert.equal(failure.resumable, false);
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
    assert.equal(ghState.comments.filter((comment) => comment.body.startsWith('@codex review')).length, 2);
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
    assert.equal(ghState.comments.filter((comment) => comment.body.startsWith('@codex review')).length, 2);
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

test('runner commit is forbidden even when subject matches tool commit subject', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_CODEX_COMMIT: '1',
      FAKE_CODEX_COMMIT_MESSAGE: 'Address Codex review findings (round 1)'
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

    assert.equal(result.code, 3);
    assert.match(result.stderr, /Runner created a commit; this is forbidden by default/);
    const state = await readRunState({ stateRoot: join(root, '.git', 'cloud-review-loop', 'state'), root });
    assert.equal(state.runState, 'failed');
    assert.equal(state.failure.reason, 'RUNNER_COMMIT_FORBIDDEN');
    const remoteHead = await runProcess('git', ['rev-parse', 'origin/feature/test'], { cwd: root });
    assert.equal(remoteHead.stdout.trim(), head);
  });
});

test('resume rejects matching-subject local head without tool commit provenance', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const runId = identitySlug(identity);
    const stateDir = join(stateRoot, runId);
    const store = new StateStore(stateDir);
    const findings = makeFindings(head);
    await store.write({
      schemaVersion: 1,
      runId,
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'fixing',
        trigger: { id: 100, created_at: '2026-04-28T18:00:01.000Z' },
        localHeadBeforeRunner: head,
        remoteHeadBeforeRunner: head,
        findings,
        findingsFingerprint: 'fake',
        processedReviewIds: [],
        processedInlineCommentIds: []
      }],
      processedCommentIds: [],
      processedReviewIds: [],
      processedInlineCommentIds: []
    });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'runner-result.json'), JSON.stringify({
      schemaVersion: 1,
      status: 'fixed',
      reviewFingerprint: 'fake',
      summary: 'interrupted commit present',
      tests: [],
      noOpReason: null
    }));
    await writeFile(join(root, 'subject.txt'), 'initial\nuntrusted local commit\n');
    await runProcess('git', ['add', 'subject.txt'], { cwd: root });
    await runProcess('git', [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'Address Codex review findings (round 1)'
    ], { cwd: root });
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
    ], { cwd: process.cwd(), env, timeoutMs: 30_000, allowFailure: true });

    assert.equal(result.code, 3);
    assert.match(result.stderr, /Cannot resume interrupted fixing state/);
    const state = await store.read();
    assert.equal(state.runState, 'failed');
    assert.equal(state.failure.reason, 'RESUME_LOCAL_HEAD_DRIFT');
    const remoteHead = await runProcess('git', ['rev-parse', 'origin/feature/test'], { cwd: root });
    assert.equal(remoteHead.stdout.trim(), head);
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

test('transient EOF while listing pull reviews is retried', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_EOF_ONCE: 'pull-reviews'
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
    assert.equal(ghState.eofSent['pull-reviews'], true);
    const logText = await readRunLog({ logRoot: join(root, '.git', 'cloud-review-loop', 'logs'), root });
    const backoff = logText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.type === 'github_backoff');
    assert.equal(backoff.operation, 'listPullReviews');
    assert.equal(backoff.reason, 'GITHUB_TRANSIENT');
    assert.equal(Object.hasOwn(backoff, 'args'), false);
    assert.doesNotMatch(JSON.stringify(backoff), /body=/);
  });
});

test('transient EOF while polling acknowledgement reactions is retried', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_EOF_ONCE: 'issue-comment-reactions'
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
    assert.equal(ghState.eofSent['issue-comment-reactions'], true);
    const logText = await readRunLog({ logRoot: join(root, '.git', 'cloud-review-loop', 'logs'), root });
    assert.match(logText, /"operation":"listIssueCommentReactions"/);
  });
});

test('transient EOF before posting review trigger is retried', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_EOF_ONCE: 'create-issue-comment'
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
    assert.equal(ghState.eofSent['create-issue-comment'], true);
    assert.equal(ghState.comments.filter((comment) => comment.body.startsWith('@codex review')).length, 2);
    const logText = await readRunLog({ logRoot: join(root, '.git', 'cloud-review-loop', 'logs'), root });
    assert.match(logText, /"type":"trigger_create_transient_failure"/);
  });
});

test('transient EOF after posting review trigger is recovered without duplicate trigger', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_EOF_AFTER_CREATE_ONCE: '1'
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
    assert.equal(ghState.eofAfterCreateSent, true);
    assert.equal(ghState.comments.filter((comment) => comment.body.startsWith('@codex review')).length, 2);
    const logText = await readRunLog({ logRoot: join(root, '.git', 'cloud-review-loop', 'logs'), root });
    assert.match(logText, /"type":"trigger_create_transient_failure"/);
    assert.match(logText, /"type":"trigger_recovered"/);
  });
});

test('exhausted transient EOF while polling acknowledgement keeps waiting', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_EOF_ONCE: 'issue-comment-reactions',
      FAKE_GH_EOF_COUNT: '3'
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
    assert.equal(ghState.eofCounts['issue-comment-reactions'], 3);
    const logText = await readRunLog({ logRoot: join(root, '.git', 'cloud-review-loop', 'logs'), root });
    assert.match(logText, /"type":"ack_poll_transient_failure"/);
    assert.match(logText, /"type":"acknowledged"/);
  });
});

test('transient EOF during late findings replay is retried', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_LATE_AFTER_SPAWN: '1',
      FAKE_GH_EOF_ONCE_AFTER_RUNNER: 'pull-review-comments'
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
    assert.equal(ghState.eofAfterRunnerSent['pull-review-comments'], true);
    const state = await readRunState({ stateRoot: join(root, '.git', 'cloud-review-loop', 'state'), root });
    assert.equal(state.runState, 'succeeded');
    assert.ok(state.rounds.some((round) => round.state === 'pushed' && round.findings?.comments?.some((comment) => comment.id === 602)));
  });
});

test('resume from interrupted fixing with no diff and no result reruns runner', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const store = new StateStore(join(stateRoot, identitySlug(identity)));
    const findings = makeFindings(head);
    await store.write({
      schemaVersion: 1,
      runState: 'active',
      identity,
      configSnapshot: {
        defaultRunner: 'codex',
        pollInterval: '0',
        maxRounds: 0,
        reviewTimeout: '30s',
        runnerTimeout: '30s',
        maxRunnerFailures: 0,
        pushRemote: 'origin',
        trustedReviewActors: ['codex-bot'],
        trustedCleanActors: ['codex-bot'],
        trustedAckActors: ['codex-bot'],
        triggerAckTimeout: '60s',
        maxTriggerReposts: 0,
        allowRunnerCommit: false,
        unsafeAllowBypassApprovals: false
      },
      rounds: [{
        number: 1,
        state: 'fixing',
        trigger: { id: 100, created_at: '2026-04-28T18:00:01.000Z' },
        localHeadBeforeRunner: head,
        remoteHeadBeforeRunner: head,
        findings,
        findingsFingerprint: 'fake',
        processedReviewIds: [],
        processedInlineCommentIds: []
      }],
      processedCommentIds: [],
      processedReviewIds: [],
      processedInlineCommentIds: []
    });
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
      '--poll-interval', '0',
      '--review-timeout', '30s',
      '--runner-timeout', '30s'
    ], { cwd: process.cwd(), env, timeoutMs: 30_000 });
    assert.equal(result.code, 0);
    const state = await store.read();
    assert.equal(state.runState, 'succeeded');
    const ghState = JSON.parse(await readFile(join(fake.stateDir, 'gh-state.json'), 'utf8'));
    assert.equal(ghState.runnerCount, 1);
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
    const findings = makeFindings(head);
    await store.write({
      schemaVersion: 1,
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'fixing',
        trigger: { id: 100, created_at: '2026-04-28T18:00:01.000Z' },
        localHeadBeforeRunner: head,
        remoteHeadBeforeRunner: head,
        findings,
        findingsFingerprint: 'fake',
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
    const ghState = JSON.parse(await readFile(join(fake.stateDir, 'gh-state.json'), 'utf8'));
    assert.equal(ghState.runnerCount || 0, 0);
    const subject = await readFile(join(root, 'subject.txt'), 'utf8');
    assert.match(subject, /interrupted edit/);
    assert.doesNotMatch(subject, /fixed by codex/);
  });
});

test('resume recovers an already posted review trigger without duplicating it', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const runId = identitySlug(identity);
    const marker = `<!-- prloop runId=${runId} round=1 -->`;
    const store = new StateStore(join(stateRoot, runId));
    await store.write({
      schemaVersion: 1,
      runId,
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'pending_trigger',
        triggerAttempt: 0,
        trigger: null,
        triggerIntent: {
          body: `@codex review\n\n${marker}`,
          marker,
          idempotencyKey: `${runId}:round:1`,
          createdAt: '2026-04-28T18:00:00.000Z'
        },
        ackReactionIds: [],
        deletedUnacknowledgedTriggerIds: [],
        findingsFingerprint: null,
        findings: null,
        processedReviewIds: [],
        processedInlineCommentIds: []
      }],
      processedCommentIds: [],
      processedReviewIds: [],
      processedInlineCommentIds: []
    });
    await writeFile(join(fake.stateDir, 'gh-state.json'), JSON.stringify({
      calls: [],
      comments: [
        { id: 98, body: `  @codex review\n\nstale edited trigger\n\n${marker}`, created_at: '2026-04-28T17:59:59.000Z', user: { login: 'tool-user' } },
        { id: 99, body: `quoted trigger:\n\n${marker}`, created_at: '2026-04-28T18:00:00.000Z', user: { login: 'another-user' } },
        { id: 100, body: `@codex review\n\nedited trigger\n\n${marker}`, created_at: '2026-04-28T18:00:01.000Z', user: { login: 'tool-user' } }
      ],
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
      'resume',
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
    assert.equal(ghState.comments.filter((comment) => comment.body.includes(marker)).length, 3);
    assert.equal(ghState.comments.filter((comment) => comment.body === `@codex review\n\n${marker}`).length, 0);
    assert.equal(ghState.comments.filter((comment) => comment.body.includes(marker) && comment.body.startsWith('@codex review')).length, 1);
    assert.equal(ghState.comments.filter((comment) => comment.body.startsWith('@codex review')).length, 2);
    const state = await store.read();
    assert.equal(state.rounds[0].trigger.id, 100);
    assert.equal(state.runState, 'succeeded');
  });
});

test('run posts a fresh review trigger instead of recovering a historical marker', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const runId = identitySlug(identity);
    const historicalMarker = `<!-- prloop runId=${runId} round=1 -->`;
    await writeFile(join(fake.stateDir, 'gh-state.json'), JSON.stringify({
      calls: [],
      comments: [
        { id: 99, body: `@codex review\n\nedited historical trigger\n\n${historicalMarker}`, created_at: '2026-04-28T18:00:00.000Z', user: { login: 'tool-user' } }
      ],
      deleted: [],
      nextId: 100
    }));
    const env = {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
      FAKE_GH_STATE_DIR: fake.stateDir,
      FAKE_PR_BRANCH: 'feature/test',
      FAKE_PR_HEAD_SHA: head,
      FAKE_GH_FINDING_ROUNDS: '2'
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
    const state = await readRunState({ stateRoot, root });
    const freshTrigger = ghState.comments.find((comment) => comment.id === 100);
    const freshMarker = `<!-- prloop runId=${state.triggerRunId} round=1 -->`;
    assert.equal(freshTrigger.body, `@codex review\n\n${freshMarker}`);
    assert.notEqual(state.triggerRunId, state.runId);
    assert.equal(freshTrigger.body.includes(historicalMarker), false);
    assert.equal(state.rounds[0].trigger.id, 100);
    assert.equal(state.runState, 'succeeded');
  });
});

test('resume posts persisted fresh trigger instead of recovering older execution marker', async () => {
  const fake = await makeFakeBin();
  await withTempRepo(async ({ root, head }) => {
    const stateRoot = join(root, '.git', 'cloud-review-loop', 'state');
    const pr = parsePrRef('OWNER/REPO#123');
    const identity = normalizeStateIdentity({ pr, worktree: await realpath(root), branch: 'feature/test' });
    const runId = identitySlug(identity);
    const triggerRunId = `${runId}-fresh123`;
    const marker = `<!-- prloop runId=${triggerRunId} round=1 -->`;
    const historicalMarker = `<!-- prloop runId=${runId} round=1 -->`;
    const store = new StateStore(join(stateRoot, runId));
    await store.write({
      schemaVersion: 1,
      runId,
      triggerRunId,
      runState: 'active',
      identity,
      rounds: [{
        number: 1,
        state: 'pending_trigger',
        triggerAttempt: 0,
        trigger: null,
        triggerIntent: {
          body: `@codex review\n\n${marker}`,
          marker,
          idempotencyKey: `${triggerRunId}:round:1`,
          createdAt: '2026-04-28T18:00:00.000Z'
        },
        ackReactionIds: [],
        deletedUnacknowledgedTriggerIds: [],
        findingsFingerprint: null,
        findings: null,
        processedReviewIds: [],
        processedInlineCommentIds: []
      }],
      processedCommentIds: [],
      processedReviewIds: [],
      processedInlineCommentIds: []
    });
    await writeFile(join(fake.stateDir, 'gh-state.json'), JSON.stringify({
      calls: [],
      comments: [
        { id: 99, body: `@codex review\n\nstale historical trigger\n\n${historicalMarker}`, created_at: '2026-04-28T17:59:59.000Z', user: { login: 'tool-user' } }
      ],
      deleted: [],
      nextId: 100
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
      'resume',
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
    const freshTrigger = ghState.comments.find((comment) => comment.id === 100);
    assert.equal(freshTrigger.body, `@codex review\n\n${marker}`);
    const state = await store.read();
    assert.equal(state.rounds[0].trigger.id, 100);
    assert.equal(state.runState, 'succeeded');
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

function makeFindings(commit) {
  return {
    reviews: [{
      id: 501,
      state: 'COMMENTED',
      body: 'Finding body',
      commit_id: commit,
      submitted_at: '2026-04-28T18:00:21.000Z',
      user: { login: 'codex-bot' }
    }],
    comments: [{
      id: 601,
      pull_request_review_id: 501,
      body: 'Inline finding',
      path: 'subject.txt',
      line: 1,
      commit_id: commit,
      created_at: '2026-04-28T18:00:22.000Z',
      user: { login: 'codex-bot' }
    }],
    fingerprint: 'fake'
  };
}

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
