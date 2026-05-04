# Troubleshooting Reference

Use stderr, state JSON, lock files, logs, and PR evidence together. Do not diagnose from one line of output when artifacts are available.

When `status --json` is available, run it before mutating anything. It is side-effect free and summarizes the run for a new agent session:

```bash
node bin/prloop.mjs status \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --json
```

Use these fields first:

- `run.recommendedAction`
- `run.resumable`
- `lock.active`
- `failure.reason`
- `latestRound.state`

## Usage or Configuration Errors

Symptoms:

- `Unknown command`
- `Unknown option`
- required flag errors
- invalid JSON config
- missing trusted actor errors

Actions:

```bash
node bin/prloop.mjs --help
cat package.json
cat .cloud-review-loop.json
```

Fix the invocation to match current help output. Validate JSON before rerunning. Ensure trusted review, clean, and acknowledgement actor arrays are non-empty for live runs.

## GitHub or Authentication Failures

Symptoms:

- `gh` command failures
- transport errors that do not recover
- missing PR data
- authorization errors

Actions:

```bash
gh auth status
gh pr view <pr> --json number,url,headRefName,headRefOid
gh api repos/OWNER/REPO/pulls/NUMBER
```

Confirm the authenticated account can read and comment on the PR. Retry transient network failures only after checking logs for built-in retries and backoff.

## Trigger Acknowledgement Timeout

Symptoms:

- timeout while waiting for trigger acknowledgement
- repeated trigger comments
- no `eyes` reaction from the trusted acknowledgement actor

Actions:

- Inspect the PR conversation for the exact trigger comment.
- Confirm Codex/cloud review is enabled for the repository.
- Confirm the trusted acknowledgement actor login matches the observed GitHub actor.
- Consider a longer `--trigger-ack-timeout` or `--review-timeout` when the service is slow.

Do not mark the run successful just because the trigger comment exists.

## Review Timeout

Symptoms:

- `review timeout reached`
- no trusted clean result
- no actionable trusted findings

Actions:

- Inspect PR reviews, issue comments, and inline comments created after the trigger.
- Verify trusted actor lists match the actual actor logins.
- Check whether the review was posted on a different commit or before the trigger time.
- Increase `--review-timeout` only when the external review is known to be slow.

## Runner Failures

Symptoms:

- local runner exits non-zero
- `RUNNER_FAILED`
- invalid or missing `runner-result.json`
- no fix produced

Actions:

- Inspect the round state and runner result file.
- Read runner stdout/stderr in NDJSON logs.
- Run the repository's relevant tests manually in the target worktree.
- Confirm the selected runner CLI is installed and authenticated.

If the runner made no changes, report the no-op reason and verify whether the finding was already addressed.

## Dirty Worktree or Commit Safety Failures

Symptoms:

- worktree not clean
- unexpected runner commit
- PR head drift before push
- push rejected

Actions:

```bash
git status --short
git branch --show-current
git log --oneline --decorate -5
gh pr view <pr> --json headRefOid,headRefName
```

Preserve user changes. Do not reset, rebase, force-push, or delete branches unless explicitly instructed. If the PR head moved remotely, stop and report the drift with the local and remote SHAs.

## Active Lock

Symptoms:

- `Active cloud-review-loop lock exists`
- interrupted process left `lock.json`

Actions:

- Inspect the lock payload for PID, timestamp, PR, worktree, and branch.
- Inspect `lastSeenAt` when present; it is heartbeat data from the process that owns the lock.
- Check whether the process is still running.
- Use `resume` or `run --resume` only for the same PR, worktree, and branch identity.
- Remove a stale lock only when you have evidence no process is active and the user has authorized cleanup.

## Session Recovery

Symptoms:

- a previous agent session ended while `prloop` was running
- the local process was interrupted
- state exists but the current human or agent does not know which phase is safe to continue

Actions:

1. Run `status --json` when available.
2. If `lock.active=true`, wait or inspect the owning PID before doing anything else.
3. If `run.recommendedAction=wait_for_review`, do not post another trigger; the review may already be in flight.
4. If `run.recommendedAction=commit_existing_diff` or `retry_push`, prefer `resume` over manual git commands.
5. If `run.recommendedAction=manual_reconcile`, stop and report the exact missing evidence, such as runner edits without `runner-result.json`.

`resume` is intended to reconcile external side effects. It may recover an already-posted trigger comment, continue from existing runner output, retry a push, or re-run the runner only when there is no existing proof of runner completion.

## Artifact Interpretation

When reading NDJSON logs:

- Parse one JSON object per line.
- Prefer event type, timestamp, reason, and redacted message fields over free-form assumptions.
- Treat secrets as redacted and do not ask users to reveal tokens.

When reading `state.json`:

- Match identity against the current PR, worktree, and branch.
- Inspect every round state.
- Check `failure` before claiming completion.
- Cross-check findings with PR review/comment IDs when possible.

When reading structured stderr from `--json` commands:

- Parse `kind=prloop.error`.
- Use `reason`, `retryable`, and `resumable` for automation decisions.
- Treat `message` as human-readable context, not as a stable machine contract.
