import { dirname, join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { GitWorktree } from './git/worktree.mjs';
import { resolveRunContext } from './run-context.mjs';
import { StateStore } from './state/store.mjs';
import { reasonMetadata } from './errors.mjs';

export async function buildStatus({ flags, cwd, env = process.env }) {
  const context = flags.state
    ? await contextFromStateFlag({ state: flags.state, cwd, env })
    : await resolveRunContext({ flags, cwd, env });
  const store = new StateStore(context.stateDir);
  const state = await store.read();
  const lock = await summarizeLock(store);
  const git = await summarizeGit({ state, context, env });
  const latestRound = state?.rounds?.at(-1) || null;
  const failure = state?.failure ? normalizeFailure(state.failure) : null;
  const run = await summarizeRun({ state, latestRound, failure, lock, git, context });

  return {
    schemaVersion: 1,
    kind: 'prloop.status',
    ok: true,
    runId: state?.runId || context.runId || null,
    statePath: context.statePath,
    logDir: state?.paths?.logDir || context.logDir || null,
    identity: state?.identity || context.identity || null,
    run,
    lock,
    failure,
    latestRound: latestRound ? summarizeRound(latestRound) : null,
    git
  };
}

export function formatStatus(status) {
  const identity = status.identity
    ? `${status.identity.pr} ${status.identity.branch} ${status.identity.worktree}`
    : '(no identity)';
  const failure = status.failure ? ` failure=${status.failure.reason}` : '';
  return [
    `runId: ${status.runId || '(none)'}`,
    `identity: ${identity}`,
    `state: ${status.run.state}`,
    `phase: ${status.run.phase}`,
    `recommendedAction: ${status.run.recommendedAction}${failure}`,
    `statePath: ${status.statePath}`
  ].join('\n') + '\n';
}

async function contextFromStateFlag({ state, cwd, env }) {
  const resolved = resolve(cwd, state);
  const statePath = isDirectory(resolved) ? join(resolved, 'state.json') : resolved;
  const stateDir = dirname(statePath);
  const stored = await readStateIfPresent(statePath);
  const worktree = stored?.identity?.worktree || null;
  const runId = stored?.runId || null;
  return {
    cwd,
    env,
    runId,
    stateDir,
    statePath,
    logDir: stored?.paths?.logDir || null,
    identity: stored?.identity || null,
    git: worktree ? new GitWorktree({ cwd: worktree, env }) : null
  };
}

async function readStateIfPresent(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function summarizeLock(store) {
  const payload = await store.readLock().catch(() => null);
  if (!payload) {
    return { present: false, pid: null, active: false, stale: false, createdAt: null, lastSeenAt: null };
  }
  const active = processIsActive(payload.pid);
  return {
    present: true,
    pid: Number.isInteger(payload.pid) ? payload.pid : null,
    active,
    stale: !active,
    createdAt: payload.createdAt || null,
    lastSeenAt: payload.lastSeenAt || null
  };
}

async function summarizeGit({ state, context, env }) {
  const worktree = state?.identity?.worktree || context.identity?.worktree || null;
  if (!worktree) return null;
  const git = context.git || new GitWorktree({ cwd: worktree, env });
  const allowedRoots = [context.stateDir, state?.paths?.logDir || context.logDir].filter(Boolean);
  const summary = { worktree, available: false, head: null, branch: null, hasChangesOutsideGenerated: null };
  if (!await git.isRepo().catch(() => false)) return summary;
  summary.available = true;
  summary.head = await git.head().catch(() => null);
  summary.branch = await git.currentBranch().catch(() => null);
  summary.hasChangesOutsideGenerated = await git.hasChangesOutside(allowedRoots).catch(() => null);
  return summary;
}

async function summarizeRun({ state, latestRound, failure, lock, git, context }) {
  if (!state) {
    return {
      state: 'not_found',
      phase: 'not_found',
      terminal: false,
      resumable: false,
      recommendedAction: 'start'
    };
  }
  const runState = state.runState || 'unknown';
  const phase = latestRound?.state || runState;
  const terminal = runState === 'succeeded' || runState === 'failed';
  const action = await chooseRecommendedAction({ state, latestRound, failure, lock, git, context });
  return {
    state: runState,
    phase,
    terminal,
    resumable: isResumable({ runState, recommendedAction: action, failure, lock }),
    recommendedAction: action
  };
}

async function chooseRecommendedAction({ state, latestRound, failure, lock, git, context }) {
  if (state.runState === 'succeeded') return 'done';
  if (lock.active) return 'wait';
  if (state.runState === 'failed') {
    if (failure?.resumable) return 'resume';
    return 'fix_precondition';
  }
  if (!latestRound) return 'post_review_trigger';
  if (latestRound.state === 'pending_trigger') return 'post_review_trigger';
  if (latestRound.state === 'awaiting_ack' || latestRound.state === 'awaiting_result' || latestRound.state === 'findings_settling') {
    return 'wait_for_review';
  }
  if (latestRound.state === 'findings_collected') return 'process_findings';
  if (latestRound.state === 'pushed') return 'post_review_trigger';
  if (latestRound.state === 'clean_observed') return 'done';
  if (latestRound.state === 'fixing') {
    return fixingAction({ latestRound, git, context });
  }
  return 'resume';
}

function fixingAction({ latestRound, git, context }) {
  const hasRunnerResult = existsSync(join(context.stateDir, 'runner-result.json'));
  if (!git?.available) return 'fix_precondition';
  const headChanged = latestRound.localHeadBeforeRunner && git.head && git.head !== latestRound.localHeadBeforeRunner;
  if (headChanged) return 'reconcile_local_head';
  if (git.hasChangesOutsideGenerated && hasRunnerResult) return 'commit_existing_diff';
  if (git.hasChangesOutsideGenerated && !hasRunnerResult) return 'manual_reconcile';
  if (hasRunnerResult) return 'validate_runner_result';
  return 'rerun_runner';
}

function isResumable({ runState, recommendedAction, failure, lock }) {
  if (lock.active) return false;
  if (runState === 'succeeded') return false;
  if (runState === 'failed') return Boolean(failure?.resumable);
  return !['manual_reconcile', 'fix_precondition', 'reconcile_local_head', 'done'].includes(recommendedAction);
}

function summarizeRound(round) {
  return {
    number: round.number || null,
    state: round.state || null,
    triggerId: round.trigger?.id || null,
    findingsFingerprint: round.findingsFingerprint || null,
    toolCommitSha: round.toolCommitSha || null
  };
}

function normalizeFailure(failure) {
  const metadata = reasonMetadata(failure.reason);
  return {
    reason: failure.reason || 'ERROR',
    message: failure.message || '',
    at: failure.at || null,
    retryable: Boolean(failure.retryable ?? metadata.retryable),
    resumable: Boolean(failure.resumable ?? metadata.resumable)
  };
}

function processIsActive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
