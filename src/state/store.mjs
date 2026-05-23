import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fail } from '../errors.mjs';

export class StateStore {
  constructor(root) {
    this.root = root;
    this.statePath = join(root, 'state.json');
    this.lockPath = join(root, 'lock.json');
    this.heartbeatTimer = null;
    this.heartbeatWrites = new Set();
    this.lockReleasing = false;
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
    stampState(state);
    await atomicWriteJson(this.statePath, state);
  }

  async acquireLock(payload, options = {}) {
    await this.init();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = new Date().toISOString();
      this.lockReleasing = false;
      this.lockPayload = {
        ...payload,
        pid: process.pid,
        head: options.currentHead || payload.head || null,
        createdAt: now,
        lastSeenAt: now
      };
      const data = `${JSON.stringify(this.lockPayload, null, 2)}\n`;
      let fd;
      try {
        fd = await open(this.lockPath, 'wx', 0o600);
        await fd.writeFile(data);
        await fd.sync();
        return;
      } catch (error) {
        if (error.code === 'EEXIST' && attempt === 0) {
          if (await this.reconcileStaleLock(payload, options)) continue;
          const raw = await readFile(this.lockPath, 'utf8').catch(() => '{}');
          fail(`Active cloud-review-loop lock exists at ${this.lockPath}: ${raw}`, 'LOCKED');
        }
        if (error.code === 'EEXIST') {
          const raw = await readFile(this.lockPath, 'utf8').catch(() => '{}');
          fail(`Active cloud-review-loop lock exists at ${this.lockPath}: ${raw}`, 'LOCKED');
        }
        throw error;
      } finally {
        await fd?.close();
      }
    }
  }

  async reconcileStaleLock(payload, options = {}) {
    const raw = await readFile(this.lockPath, 'utf8').catch(() => null);
    if (!raw) return true;
    const existing = parseJson(raw);
    const staleAfterMs = options.staleAfterMs ?? 30_000;
    const currentHead = options.currentHead || null;
    const lastSeenAt = existing?.lastSeenAt || existing?.createdAt || null;
    const staleByTime = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() >= staleAfterMs : true;
    const sameIdentity = lockIdentityMatches(existing, payload);
    const sameHead = existing?.head && currentHead ? existing.head === currentHead : Boolean(currentHead);
    if (!existing || processIsActive(existing.pid) || !staleByTime || !sameIdentity || !sameHead) return false;
    await options.onStaleLock?.({
      pid: Number.isInteger(existing.pid) ? existing.pid : null,
      lastSeenAt,
      lockHead: existing.head || null,
      currentHead
    });
    await rm(this.lockPath, { force: true });
    return true;
  }

  startHeartbeat(intervalMs = 5000) {
    if (!this.lockPayload || this.lockReleasing) return () => {};
    const write = () => {
      if (this.lockReleasing || !this.lockPayload) return;
      this.lockPayload = { ...this.lockPayload, lastSeenAt: new Date().toISOString() };
      const pending = atomicWriteJson(this.lockPath, this.lockPayload)
        .catch(() => {})
        .finally(() => {
          this.heartbeatWrites.delete(pending);
        });
      this.heartbeatWrites.add(pending);
    };
    const timer = setInterval(write, intervalMs);
    this.heartbeatTimer = timer;
    return () => {
      clearInterval(timer);
      if (this.heartbeatTimer === timer) this.heartbeatTimer = null;
    };
  }

  async readLock() {
    if (!existsSync(this.lockPath)) return null;
    const raw = await readFile(this.lockPath, 'utf8');
    return JSON.parse(raw);
  }

  async releaseLock() {
    this.lockReleasing = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await Promise.allSettled(this.heartbeatWrites);
    this.heartbeatWrites.clear();
    await rm(this.lockPath, { force: true });
    this.lockPayload = null;
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

export function triggerRunId(identity) {
  return `${identitySlug(identity)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function stampState(state) {
  if (!state || typeof state !== 'object') return;
  const now = new Date().toISOString();
  if (!state.createdAt) state.createdAt = now;
  state.updatedAt = now;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function lockIdentityMatches(existing, payload) {
  return existing?.pr === payload?.pr &&
    resolve(existing?.worktree || '') === resolve(payload?.worktree || '') &&
    existing?.branch === payload?.branch;
}

function processIsActive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
