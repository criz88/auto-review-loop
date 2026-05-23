import { mkdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { configSnapshot } from '../config.mjs';
import { GhClient } from '../github/gh-client.mjs';
import { buildTriggerBody, buildTriggerMarker, isAcknowledgementReaction } from '../review/trigger.mjs';
import { collectActionableFindings, findCleanComment, isActionableReviewState, isAtOrAfter, updateSettlement } from '../review/classifier.mjs';
import { fingerprintFindings } from '../review/findings.mjs';
import { GitWorktree, validateWorktree } from '../git/worktree.mjs';
import { StateStore, identitySlug, normalizeStateIdentity, triggerRunId } from '../state/store.mjs';
import { Logger } from '../log.mjs';
import { buildFixPrompt } from '../prompt/fix-prompt.mjs';
import { classifyRunnerOutcome, readRunnerResult, runSelectedRunner } from '../runner/registry.mjs';
import { fail, reasonMetadata } from '../errors.mjs';
import {
  buildToolCommitIntent,
  buildToolCommitMessage,
  buildToolCommitSubject,
  hasExpectedToolCommitProvenance
} from './tool-commit.mjs';

export async function runController(input) {
  const git = input.git || new GitWorktree({ cwd: input.worktree, env: input.env });
  const identity = input.identity || normalizeStateIdentity(input);
  const runSlug = input.runId || identitySlug(identity);
  const reviewTriggerRunId = input.triggerRunId || triggerRunId(identity);
  const stateRoot = input.stateRoot || resolve(input.worktree, input.stateDirOverride || await git.revParseGitPath('cloud-review-loop/state'));
  const logRoot = input.logRoot || resolve(input.worktree, input.logDirOverride || await git.revParseGitPath('cloud-review-loop/logs'));
  const stateDir = input.stateDir || resolve(stateRoot, runSlug);
  const logDir = input.logDir || resolve(logRoot, runSlug);
  await validateGeneratedRootOverride({ name: '--state-dir', value: input.stateDirOverride, root: stateRoot, worktree: input.worktree, git });
  await validateGeneratedRootOverride({ name: '--log-dir', value: input.logDirOverride, root: logRoot, worktree: input.worktree, git });
  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const store = new StateStore(stateDir);
  const logger = new Logger(logDir);
  await store.acquireLock(identity);
  const stopHeartbeat = store.startHeartbeat();

  try {
    let state = await loadInitialState({ store, input, identity, runSlug, triggerRunId: reviewTriggerRunId, stateDir, logDir });
    const allowedRoots = input.stateDirOverride || input.logDirOverride ? [stateRoot, logRoot] : [];
    if (state.runState === 'initialized') {
      await store.write(state);
    }
    let gh = null;
    if (input.resume) {
      gh = new GhClient({
        cwd: input.worktree,
        env: input.env,
        owner: input.pr.owner,
        repo: input.pr.repo,
        number: input.pr.number,
        logger
      });
      await reconcileResumeIfNeeded({ input, state, store, logger, gh, git, stateDir, logDir });
    }
    await validateWorktree({ git, branch: input.branch, allowedRoots, allowDirty: isInterruptedFixingResume(input, state) });
    gh = gh || new GhClient({
      cwd: input.worktree,
      env: input.env,
      owner: input.pr.owner,
      repo: input.pr.repo,
      number: input.pr.number,
      logger
    });
    const prMeta = await gh.getPull();
    validatePrMeta(prMeta, input.branch);
    await logger.event('validated', { pr: identity.pr, branch: input.branch, configPath: input.configPath || null });
    state.runState = 'validated';
    await store.write(state);
    state.runState = 'active';
    await store.write(state);

    while (true) {
      if (input.config.maxRounds > 0 && state.rounds.length >= input.config.maxRounds) {
        fail(`max rounds reached: ${input.config.maxRounds}`, 'MAX_ROUNDS');
      }
      const round = await runRound({ input, state, store, logger, gh, git, stateDir, logDir });
      state = round.state;
      if (round.done) return 0;
    }
  } catch (error) {
    await logger.event('failed', { reason: error.reason || 'ERROR', message: error.message }).catch(() => {});
    const failedState = await store.read().catch(() => null);
    if (failedState) {
      const metadata = reasonMetadata(error.reason || 'ERROR');
      failedState.runState = 'failed';
      failedState.failure = {
        reason: error.reason || 'ERROR',
        message: error.message,
        at: new Date().toISOString(),
        retryable: Boolean(error.retryable ?? metadata.retryable),
        resumable: Boolean(error.resumable ?? metadata.resumable)
      };
      await store.write(failedState).catch(() => {});
    }
    throw error;
  } finally {
    stopHeartbeat();
    await store.releaseLock().catch(() => {});
  }
}

async function loadInitialState({ store, input, identity, runSlug, triggerRunId, stateDir, logDir }) {
  const existing = await store.read();
  if (input.resume) {
    if (!existing) fail('--resume requested but no state exists', 'RESUME_NOT_FOUND');
    if (JSON.stringify(existing.identity) !== JSON.stringify(identity)) {
      fail('--resume state does not match PR/worktree/branch', 'RESUME_MISMATCH');
    }
    existing.runId = existing.runId || runSlug;
    existing.triggerRunId = existing.triggerRunId || existing.runId || triggerRunId;
    existing.paths = existing.paths || { stateDir, logDir, statePath: resolve(stateDir, 'state.json') };
    existing.configSnapshot = existing.configSnapshot || configSnapshot(input.config);
    return existing;
  }
  return {
    schemaVersion: 1,
    runId: runSlug,
    triggerRunId,
    runState: 'initialized',
    identity,
    paths: {
      stateDir,
      logDir,
      statePath: resolve(stateDir, 'state.json')
    },
    configSnapshot: configSnapshot(input.config),
    config: {
      runner: input.config.defaultRunner,
      maxRounds: input.config.maxRounds,
      pushRemote: input.config.pushRemote
    },
    rounds: [],
    processedCommentIds: [],
    processedReviewIds: [],
    processedInlineCommentIds: []
  };
}

async function reconcileResumeIfNeeded({ input, state, git }) {
  if (!input.resume) return;
  const round = state.rounds.at(-1);
  if (!round || round.state !== 'fixing') return;
  await git.ensureBranch(input.branch);
}

function isInterruptedFixingResume(input, state) {
  return Boolean(input.resume && state.rounds.at(-1)?.state === 'fixing');
}

async function validateGeneratedRootOverride({ name, value, root, worktree, git }) {
  if (!value) return;
  const repoRoot = resolve(worktree);
  const generatedRoot = resolve(root);
  if (isSameOrAncestor(generatedRoot, repoRoot)) {
    fail(`${name} must not resolve to the worktree root or an ancestor: ${value}`, 'UNSAFE_GENERATED_ROOT');
  }
  if (isSameOrAncestor(repoRoot, generatedRoot)) {
    const trackedPaths = await git.trackedPathsUnder(generatedRoot);
    if (trackedPaths.length > 0) {
      fail(`${name} must not contain tracked worktree files: ${value}`, 'UNSAFE_GENERATED_ROOT');
    }
  }
}

function isSameOrAncestor(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

async function runRound({ input, state, store, logger, gh, git, stateDir, logDir }) {
  if (state.pendingLateFindings?.length) {
    const pending = state.pendingLateFindings.shift();
    const round = newRound(state.rounds.length + 1);
    round.state = 'findings_collected';
    round.findings = pending.findings;
    round.findingsFingerprint = pending.fingerprint;
    round.lateFindingsObservedAt = pending.observedAt || null;
    state.rounds.push(round);
    await persistRound({ state, round, store, logger, type: 'late_findings_replayed', payload: { fromRound: pending.fromRound, fingerprint: pending.fingerprint } });
    await handleFindings({ input, state, round, store, logger, gh, git, stateDir, logDir });
    return { done: false, state };
  }

  let round = state.rounds.at(-1);
  if (!round || terminalRoundStates.has(round.state)) {
    round = newRound(state.rounds.length + 1);
    state.rounds.push(round);
  }

  if (round.state === 'fixing') {
    await resumeFixingRound({ input, state, round, store, logger, gh, git, stateDir, logDir });
    return { done: false, state };
  }

  if (!round.trigger || round.state === 'pending_trigger') {
    round = await triggerWithAck({ input, state, round, store, logger, gh });
  }

  round.state = 'awaiting_result';
  await persistRound({ state, round, store, logger, type: 'awaiting_result' });
  const reviewDeadline = deadline(input.config.reviewTimeoutMs);

  while (!expired(reviewDeadline)) {
    round.processedCommentIds = state.processedCommentIds;
    round.processedReviewIds = state.processedReviewIds;
    round.processedInlineCommentIds = state.processedInlineCommentIds;
    const comments = await gh.listIssueComments();
    const clean = findCleanComment(comments, round, input.config.trustedCleanActors);
    if (clean) {
      round.state = 'clean_observed';
      state.runState = 'succeeded';
      state.processedCommentIds.push(String(clean.id));
      await persistRound({ state, round, store, logger, type: 'clean_observed', payload: { commentId: clean.id } });
      return { done: true, state };
    }

    const reviews = await gh.listPullReviews();
    const inlineComments = await gh.listPullReviewComments();
    const findings = collectActionableFindings({
      reviews,
      comments: inlineComments,
      issueComments: comments,
      round,
      trustedActors: input.config.trustedReviewActors
    });
    const settlement = updateSettlement(round, findings);
    round = settlement.round;
    await persistRound({
      state,
      round,
      store,
      logger,
      type: round.state,
      payload: findings ? { fingerprint: findings.fingerprint } : {}
    });
    if (settlement.settled) {
      const latest = await collectLatestFindings({ gh, round, trustedActors: input.config.trustedReviewActors });
      if (latest && latest.fingerprint !== round.findingsFingerprint) {
        round = updateSettlement({ ...round, state: 'findings_settling' }, latest).round;
        await persistRound({ state, round, store, logger, type: 'findings_settling', payload: { fingerprint: latest.fingerprint, reason: 'late_comment_before_runner' } });
        continue;
      }
      await handleFindings({ input, state, round, store, logger, gh, git, stateDir, logDir });
      return { done: false, state };
    }
    await sleep(input.config.pollIntervalMs);
  }

  fail('review timeout reached', 'REVIEW_TIMEOUT');
}

async function triggerWithAck({ input, state, round, store, logger, gh }) {
  const persistedTriggerIntent = round.triggerIntent;
  const canRecoverTrigger = Boolean(input.resume && persistedTriggerIntent?.body);
  const markerRunId = state.triggerRunId || state.runId;
  const marker = round.triggerIntent?.marker || buildTriggerMarker({ runId: markerRunId, round: round.number });
  const triggerBody = round.triggerIntent?.body || buildTriggerBody(input.reviewPrompt, marker);
  const runDeadline = deadline(input.config.reviewTimeoutMs);
  while (!expired(runDeadline)) {
    round.triggerAttempt += 1;
    if (input.config.maxTriggerReposts > 0 && round.triggerAttempt > input.config.maxTriggerReposts + 1) {
      fail(`max trigger reposts reached: ${input.config.maxTriggerReposts}`, 'ACK_TIMEOUT');
    }
    round.triggerIntent = {
      body: triggerBody,
      marker,
      idempotencyKey: `${markerRunId}:round:${round.number}`,
      createdAt: round.triggerIntent?.createdAt || new Date().toISOString()
    };
    await persistRound({ state, round, store, logger, type: 'trigger_intent', payload: { attempt: round.triggerAttempt } });
    let recovered = canRecoverTrigger ? await findExistingTrigger({ gh, triggerBody, marker }) : null;
    let trigger = recovered;
    if (!trigger) {
      try {
        trigger = await gh.createIssueComment(triggerBody);
      } catch (error) {
        if (error.reason !== 'GITHUB_TRANSIENT') throw error;
        await logger.event('trigger_create_transient_failure', {
          round: round.number,
          state: round.state,
          attempt: round.triggerAttempt,
          reason: error.reason
        });
        recovered = await findExistingTrigger({ gh, triggerBody, marker });
        if (recovered) {
          trigger = recovered;
        } else {
          await sleep(remainingPollDelay(input.config.pollIntervalMs, runDeadline));
          continue;
        }
      }
    }
    round.state = 'awaiting_ack';
    round.trigger = {
      id: trigger.id,
      created_at: trigger.created_at,
      body: trigger.body,
      author: trigger.user?.login
    };
    await persistRound({ state, round, store, logger, type: recovered ? 'trigger_recovered' : 'triggered', payload: { triggerId: trigger.id } });
    const ackDeadline = earliestDeadline(runDeadline, deadline(input.config.triggerAckTimeoutMs));
    while (!expired(ackDeadline)) {
      const reactions = await listAckReactionsOrContinue({ gh, logger, round, triggerId: trigger.id });
      if (!reactions) {
        await sleep(remainingPollDelay(input.config.pollIntervalMs, ackDeadline));
        continue;
      }
      const ack = reactions.find((reaction) => isAcknowledgementReaction(reaction, input.config.trustedAckActors));
      if (ack) {
        round.ackReactionIds.push(String(ack.id));
        round.state = 'awaiting_result';
        await persistRound({ state, round, store, logger, type: 'acknowledged', payload: { reactionId: ack.id } });
        return round;
      }
      await sleep(remainingPollDelay(input.config.pollIntervalMs, ackDeadline));
    }
    if (expired(runDeadline)) {
      fail('review timeout reached while waiting for trigger acknowledgement', 'REVIEW_TIMEOUT');
    }
    const reactions = await listAckReactionsUntilKnown({ input, logger, gh, round, triggerId: trigger.id, runDeadline });
    const ack = reactions.find((reaction) => isAcknowledgementReaction(reaction, input.config.trustedAckActors));
    if (ack) {
      round.ackReactionIds.push(String(ack.id));
      round.state = 'awaiting_result';
      await persistRound({ state, round, store, logger, type: 'acknowledged', payload: { reactionId: ack.id } });
      return round;
    }
    const deleted = await gh.deleteIssueComment(trigger.id).then(() => true, () => false);
    if (!deleted) fail('Unable to delete unacknowledged trigger comment', 'ACK_DELETE_FAILED');
    round.deletedUnacknowledgedTriggerIds.push(String(trigger.id));
    await persistRound({ state, round, store, logger, type: 'trigger_deleted', payload: { triggerId: trigger.id } });
  }
  fail('review timeout reached while waiting for trigger acknowledgement', 'REVIEW_TIMEOUT');
}

async function findExistingTrigger({ gh, triggerBody, marker }) {
  const comments = await gh.listIssueComments();
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (String(comment.body || '') === triggerBody || isMarkedReviewTrigger(comment.body, marker)) return comment;
  }
  return null;
}

function isMarkedReviewTrigger(body, marker) {
  const text = String(body || '');
  return Boolean(marker) && text.includes(marker) && text.trimStart().startsWith('@codex review');
}

async function listAckReactionsUntilKnown({ input, logger, gh, round, triggerId, runDeadline }) {
  while (!expired(runDeadline)) {
    const reactions = await listAckReactionsOrContinue({ gh, logger, round, triggerId });
    if (reactions) return reactions;
    await sleep(remainingPollDelay(input.config.pollIntervalMs, runDeadline));
  }
  fail('review timeout reached while waiting for trigger acknowledgement', 'REVIEW_TIMEOUT');
}

async function listAckReactionsOrContinue({ gh, logger, round, triggerId }) {
  try {
    return await gh.listIssueCommentReactions(triggerId);
  } catch (error) {
    if (error.reason !== 'GITHUB_TRANSIENT') throw error;
    await logger.event('ack_poll_transient_failure', {
      round: round.number,
      state: round.state,
      triggerId,
      reason: error.reason
    });
    return null;
  }
}

async function handleFindings({ input, state, round, store, logger, gh, git, stateDir, logDir }) {
  round.state = 'fixing';
  const prBefore = await gh.getPull();
  const localHeadBefore = await git.head();
  const gitControlBefore = await git.gitControlSnapshot();
  round.localHeadBeforeRunner = localHeadBefore;
  round.gitControlBeforeRunner = gitControlBefore;
  round.remoteHeadBeforeRunner = prBefore.head?.sha || null;
  await persistRound({ state, round, store, logger, type: 'fixing' });

  const prompt = buildFixPrompt({
    pr: input.pr,
    branch: input.branch,
    reviewedCommit: round.findings?.reviews?.[0]?.commit_id,
    findings: round.findings,
    stateDir,
    runnerPromptAppend: input.config.runnerPromptAppend
  });
  if (input.config.maxRunnerFailures > 0 && (state.runnerFailures || 0) >= input.config.maxRunnerFailures) {
    fail(`max runner failures reached: ${input.config.maxRunnerFailures}`, 'MAX_RUNNER_FAILURES');
  }
  const result = await runSelectedRunner({
    worktree: input.worktree,
    stateDir,
    prompt,
    config: input.config,
    env: input.env,
    logger
  });

  try {
    await completeFixingRound({ input, state, round, store, logger, gh, git, stateDir, logDir, result });
  } catch (error) {
    if (error.reason === 'RUNNER_FAILED') {
      state.runnerFailures = (state.runnerFailures || 0) + 1;
      if (input.config.maxRunnerFailures > 0 && state.runnerFailures >= input.config.maxRunnerFailures) {
        await store.write(state);
        fail(`max runner failures reached: ${input.config.maxRunnerFailures}`, 'MAX_RUNNER_FAILURES');
      }
      round.state = 'awaiting_result';
      await persistRound({ state, round, store, logger, type: 'runner_failed', payload: { runnerFailures: state.runnerFailures } });
      return;
    }
    throw error;
  }
}

async function resumeFixingRound({ input, state, round, store, logger, gh, git, stateDir, logDir }) {
  const action = await classifyFixingResume({ input, round, git, stateDir, logDir });
  await logger.event('resume_fixing', { round: round.number, action });
  if (action === 'rerun_runner') {
    await handleFindings({ input, state, round, store, logger, gh, git, stateDir, logDir });
    return;
  }
  if (action === 'manual_reconcile') {
    fail('Cannot resume interrupted fixing state: worktree has runner edits but no runner-result.json; manual reconciliation required', 'RESUME_FIXING_RECONCILIATION');
  }
  await completeFixingRound({
    input,
    state,
    round,
    store,
    logger,
    gh,
    git,
    stateDir,
    logDir,
    result: { code: 0, timedOut: false, stdout: '', stderr: '' },
    resumed: true
  });
}

async function classifyFixingResume({ input, round, git, stateDir, logDir }) {
  await git.ensureBranch(input.branch);
  const currentHead = await git.head();
  const hasChanges = await git.hasChangesOutside([stateDir, logDir]);
  const hasRunnerResult = await fileExists(resolve(stateDir, 'runner-result.json'));
  if (round.localHeadBeforeRunner && currentHead !== round.localHeadBeforeRunner) return 'complete_existing_head';
  if (hasChanges && hasRunnerResult) return 'complete_existing_diff';
  if (hasChanges && !hasRunnerResult) return 'manual_reconcile';
  if (hasRunnerResult) return 'complete_existing_result';
  return 'rerun_runner';
}

async function completeFixingRound({ input, state, round, store, logger, gh, git, stateDir, logDir, result, resumed = false }) {
  await git.ensureBranch(input.branch);
  if (round.gitControlBeforeRunner) await git.assertGitControlUnchanged(round.gitControlBeforeRunner);
  const localHeadBeforeRunner = round.localHeadBeforeRunner || await git.head();
  const localHeadAfterRunner = await git.head();
  await git.unstageGeneratedPaths([stateDir, logDir]);
  await git.ensureGeneratedPathsUnstaged([stateDir, logDir]);
  const hasChanges = await git.hasChangesOutside([stateDir, logDir]);
  const runnerCommitted = localHeadAfterRunner !== localHeadBeforeRunner;
  const runnerResult = await readRunnerResult(stateDir);
  classifyRunnerOutcome({ result, runnerResult, hasChanges, runnerCommitted });
  if (runnerCommitted) {
    await completeCommittedFix({ input, state, round, store, logger, gh, git, localHeadAfterRunner, resumed });
    return;
  }
  const prAfterRunner = await gh.getPull();
  if (round.remoteHeadBeforeRunner && prAfterRunner.head?.sha && prAfterRunner.head.sha !== round.remoteHeadBeforeRunner) {
    fail('Remote PR head drifted before push', 'REMOTE_HEAD_DRIFT');
  }

  let commitSha = localHeadAfterRunner;
  if (hasChanges) {
    round.toolCommitIntent = buildToolCommitIntent({ state, round });
    await persistRound({
      state,
      round,
      store,
      logger,
      type: 'tool_commit_intent',
      payload: {
        subject: round.toolCommitIntent.subject,
        baseHead: round.toolCommitIntent.baseHead
      }
    });
    commitSha = await git.commitAll(buildToolCommitMessage(round.toolCommitIntent), [stateDir, logDir]);
  }
  const pushResult = await git.push(input.config.pushRemote, input.branch);
  round.state = 'pushed';
  round.localHeadAfterRunner = localHeadAfterRunner;
  round.toolCommitSha = commitSha;
  round.pushResult = pushResult.stdout.trim() || pushResult.stderr.trim();
  round.resumedFixing = resumed || undefined;
  markProcessed(state, round);
  await persistLateFindings({ state, round, gh, trustedActors: input.config.trustedReviewActors });
  await persistRound({ state, round, store, logger, type: 'pushed', payload: { commitSha } });
}

async function completeCommittedFix({ input, state, round, store, logger, gh, git, localHeadAfterRunner, resumed }) {
  const subject = await git.commitSubject(localHeadAfterRunner);
  const expectedSubject = buildToolCommitSubject(round);
  if (!input.config.allowRunnerCommit && resumed) {
    const isExpectedToolCommit = await hasExpectedToolCommitProvenance({ git, state, round, ref: localHeadAfterRunner, subject, expectedSubject });
    if (!isExpectedToolCommit) {
      fail('Cannot resume interrupted fixing state: local head changed during runner attempt', 'RESUME_LOCAL_HEAD_DRIFT');
    }
  }
  if (!input.config.allowRunnerCommit && !resumed) {
    fail('Runner created a commit; this is forbidden by default', 'RUNNER_COMMIT_FORBIDDEN');
  }
  const prAfterRunner = await gh.getPull();
  if (prAfterRunner.head?.sha && prAfterRunner.head.sha !== round.remoteHeadBeforeRunner && prAfterRunner.head.sha !== localHeadAfterRunner) {
    fail('Remote PR head drifted before push', 'REMOTE_HEAD_DRIFT');
  }
  let pushResult = { stdout: '', stderr: 'already pushed' };
  if (prAfterRunner.head?.sha !== localHeadAfterRunner) {
    pushResult = await git.push(input.config.pushRemote, input.branch);
  }
  round.state = 'pushed';
  round.localHeadAfterRunner = localHeadAfterRunner;
  round.toolCommitSha = localHeadAfterRunner;
  round.pushResult = pushResult.stdout.trim() || pushResult.stderr.trim();
  round.resumedFixing = true;
  markProcessed(state, round);
  await persistLateFindings({ state, round, gh, trustedActors: input.config.trustedReviewActors });
  await persistRound({ state, round, store, logger, type: 'pushed', payload: { commitSha: localHeadAfterRunner, resumed: true } });
}

async function collectLatestFindings({ gh, round, trustedActors }) {
  const issueComments = await gh.listIssueComments();
  const reviews = await gh.listPullReviews();
  const inlineComments = await gh.listPullReviewComments();
  return collectActionableFindings({ reviews, comments: inlineComments, issueComments, round, trustedActors });
}

async function persistLateFindings({ state, round, gh, trustedActors }) {
  const reviews = await gh.listPullReviews();
  const comments = await gh.listPullReviewComments();
  const latest = collectLateFindings({
    round,
    reviews,
    comments,
    trustedActors,
    processedReviewIds: state.processedReviewIds,
    processedInlineCommentIds: state.processedInlineCommentIds
  });
  if (!latest) return;
  state.pendingLateFindings = state.pendingLateFindings || [];
  state.pendingLateFindings.push({
    fromRound: round.number,
    fingerprint: latest.fingerprint,
    findings: latest,
    observedAt: new Date().toISOString(),
    reviewIds: latest.reviews.map((review) => String(review.id)),
    commentIds: latest.comments.map((comment) => String(comment.id))
  });
}

export function collectLateFindings({ round, reviews, comments, trustedActors, processedReviewIds, processedInlineCommentIds }) {
  const lowerBound = round.trigger?.created_at || round.lateFindingsObservedAt || null;

  const processedReviews = new Set(processedReviewIds || []);
  const processedComments = new Set(processedInlineCommentIds || []);
  const currentReviews = (round.findings?.reviews || []).filter((review) => isActionableReviewState(review.state));
  const currentReviewIds = new Set(currentReviews.map((review) => String(review.id)));
  const lateReviews = reviews.filter((review) => {
    if (!review.submitted_at) return false;
    if (!isActionableReviewState(review.state)) return false;
    if (!trustedActors.includes(review?.user?.login)) return false;
    if (lowerBound && !isAtOrAfter(review.submitted_at, lowerBound)) return false;
    if (processedReviews.has(String(review.id))) return false;
    return true;
  });
  const lateReviewIds = new Set(lateReviews.map((review) => String(review.id)));
  const lateReviewCommitIds = new Set(lateReviews.map((review) => String(review.commit_id || '')).filter(Boolean));
  const lateComments = comments.filter((comment) => {
    if (processedComments.has(String(comment.id))) return false;
    if (!trustedActors.includes(comment?.user?.login)) return false;
    if (lowerBound && !isAtOrAfter(comment.created_at || comment.updated_at, lowerBound)) return false;
    const linkedReviewId = String(comment.pull_request_review_id || '');
    if (currentReviewIds.has(linkedReviewId) || lateReviewIds.has(linkedReviewId)) return true;
    if (!comment.pull_request_review_id && lateReviewCommitIds.has(String(comment.commit_id || ''))) return true;
    return false;
  });
  const lateCommentReviewIds = new Set(lateComments.map((comment) => String(comment.pull_request_review_id || '')).filter(Boolean));
  const replayedCurrentReviews = currentReviews.filter((review) => lateCommentReviewIds.has(String(review.id)));
  const replayedReviews = dedupeReviews([...replayedCurrentReviews, ...lateReviews]);
  if (replayedReviews.length === 0) return null;
  return {
    reviews: replayedReviews,
    comments: lateComments,
    fingerprint: fingerprintFindings({ reviews: replayedReviews, comments: lateComments })
  };
}

function dedupeReviews(reviews) {
  const seen = new Set();
  return reviews.filter((review) => {
    const id = String(review.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function markProcessed(state, round) {
  for (const review of round.findings?.reviews || []) state.processedReviewIds.push(String(review.id));
  for (const comment of round.findings?.comments || []) state.processedInlineCommentIds.push(String(comment.id));
  state.processedReviewIds = [...new Set(state.processedReviewIds)];
  state.processedInlineCommentIds = [...new Set(state.processedInlineCommentIds)];
}

function newRound(number) {
  return {
    number,
    state: 'pending_trigger',
    triggerAttempt: 0,
    trigger: null,
    ackReactionIds: [],
    deletedUnacknowledgedTriggerIds: [],
    findingsFingerprint: null,
    findings: null,
    processedReviewIds: [],
    processedInlineCommentIds: []
  };
}

async function persistRound({ state, round, store, logger, type, payload = {} }) {
  state.rounds[state.rounds.length - 1] = round;
  await store.write(state);
  await logger.event(type, { round: round.number, state: round.state, ...payload });
}

function validatePrMeta(prMeta, branch) {
  if (!prMeta) fail('Unable to read PR metadata', 'PR_NOT_FOUND');
  if (prMeta.state && prMeta.state !== 'open') fail(`PR is not open: ${prMeta.state}`, 'PR_NOT_OPEN');
  if (prMeta.merged) fail('PR is already merged', 'PR_NOT_OPEN');
  const headBranch = prMeta.head?.ref;
  if (headBranch && headBranch !== branch) fail(`PR head branch ${headBranch} does not match --branch ${branch}`, 'PR_BRANCH_MISMATCH');
}

function deadline(ms) {
  return ms > 0 ? Date.now() + ms : Number.POSITIVE_INFINITY;
}

function earliestDeadline(...values) {
  return Math.min(...values);
}

function expired(deadlineValue) {
  return Date.now() >= deadlineValue;
}

function remainingPollDelay(pollIntervalMs, deadlineValue) {
  if (!Number.isFinite(deadlineValue)) return pollIntervalMs;
  return Math.max(0, Math.min(pollIntervalMs, deadlineValue - Date.now()));
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const terminalRoundStates = new Set(['clean_observed', 'pushed', 'failed']);

async function fileExists(path) {
  return import('node:fs').then(({ existsSync }) => existsSync(path));
}
