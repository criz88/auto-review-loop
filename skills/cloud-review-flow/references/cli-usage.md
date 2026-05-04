# CLI Usage Reference

The CLI is named `prloop`. Prefer the installed command when available, or use `npx prloop@latest` when the CLI is not installed globally. When working inside a source checkout, agents should rediscover the entrypoint because command names and flags can change.

## Discover the Entrypoint

For npm-distributed usage, run side-effect-free help first:

```bash
prloop --help
npx prloop@latest --help
```

For source checkout development, run read-only inspection first:

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

Use the command shape printed by current `--help`. At the time this skill was written, the npm CLI supports:

```bash
prloop run \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --trusted-review-actor 'chatgpt-codex-connector[bot]' \
  --trusted-clean-actor 'chatgpt-codex-connector[bot]' \
  --trusted-ack-actor 'chatgpt-codex-connector[bot]'
```

If `prloop` is not installed globally, use `npx prloop@latest run ...`. When operating from a source checkout, `node bin/prloop.mjs run ...` is also valid.

Use `--repo OWNER/REPO --pr 123` when the PR is numeric. Use `--review-prompt "<focus>"` for a one-off review focus. Use `--resume` only when resuming state for the same PR, worktree, and branch identity.

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

- `state.json` records run identity, round state, findings, failures, and completion markers.
- `lock.json` indicates an active or interrupted run.
- `*.ndjson` logs record timestamped redacted events.
- `runner-result.json` records local runner status, summary, tests, and no-op reasons when produced.

## Completion Evidence

Treat the run as successful only when evidence shows a trusted clean result or completed clean state. Useful evidence includes:

- A trusted clean review/comment observed through GitHub.
- State rounds ending in a clean terminal condition.
- Logs showing trigger, acknowledgement, polling, repairs, pushes, and final clean result.
- `git status --short` showing no unexpected local changes after the run.

If evidence is incomplete, report the run as inconclusive and list the missing artifacts.
