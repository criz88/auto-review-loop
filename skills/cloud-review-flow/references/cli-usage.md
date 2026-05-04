# CLI Usage Reference

This repository currently exposes a Node.js CLI named `prloop`, but agents should rediscover the entrypoint each time because command names and flags can change.

## Discover the Entrypoint

Run read-only inspection first:

```bash
cat package.json
ls bin
sed -n '1,220p' README.md
node bin/prloop.mjs --help
```

Look for:

- `package.json` `bin` entries.
- `scripts` such as `check`, `test`, and `verify`.
- CLI usage text in `src/cli.*` or `bin/*`.
- README sections for requirements, trust model, state/log paths, and limitations.

## Prerequisite Checks

For source checkout development:

```bash
node --version
npm --version
npm run check
npm test
node bin/prloop.mjs --help
```

For a live review-loop run against a PR worktree:

```bash
git status --short
git branch --show-current
gh auth status
gh pr view <pr> --json number,headRefName,headRepositoryOwner,headRepository,url
```

Confirm all of the following before a live run:

- Node.js satisfies the repository engine requirement.
- `git` and `gh` are on `PATH`.
- `gh` is authenticated for the target repository.
- The target PR already exists.
- The target worktree is on the requested branch.
- Trusted review, clean, and acknowledgement actor logins are known from observed GitHub review behavior.
- The selected local repair runner is installed and authenticated.

## Normal Review Flow

Use the command shape printed by current `--help`. At the time this skill was written, the source checkout supports:

```bash
node bin/prloop.mjs run \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --trusted-review-actor 'chatgpt-codex-connector[bot]' \
  --trusted-clean-actor 'chatgpt-codex-connector[bot]' \
  --trusted-ack-actor 'chatgpt-codex-connector[bot]'
```

Use `--repo OWNER/REPO --pr 123` when the PR is numeric. Use `--review-prompt "<focus>"` for a one-off review focus. Use `--resume` only when resuming state for the same PR, worktree, and branch identity.

For scheduler, long-running tasks, and new agent sessions recovering prior context, prefer the first-class resume and status commands when present in current `--help`:

```bash
node bin/prloop.mjs status \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --json

node bin/prloop.mjs resume \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch
```

`status --json` is read-only. Use `run.recommendedAction`, `run.resumable`, `failure.reason`, and `lock.active` for recovery decisions instead of parsing human stderr.

Treat `resume` as an idempotent reconcile step, not as a blind rerun. It may continue existing runner edits, retry a push, recover an already-posted review trigger, wait for an in-flight review, or fail with a manual reconciliation reason when completion cannot be proven.

## Configuration

The CLI reads JSON configuration. Current precedence is:

1. CLI flags.
2. `--config <path>`.
3. `.cloud-review-loop.json` in the invocation directory.
4. shipped defaults.

Before relying on a config file, inspect it and confirm trusted actor arrays are set:

```bash
cat .cloud-review-loop.json
```

## State and Logs

By default, generated state and logs live under the target repository's git metadata:

```text
$(git rev-parse --git-path cloud-review-loop/state)
$(git rev-parse --git-path cloud-review-loop/logs)
```

When `--state-dir` or `--log-dir` is provided, inspect those explicit paths instead. Do not place generated roots at the worktree root, an ancestor of it, or a directory containing tracked files.

Expected artifact types:

- `state.json` records run identity, runId, timestamps, config snapshot, round state, findings, failures, and completion markers.
- `lock.json` indicates an active or interrupted run and includes `lastSeenAt` heartbeat data while the process owns the lock.
- `*.ndjson` logs record timestamped redacted events.
- `runner-result.json` records local runner status, summary, tests, and no-op reasons when produced.

## Completion Evidence

Treat the run as successful only when evidence shows a trusted clean result or completed clean state. Useful evidence includes:

- A trusted clean review/comment observed through GitHub.
- State rounds ending in a clean terminal condition.
- Logs showing trigger, acknowledgement, polling, repairs, pushes, and final clean result.
- `git status --short` showing no unexpected local changes after the run.

If evidence is incomplete, report the run as inconclusive and list the missing artifacts.
