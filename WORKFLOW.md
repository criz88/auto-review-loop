# PR Loop Workflow Guardrails

This project separates repository workflow rules from PR Loop runtime behavior.

## Repository-Owned Guardrails

The repository owns documented operator behavior and agent guidance:

- Do not post a new `@codex review` when status or state already shows trusted clean evidence for the current PR head.
- Prefer `status --json` before live recovery. If the recommended action is `done`, stop.
- Prefer `resume` for interrupted runs. Do not manually edit `lock.json`; stale lock reconciliation belongs in PR Loop.
- Use a Human Review exit when automation cannot prove the next safe action from state, logs, PR evidence, and git state.
- Land only after trusted clean evidence is retained for the current head and required local validation passes.

## PR Loop-Owned Behavior

The CLI owns runtime idempotency and recovery:

- `run` retains trusted clean evidence for an unchanged head instead of reposting a review trigger.
- `resume` may reclaim an inactive matching lock when the owning PID is gone and PR/worktree/branch/head checks pass.
- Connector and GitHub transient failures are classified separately from auth, rate-limit, and permanent API failures.
- Recovery decisions are recorded in state and NDJSON audit logs.

## Release Checklist

1. Update `package.json` and `package-lock.json`.
2. Add a release note in `CHANGELOG.md`.
3. Run `npm run verify`.
4. Open a PR with the validation results.
5. Merge only after checks pass and the PR has trusted clean review evidence.
6. Publish through the repository release workflow using the matching `v<version>` tag or GitHub release.
