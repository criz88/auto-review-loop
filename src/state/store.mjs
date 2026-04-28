import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fail } from '../errors.mjs';

export class StateStore {
  constructor(root) {
    this.root = root;
    this.statePath = join(root, 'state.json');
    this.lockPath = join(root, 'lock.json');
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  async read() {
    if (!existsSync(this.statePath)) return null;
    const raw = await readFile(this.statePath, 'utf8');
    return JSON.parse(raw);
  }

  async write(state) {
    await atomicWriteJson(this.statePath, state);
  }

  async acquireLock(payload) {
    await this.init();
    const data = `${JSON.stringify({ ...payload, pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`;
    let fd;
    try {
      fd = await open(this.lockPath, 'wx', 0o600);
      await fd.writeFile(data);
      await fd.sync();
    } catch (error) {
      if (error.code === 'EEXIST') {
        const raw = await readFile(this.lockPath, 'utf8').catch(() => '{}');
        fail(`Active cloud-review-loop lock exists at ${this.lockPath}: ${raw}`, 'LOCKED');
      }
      throw error;
    } finally {
      await fd?.close();
    }
  }

  async releaseLock() {
    await rm(this.lockPath, { force: true });
  }
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, data, { mode: 0o600 });
  const fd = await open(tmp, 'r');
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(tmp, path);
}

export function normalizeStateIdentity({ pr, worktree, branch }) {
  return {
    pr: `${pr.fullName}#${pr.number}`,
    worktree: resolve(worktree),
    branch
  };
}

export function identitySlug(identity) {
  const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
  const label = identity.pr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${label}-${hash}`;
}
