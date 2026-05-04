import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GitWorktree } from './git/worktree.mjs';
import { parsePrRef } from './github/pr-ref.mjs';
import { identitySlug, normalizeStateIdentity } from './state/store.mjs';
import { fail } from './errors.mjs';

export async function resolveRunContext({ flags, cwd, env = process.env }) {
  if (!flags.worktree) fail('--worktree is required', 'USAGE');
  if (!flags.branch) fail('--branch is required', 'USAGE');
  const worktree = await realpath(flags.worktree).catch(() => fail(`Invalid --worktree: ${flags.worktree}`, 'USAGE'));
  const pr = parsePrRef(flags.pr, flags.repo);
  const git = new GitWorktree({ cwd: worktree, env });
  const identity = normalizeStateIdentity({ pr, worktree, branch: flags.branch });
  const runId = identitySlug(identity);
  const stateRoot = resolve(worktree, flags.stateDir || await git.revParseGitPath('cloud-review-loop/state'));
  const logRoot = resolve(worktree, flags.logDir || await git.revParseGitPath('cloud-review-loop/logs'));
  const stateDir = resolve(stateRoot, runId);
  const logDir = resolve(logRoot, runId);
  return {
    cwd,
    env,
    pr,
    worktree,
    branch: flags.branch,
    identity,
    runId,
    stateRoot,
    logRoot,
    stateDir,
    logDir,
    statePath: join(stateDir, 'state.json'),
    git
  };
}
