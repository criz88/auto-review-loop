# Examples

These examples show command shapes and reporting patterns. Always compare them with current `--help` output before use.

## Local Development Verification

```bash
node --version
npm run check
npm test
npm run verify
```

Report:

```text
Verified the local CLI with npm run verify. It ran syntax checks, the Node test suite, and CLI help successfully. No live GitHub review was triggered.
```

## Inspect Current CLI Help

```bash
node bin/prloop.mjs --help
```

Use this before constructing a live command. If global installation is configured, `prloop --help` should print equivalent usage.

## Live Run with Explicit State and Log Directories

```bash
node bin/prloop.mjs run \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --state-dir /tmp/prloop-state \
  --log-dir /tmp/prloop-logs \
  --trusted-review-actor 'chatgpt-codex-connector[bot]' \
  --trusted-clean-actor 'chatgpt-codex-connector[bot]' \
  --trusted-ack-actor 'chatgpt-codex-connector[bot]' \
  --review-timeout 30m
```

After the run:

```bash
find /tmp/prloop-state -maxdepth 3 -type f -print
find /tmp/prloop-logs -maxdepth 2 -type f -print
git -C /path/to/worktree status --short
```

## Resume an Interrupted Run

Inspect first when `status --json` exists:

```bash
node bin/prloop.mjs status \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --json
```

Use the JSON fields for the next action:

```text
run.state=active
run.phase=fixing
run.resumable=true
run.recommendedAction=commit_existing_diff
lock.active=false
failure.reason=null
```

Then resume with the first-class command when available:

```bash
node bin/prloop.mjs resume \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --trusted-review-actor 'chatgpt-codex-connector[bot]' \
  --trusted-clean-actor 'chatgpt-codex-connector[bot]' \
  --trusted-ack-actor 'chatgpt-codex-connector[bot]'
```

If current `--help` does not list `resume`, use the older flag form:

```bash
node bin/prloop.mjs run \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --resume \
  --trusted-review-actor 'chatgpt-codex-connector[bot]' \
  --trusted-clean-actor 'chatgpt-codex-connector[bot]' \
  --trusted-ack-actor 'chatgpt-codex-connector[bot]'
```

Resume only when the stored identity matches the same PR, worktree, and branch.

## Session Recovery Report

```text
I inspected status with `status --json`. The run is active in phase `awaiting_result`, the lock is not active, and the recommended action is `wait_for_review`. I did not post another trigger or run a local repair. Next step is to resume or wait according to the scheduler policy.
```

If the command failed with structured JSON stderr:

```text
The command failed with reason `DIRTY_WORKTREE`, exitCode 3, resumable=true. I inspected the worktree and did not run resume because local changes need classification first.
```

## Review Artifact Summary

Use a concise report structure:

```text
Commands run:
- node bin/prloop.mjs run ...
- git -C /path/to/worktree status --short

Artifacts inspected:
- /path/to/worktree/.git/cloud-review-loop/state/.../state.json
- /path/to/worktree/.git/cloud-review-loop/logs/2026-04-29.ndjson
- GitHub PR review IDs 123456 and 123457

Outcome:
- Round 1 found trusted review findings and produced commit abc1234.
- Round 2 received a trusted clean result from chatgpt-codex-connector[bot].

Verification:
- Worktree clean after push.
- Latest PR head matched the pushed repair commit.

Remaining risks:
- Live service timing is external; rerun may observe different timing, but this run's artifacts support completion.
```

## Inconclusive Result Summary

```text
I cannot verify a successful cloud review. The CLI posted a trigger and received acknowledgement, but the state file records REVIEW_TIMEOUT before any trusted clean result or actionable findings. I inspected the log at ... and the state at .... Remaining blocker: no post-trigger trusted review artifact was available.
```

## Failure Summary

```text
The run failed during local repair. The state file records RUNNER_FAILED in round 1, and runner-result.json reports status=failed with summary "...". I did not claim review completion. Next step is to fix the runner failure in the target worktree and resume only if the stored PR/worktree/branch identity matches.
```
