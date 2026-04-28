import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function makeFakeBin() {
  const dir = await mkdtemp(join(tmpdir(), 'crl-fake-bin-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'crl-fake-state-'));
  await writeExecutable(join(dir, 'gh'), ghScript());
  await writeExecutable(join(dir, 'codex'), codexScript());
  await writeExecutable(join(dir, 'claude'), claudeScript());
  return { dir, stateDir };
}

async function writeExecutable(path, text) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
  await chmod(path, 0o755);
}

function ghScript() {
  return `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.FAKE_GH_STATE_DIR;
mkdirSync(root, { recursive: true });
const file = join(root, 'gh-state.json');
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { calls: [], comments: [], deleted: [], nextId: 100 };
const args = process.argv.slice(2);
state.calls.push(args);
function save() { writeFileSync(file, JSON.stringify(state, null, 2)); }
function out(value) { save(); process.stdout.write(JSON.stringify(value)); }
function now(offset) { return new Date(Date.UTC(2026, 3, 28, 18, 0, offset)).toISOString(); }
if (args[0] !== 'api') { console.error('expected gh api'); process.exit(1); }
if (process.env.FAKE_GH_RATE_LIMIT_ONCE === '1' && !state.rateLimitSent) {
  state.rateLimitSent = true;
  save();
  console.error('rate limit retry-after: 0');
  process.exit(1);
}
const path = args.find((arg) => arg.startsWith('repos/')) || '';
const faultKey = process.env.FAKE_GH_EOF_ONCE || '';
const endpointKey = classifyEndpoint(path, args);
const afterRunnerFaultKey = process.env.FAKE_GH_EOF_ONCE_AFTER_RUNNER || '';
if (afterRunnerFaultKey && endpointKey === afterRunnerFaultKey && state.runnerCount >= 1 && !state.eofAfterRunnerSent?.[afterRunnerFaultKey]) {
  state.eofAfterRunnerSent = state.eofAfterRunnerSent || {};
  state.eofAfterRunnerSent[afterRunnerFaultKey] = true;
  save();
  console.error('GitHub API transport error after runner for ' + endpointKey + ': EOF retry-after: 0');
  process.exit(1);
}
if (faultKey && endpointKey === faultKey && !state.eofSent?.[faultKey]) {
  state.eofSent = state.eofSent || {};
  state.eofSent[faultKey] = true;
  save();
  console.error('GitHub API transport error for ' + endpointKey + ': EOF retry-after: 0');
  process.exit(1);
}
if (path.includes('/pulls/') && !path.includes('/reviews') && !path.includes('/comments')) {
  out({ state: 'open', merged: false, head: { ref: process.env.FAKE_PR_BRANCH || 'feature/test', sha: process.env.FAKE_PR_HEAD_SHA || 'headsha' } });
} else if (path.endsWith('/issues/123/comments') && args.some((arg) => arg.startsWith('body='))) {
  const bodyArg = args.find((arg) => arg.startsWith('body='));
  const comment = { id: state.nextId++, body: bodyArg.slice(5), created_at: now(state.comments.length + 1), user: { login: 'tool-user' } };
  state.comments.push(comment);
  out(comment);
} else if (path.includes('/issues/comments/') && path.endsWith('/reactions')) {
  const id = Number(path.match(/comments\\/(\\d+)\\/reactions/)[1]);
  if (process.env.FAKE_GH_SKIP_ACK_FIRST === '1' && state.comments[0]?.id === id) out([]);
  else
  out([{ id: id + 1000, content: 'eyes', user: { login: 'codex-bot' } }]);
} else if (args.includes('DELETE')) {
  const id = Number(path.match(/comments\\/(\\d+)/)?.[1] || 0);
  state.deleted.push(id);
  out({});
} else if (path.endsWith('/issues/123/comments')) {
  const triggers = state.comments.filter((comment) => comment.body.startsWith('@codex review'));
  if (triggers.length >= 2) {
    const latest = triggers.at(-1);
    out([{ id: 900, body: "Codex Review: Didn't find any major issues.", created_at: now(50), user: { login: 'codex-bot' }, after: latest.id }]);
  } else {
    out([]);
  }
} else if (path.endsWith('/pulls/123/reviews')) {
  const triggers = state.comments.filter((comment) => comment.body.startsWith('@codex review'));
  if (triggers.length === 1) {
    const reviews = [{ id: 501, state: 'COMMENTED', body: 'Finding body', commit_id: process.env.FAKE_PR_HEAD_SHA || 'headsha', submitted_at: now(20), user: { login: 'codex-bot' } }];
    if (process.env.FAKE_GH_LATE_REVIEW_AFTER_SPAWN === '1' && state.runnerCount >= 1) {
      reviews.push({ id: 502, state: 'COMMENTED', body: 'Late review body', commit_id: process.env.FAKE_PR_HEAD_SHA || 'headsha', submitted_at: now(30), user: { login: 'codex-bot' } });
    }
    out(reviews);
  }
  else out([]);
} else if (path.endsWith('/pulls/123/comments')) {
  const triggers = state.comments.filter((comment) => comment.body.startsWith('@codex review'));
  if (triggers.length === 1) {
    const comments = [{ id: 601, pull_request_review_id: 501, body: 'Inline finding', path: 'subject.txt', line: 1, commit_id: process.env.FAKE_PR_HEAD_SHA || 'headsha', created_at: now(21), user: { login: 'codex-bot' } }];
    if (process.env.FAKE_GH_LATE_AFTER_SPAWN === '1' && state.runnerCount >= 1) {
      comments.push({ id: 602, pull_request_review_id: 501, body: 'Late inline finding', path: 'subject.txt', line: 1, commit_id: process.env.FAKE_PR_HEAD_SHA || 'headsha', created_at: now(30), user: { login: 'codex-bot' } });
    }
    if (process.env.FAKE_GH_LATE_REVIEW_AFTER_SPAWN === '1' && state.runnerCount >= 1) {
      comments.push({ id: 603, pull_request_review_id: 502, body: 'Late review inline finding', path: 'subject.txt', line: 1, commit_id: process.env.FAKE_PR_HEAD_SHA || 'headsha', created_at: now(31), user: { login: 'codex-bot' } });
    }
    out(comments);
  }
  else out([]);
} else {
  console.error('unhandled gh api path: ' + args.join(' '));
  save();
  process.exit(1);
}
function classifyEndpoint(path, args) {
  if (args.includes('DELETE')) return 'delete-issue-comment';
  if (path.endsWith('/issues/123/comments') && args.some((arg) => arg.startsWith('body='))) return 'create-issue-comment';
  if (path.includes('/issues/comments/') && path.endsWith('/reactions')) return 'issue-comment-reactions';
  if (path.endsWith('/issues/123/comments')) return 'issue-comments';
  if (path.endsWith('/pulls/123/reviews')) return 'pull-reviews';
  if (path.endsWith('/pulls/123/comments')) return 'pull-review-comments';
  if (path.includes('/pulls/') && !path.includes('/reviews') && !path.includes('/comments')) return 'get-pull';
  return 'unknown';
}
`;
}

function codexScript() {
  return `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
let prompt = '';
process.stdin.on('data', (chunk) => prompt += chunk);
process.stdin.on('end', () => {
  let runnerCount = 0;
  if (process.env.FAKE_GH_STATE_DIR) {
    const file = join(process.env.FAKE_GH_STATE_DIR, 'gh-state.json');
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      state.runnerCount = (state.runnerCount || 0) + 1;
      runnerCount = state.runnerCount;
      writeFileSync(file, JSON.stringify(state, null, 2));
    } catch {}
  }
  const failCount = Number(process.env.FAKE_CODEX_FAIL_COUNT || (process.env.FAKE_CODEX_FAIL === '1' ? '999999' : '0'));
  if (failCount > 0 && runnerCount <= failCount) {
    process.stderr.write('runner failed intentionally');
    process.exit(2);
  }
  if (process.env.FAKE_CODEX_TAMPER_GIT === '1') {
    spawnSync('git', ['config', 'core.hooksPath', '.malicious-hooks'], { cwd: process.cwd() });
  }
  if (process.env.FAKE_CODEX_NO_WORKTREE_EDIT !== '1') {
    appendFileSync(join(process.cwd(), 'subject.txt'), 'fixed by codex\\n');
  }
  const match = prompt.match(/Write (.+?)\\/runner-result\\.json/);
  const stateDir = match ? match[1] : process.cwd();
  mkdirSync(stateDir, { recursive: true });
  const status = process.env.FAKE_CODEX_RESULT_STATUS || 'fixed';
  writeFileSync(join(stateDir, 'runner-result.json'), JSON.stringify({
    schemaVersion: 1,
    status,
    reviewFingerprint: 'fake',
    summary: status === 'no_op' ? 'no fix needed' : 'fixed',
    tests: [],
    noOpReason: status === 'no_op' ? 'runner made no worktree changes' : null
  }));
  if (process.env.FAKE_CODEX_COMMIT === '1') {
    spawnSync('git', ['add', 'subject.txt'], { cwd: process.cwd() });
    const commit = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Runner fix'], { cwd: process.cwd(), encoding: 'utf8' });
    if (commit.status !== 0) {
      process.stderr.write(commit.stderr || commit.stdout || 'runner commit failed');
      process.exit(commit.status || 1);
    }
  }
  process.stdout.write(JSON.stringify({ ok: true }));
});
`;
}

function claudeScript() {
  return `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ ok: true })));
`;
}
