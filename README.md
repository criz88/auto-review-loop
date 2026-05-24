# prloop

`prloop` is a local CLI that keeps a GitHub pull request in a Codex review and repair loop.

It posts `@codex review`, waits for Codex to acknowledge the trigger with an `eyes` reaction, polls GitHub for trusted Codex review findings or a trusted clean result, runs a local repair runner when findings settle, commits and pushes the local repair, then repeats until Codex reports:

```text
Codex Review: Didn't find any major issues.
```

The tool is intentionally local-first. It is not a GitHub Action, webhook service, daemon, or hosted bot. You run it against an existing PR and an existing local worktree.

## Status

This is an early safety-focused CLI for automating the narrow loop around Codex GitHub code review.

Before using it on an important branch, read the trust model below and run it first on a disposable PR. Live runs create PR comments, run a local coding agent, create commits, and push to the configured remote.

## How Codex Review Works

Codex's GitHub integration supports PR code review directly in GitHub. The official flow is:

1. Set up Codex cloud and connect GitHub.
2. Enable Code review for the repository in Codex settings.
3. Add a PR comment containing `@codex review`.
4. Wait for Codex to react with `eyes` and post a normal GitHub code review.

Codex also supports repository review guidance through `AGENTS.md`. It searches the repository for `AGENTS.md` files and applies the closest matching guidance to each changed file. A one-off review focus can be appended to the PR comment, for example:

```text
@codex review for security regressions
```

In GitHub, Codex review flags only P0 and P1 issues by default. If you want Codex to treat something else as review-worthy, add that guidance to `AGENTS.md`.

Codex can also be configured to review every PR automatically in Codex settings, but `prloop` uses the explicit comment-triggered flow so it can correlate each round with the trigger comment it posted.

Official references:

- [Use Codex in GitHub](https://developers.openai.com/codex/integrations/github)
- [Codex web setup](https://developers.openai.com/codex/cloud)

## What prloop Does

For each round, `prloop`:

1. Reuses retained trusted clean evidence when the current PR head is unchanged.
2. Posts a fresh `@codex review` comment on the PR when review evidence is not already current.
3. Waits for a trusted actor to acknowledge that trigger with an `eyes` reaction.
4. Polls issue comments, pull request reviews, and pull request review comments through `gh api`.
5. Accepts only trusted, post-trigger Codex findings or clean results.
6. Runs a fresh local repair runner in the target worktree.
7. Rejects unexpected runner commits by default.
8. Checks for PR head drift before pushing.
9. Creates and pushes the repair commit itself.
10. Repeats until a trusted clean result is observed.

If a previous run already ended with trusted clean evidence for the same PR, worktree, branch, and current head, `prloop run` records `retained_clean` and exits without posting another trigger.

## Requirements

Required:

- Node.js 20 or newer.
- `git` available on `PATH`.
- GitHub CLI `gh` available on `PATH` and authenticated for the target repository.
- A local checkout/worktree of the PR branch.
- Codex GitHub code review enabled for the repository.
- The actual GitHub login for the trusted Codex review actor, clean actor, and acknowledgement actor.

Runner requirements:

- `--runner codex` requires the `codex` CLI on `PATH` and authenticated for local non-interactive use.
- `--runner claude` requires the `claude` CLI on `PATH`, macOS, and `/usr/bin/sandbox-exec`. The Claude adapter is experimental in v1.

## Install

### CLI

Install the CLI globally with npm:

```bash
npm install -g @criz88/prloop
prloop --help
```

Run it without a global install:

```bash
npx @criz88/prloop@latest --help
```

For a project-pinned install, add it to the target repository:

```bash
npm install --save-dev @criz88/prloop
npx prloop --help
```

### Agent Skill

This repository includes an Agent Skills-compatible skill for coding agents that need to run, debug, verify, or summarize the `prloop` workflow. The canonical source lives in `skills/cloud-review-flow`.

Install the skill with skills.sh:

```bash
# Project-level install from the target repository
npx skills add criz88/auto-review-loop --skill cloud-review-flow

# User-level/global install
npx skills add criz88/auto-review-loop --skill cloud-review-flow -g

# Install for every supported agent
npx skills add criz88/auto-review-loop --skill cloud-review-flow --agent '*'
```

Update or remove the skill through skills.sh:

```bash
npx skills update cloud-review-flow
npx skills remove cloud-review-flow
```

The skill and CLI are distributed separately: skills.sh installs the agent guidance, and npm/npx provides the `prloop` executable used by that guidance.

### From Source

For local development, clone the repository and link the CLI:

```bash
git clone https://github.com/criz88/auto-review-loop.git
cd auto-review-loop
npm link
prloop --help
```

If you do not want to install a global link, run it directly:

```bash
node /path/to/prloop/bin/prloop.mjs --help
```

This package has no runtime npm dependencies. `npm install` is only needed if your local npm workflow requires it for linking, packaging, or lockfile generation.

### Maintainer Publishing

Publishing is handled by GitHub Actions when a GitHub release is published. Before the first release:

1. Create an npm account with publish access to the `@criz88/prloop` package.
2. Create an npm automation token.
3. Add the token to the GitHub repository as the `NPM_TOKEN` secret.
4. Ensure `package.json` has the intended version.
5. Publish a GitHub release, for example `v0.1.0`.

The workflow runs `npm ci`, then `npm publish --provenance --access public`; npm runs `prepublishOnly` first, which executes `npm run verify`.

### Project Readiness Checklist

In the repository you want `prloop` to operate on:

```bash
gh auth status
git status --short
git branch --show-current
```

Then verify that Codex review works manually on a test PR:

```text
@codex review
```

Look at the resulting review comment, clean comment, and `eyes` reaction in GitHub. Use the GitHub actor login you observe there for `trustedReviewActors`, `trustedCleanActors`, and `trustedAckActors`.

## Quickstart

Run against an existing PR branch:

```bash
prloop run \
  --pr https://github.com/OWNER/REPO/pull/123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --trusted-review-actor 'chatgpt-codex-connector[bot]' \
  --trusted-clean-actor 'chatgpt-codex-connector[bot]' \
  --trusted-ack-actor 'chatgpt-codex-connector[bot]'
```

Add a one-off review focus:

```bash
prloop run \
  --pr OWNER/REPO#123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --review-prompt "for security regressions" \
  --trusted-review-actor 'chatgpt-codex-connector[bot]' \
  --trusted-clean-actor 'chatgpt-codex-connector[bot]' \
  --trusted-ack-actor 'chatgpt-codex-connector[bot]'
```

Use a numeric PR with an explicit repository:

```bash
prloop run \
  --repo OWNER/REPO \
  --pr 123 \
  --worktree /path/to/worktree \
  --branch feature/my-branch \
  --trusted-review-actor 'chatgpt-codex-connector[bot]' \
  --trusted-clean-actor 'chatgpt-codex-connector[bot]' \
  --trusted-ack-actor 'chatgpt-codex-connector[bot]'
```

## Configuration

Configuration is JSON only. Precedence is:

1. CLI flags.
2. `--config <path>`.
3. `.cloud-review-loop.json` in the invocation directory.
4. Shipped defaults.

Example `.cloud-review-loop.json`:

```json
{
  "defaultRunner": "codex",
  "pollInterval": "30s",
  "maxRounds": 0,
  "reviewTimeout": "0",
  "runnerTimeout": "0",
  "maxRunnerFailures": 0,
  "pushRemote": "origin",
  "trustedReviewActors": ["chatgpt-codex-connector[bot]"],
  "trustedCleanActors": ["chatgpt-codex-connector[bot]"],
  "trustedAckActors": ["chatgpt-codex-connector[bot]"],
  "triggerAckTimeout": "60s",
  "maxTriggerReposts": 0,
  "allowRunnerCommit": false,
  "unsafeAllowBypassApprovals": false,
  "runnerPromptAppend": "Before reporting success, run the repository required validation and include the command in runner-result.json tests."
}
```

`0` means unlimited for supported bounds. Live runs fail closed unless all three trusted actor lists are non-empty.

Use `runnerPromptAppend` for project-specific runner instructions, such as required validation commands or local workflow rules. The text is appended to the built-in repair prompt; it does not replace the default safety rules.

## CLI Reference

```text
prloop run --pr <url|owner/repo#number|number> --worktree <path> --branch <name> [options]
prloop resume --pr <url|owner/repo#number|number> --worktree <path> --branch <name> [options]
prloop status (--state <path>|--pr <ref> --worktree <path> --branch <name>) [--json]
prloop --help
```

Options:

```text
--repo <owner/repo>                 Required when --pr is numeric
--runner <codex|claude>             Runner override
--review-prompt <text>              Appended to "@codex review"
--config <path>                     JSON config path
--max-rounds <n>                    0 means unlimited
--review-timeout <duration>         0 means unlimited
--runner-timeout <duration>         0 means unlimited
--max-runner-failures <n>           0 means unlimited
--poll-interval <duration>          Default 30s
--push-remote <name>                Default origin
--resume                            Resume persisted state
--json                              Emit machine-readable JSON
--state <path>                      Read a state.json file or state directory for status
--state-dir <path>                  Override state directory
--log-dir <path>                    Override log directory
--trusted-review-actor <login>      Repeatable
--trusted-clean-actor <login>       Repeatable
--trusted-ack-actor <login>         Repeatable
--trigger-ack-timeout <duration>    Default 60s
--max-trigger-reposts <n>           0 means unlimited
```

Durations support `s`, `m`, and `h`, for example `30s`, `10m`, or `2h`.

## Trust and Safety Model

- The trusted actor lists are mandatory for live runs.
- Review bodies and inline comments are treated as untrusted data.
- External commands are launched with argv arrays and `shell:false`.
- The runner edits the worktree, but `prloop` owns commit creation and push.
- Runner-created commits are rejected unless `allowRunnerCommit` is explicitly enabled.
- Runner pushes are rejected indirectly by checking PR head drift before `prloop` pushes.
- The worktree must be on the requested branch.
- The local worktree must be clean outside allowed generated state/log paths.
- Default state and logs are written under git metadata via `git rev-parse --git-path cloud-review-loop/...`.
- `--help` is side-effect free.

The Claude runner is macOS-only in v1 and is wrapped with `sandbox-exec`. The live profile grants outbound network access plus scoped Claude install, config, and cache paths, but not broad home-directory reads. `sandbox-exec` cannot enforce hostname-level network allowlists; enforce endpoint allowlisting outside this tool with a proxy or firewall if you need that control.

## State, Logs, and Resume

By default, generated state and logs live under the target repository's git metadata:

```text
cloud-review-loop/state
cloud-review-loop/logs
```

Use `--resume` after an interrupted run. Resume only accepts state for the same PR, worktree, and branch identity.

`prloop resume` is equivalent to `prloop run --resume`, but is the preferred command for schedulers and agent-only workflows. Resume reconciles persisted state against the worktree and GitHub before continuing:

- If a runner was interrupted before producing changes or `runner-result.json`, the runner is re-run for the stored findings.
- If runner edits and a valid `runner-result.json` already exist, `prloop` skips the runner and continues with validation, commit, push, and the next review trigger.
- If the local fix commit already exists, `prloop` verifies whether the PR head already contains it and either records the pushed checkpoint or retries the push.
- If a review trigger comment was posted before state was fully persisted, `prloop` recovers the existing trigger by its hidden run marker instead of posting a duplicate.
- If an interrupted process left an inactive matching lock, `prloop` verifies the recorded PID is gone and the current head matches the lock evidence before reclaiming it.
- If runner edits exist without `runner-result.json`, resume fails with `RESUME_FIXING_RECONCILIATION` because completion cannot be proven.

`prloop status --json` is side-effect free. It does not post comments, run a runner, commit, push, or require trusted actor configuration. It reports the current `run.state`, `run.phase`, `run.resumable`, and `run.recommendedAction` such as `wait`, `rerun_runner`, `commit_existing_diff`, `post_review_trigger`, `wait_for_review`, `done`, or `manual_reconcile`.

When the last stored round is trusted clean for the current head, a later `run` records `retained_clean` and exits with `done` semantics instead of posting a duplicate review trigger.

When `--json` is passed to `run`, `resume`, or `status`, failures are emitted on stderr as a stable envelope:

```json
{"schemaVersion":1,"kind":"prloop.error","ok":false,"exitCode":3,"reason":"DIRTY_WORKTREE","message":"...","retryable":false,"resumable":true}
```

Use `reason` for scheduler decisions; exit codes are intentionally coarse.

You can override generated roots with `--state-dir` and `--log-dir`, but they must not resolve to the worktree root or an ancestor, and they must not contain tracked worktree files.

## Development

Run the local verification suite:

```bash
npm run check
npm test
npm run verify
```

The default test suite uses fake `gh`, `codex`, and `claude` binaries. It does not call live GitHub, Codex, Claude, or network services.

## Limitations

- `prloop` operates only on existing PRs and existing local worktrees.
- It does not open PRs, merge PRs, force-push, rebase, or create GitHub Actions workflows.
- It currently recognizes Codex GitHub review output, not arbitrary review providers.
- Live validation still requires a real PR, a real GitHub connection, and a working Codex review setup.
- The package is source-install oriented until it is published to a registry.

## License

MIT. See [LICENSE](LICENSE).
