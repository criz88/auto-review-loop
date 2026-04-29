# prloop

Local CLI for running a Codex cloud-review repair loop on an existing GitHub PR.

The tool posts `@codex review`, waits for a trusted `eyes` acknowledgement on that trigger comment, polls for trusted Codex clean or finding events, runs a fresh local repair runner when findings settle, commits and pushes the repair itself, then repeats until Codex reports:

```text
Codex Review: Didn't find any major issues.
```

## Usage

```bash
prloop run \
  --pr https://github.com/OWNER/REPO/pull/123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --trusted-review-actor codex-bot \
  --trusted-clean-actor codex-bot \
  --trusted-ack-actor codex-bot
```

Optional one-off review focus:

```bash
prloop run \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --review-prompt "for security regressions" \
  --trusted-review-actor codex-bot \
  --trusted-clean-actor codex-bot \
  --trusted-ack-actor codex-bot
```

## Config

Configuration is JSON only. Precedence is CLI flags, then `--config`, then `.cloud-review-loop.json`, then shipped defaults.

```json
{
  "defaultRunner": "codex",
  "pollInterval": "30s",
  "maxRounds": 0,
  "reviewTimeout": "0",
  "runnerTimeout": "0",
  "maxRunnerFailures": 0,
  "pushRemote": "origin",
  "trustedReviewActors": [],
  "trustedCleanActors": [],
  "trustedAckActors": [],
  "triggerAckTimeout": "60s",
  "maxTriggerReposts": 0,
  "allowRunnerCommit": false,
  "unsafeAllowBypassApprovals": false
}
```

Live runs fail closed unless all three trusted actor lists are non-empty.

## Safety Model

- The runner edits only; the tool owns commit and push.
- External commands use argv arrays with `shell:false`.
- Review bodies and inline comments are passed to the runner as untrusted data.
- Claude runner execution is macOS-only in v1 and is wrapped with `sandbox-exec`; the profile intentionally does not grant general home-directory reads or network access. The current test suite validates this profile shape, not live compatibility with real Claude Code installations that require broader local reads or network access.
- Runner commits are rejected unless `allowRunnerCommit` is explicitly enabled.
- Runner pushes are rejected by checking PR head drift before the tool pushes.
- Default state and logs are written under git metadata via `git rev-parse --git-path cloud-review-loop/...`.
- `--help` is side-effect free.

## Verification

```bash
npm run check
npm test
npm run verify
```

The default test suite uses fake `gh` and runner binaries and does not call live GitHub, Codex, Claude, or network services. Real Claude Code execution under the v1 sandbox is a separate compatibility target, not a property proven by `npm run verify`.
