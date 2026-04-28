import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { runProcess } from '../subprocess.mjs';
import { fail } from '../errors.mjs';

export class GitWorktree {
  constructor({ cwd, env = process.env }) {
    this.cwd = cwd;
    this.env = env;
  }

  git(args, options = {}) {
    return runProcess('git', args, {
      cwd: this.cwd,
      env: this.env,
      allowFailure: options.allowFailure || false,
      timeoutMs: options.timeoutMs || 30_000,
      input: options.input || ''
    });
  }

  async revParseGitPath(path) {
    const result = await this.git(['rev-parse', '--git-path', path]);
    return resolve(this.cwd, result.stdout.trim());
  }

  async currentBranch() {
    const result = await this.git(['branch', '--show-current']);
    return result.stdout.trim();
  }

  async head() {
    const result = await this.git(['rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  async isRepo() {
    const result = await this.git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
    return result.code === 0 && result.stdout.trim() === 'true';
  }

  async statusPorcelain() {
    const result = await this.git(['status', '--porcelain=v1']);
    return result.stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
  }

  async statusEntries() {
    const result = await this.git(['status', '--porcelain=v1']);
    return result.stdout.split('\n').filter(Boolean).map((line) => ({
      index: line[0],
      worktree: line[1],
      path: line.slice(3)
    }));
  }

  async hasStagedOrUnstagedDiff() {
    const status = await this.statusPorcelain();
    return status.length > 0;
  }

  async hasChangesOutside(allowedRoots = []) {
    const entries = await this.statusEntries();
    return entries.some((entry) => !isAllowedGeneratedPath(this.cwd, entry.path, allowedRoots));
  }

  async ensureClean(allowedRoots = []) {
    const dirty = await this.statusPorcelain();
    const unsafe = dirty.filter((path) => !isAllowedGeneratedPath(this.cwd, path, allowedRoots));
    if (unsafe.length > 0) fail(`Dirty worktree contains unsafe paths: ${unsafe.join(', ')}`, 'DIRTY_WORKTREE');
  }

  async ensureGeneratedPathsUnstaged(allowedRoots = []) {
    const entries = await this.statusEntries();
    const generated = entries.filter((entry) => isAllowedGeneratedPath(this.cwd, entry.path, allowedRoots));
    const staged = generated.filter((entry) => entry.index !== '?' && entry.index !== ' ');
    if (staged.length > 0) {
      fail(`Generated state/log paths are staged unexpectedly: ${staged.map((entry) => entry.path).join(', ')}`, 'GENERATED_PATH_STAGED');
    }
  }

  async ensureBranch(branch) {
    const current = await this.currentBranch();
    if (current !== branch) fail(`Current branch ${current || '(detached)'} does not match --branch ${branch}`, 'BRANCH_MISMATCH');
  }

  async commitAll(message, generatedPaths = []) {
    await this.git(['add', '-A']);
    await this.unstageGeneratedPaths(generatedPaths);
    await this.git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', message]);
    return this.head();
  }

  async push(remote, branch) {
    return this.git(['-c', 'core.hooksPath=/dev/null', 'push', remote, `HEAD:${branch}`]);
  }

  async unstageGeneratedPaths(paths) {
    const pathspecs = paths
      .map((path) => relative(this.cwd, resolve(path)))
      .filter((path) => path && !path.startsWith('..') && !path.startsWith('/') && !path.startsWith('.git/'));
    if (pathspecs.length > 0) {
      await this.git(['reset', '--', ...pathspecs]);
    }
  }

  async gitControlSnapshot() {
    const config = await this.git(['config', '--local', '--list'], { allowFailure: true });
    const remotes = await this.git(['remote', '-v'], { allowFailure: true });
    const hooksPath = await this.git(['rev-parse', '--git-path', 'hooks']);
    const hooks = await hashDirectory(resolve(this.cwd, hooksPath.stdout.trim()));
    return {
      config: config.stdout,
      remotes: remotes.stdout,
      hooks
    };
  }

  async assertGitControlUnchanged(before) {
    const after = await this.gitControlSnapshot();
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      fail('Runner modified git control state (.git config, remotes, or hooks)', 'GIT_CONTROL_TAMPERED');
    }
  }
}

export async function validateWorktree({ git, branch, allowedRoots }) {
  if (!(await git.isRepo())) fail('--worktree must be a git repository', 'NOT_GIT_REPO');
  await git.ensureBranch(branch);
  await git.ensureClean(allowedRoots);
}

export function isAllowedGeneratedPath(worktree, path, allowedRoots) {
  const absolute = resolve(worktree, path);
  return allowedRoots.some((root) => {
    const rel = relative(resolve(root), absolute);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
  });
}

async function hashDirectory(root) {
  const files = await listFiles(root).catch(() => []);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const rel = relative(root, file);
    const info = await stat(file);
    hash.update(rel);
    hash.update(String(info.mode));
    hash.update(String(info.size));
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}
