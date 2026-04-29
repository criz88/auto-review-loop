import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhClient } from '../src/github/gh-client.mjs';

test('paginated list reads use slurp and flatten pages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crl-gh-client-'));
  try {
    const ghPath = join(dir, 'gh');
    const callsPath = join(dir, 'calls.json');
    await writeFile(ghPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.CALLS_PATH, JSON.stringify(args));
if (!args.includes('--paginate') || !args.includes('--slurp')) {
  process.stderr.write('missing pagination flags');
  process.exit(1);
}
process.stdout.write(JSON.stringify([[{ id: 1 }], [{ id: 2 }]]));
`);
    await chmod(ghPath, 0o755);

    const client = new GhClient({
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS_PATH: callsPath },
      owner: 'OWNER',
      repo: 'REPO',
      number: 123
    });

    assert.deepEqual(await client.listPullReviewComments(), [{ id: 1 }, { id: 2 }]);
    const calls = JSON.parse(await readFile(callsPath, 'utf8'));
    assert.deepEqual(calls, [
      'api',
      'repos/OWNER/REPO/pulls/123/comments',
      '--paginate',
      '--slurp'
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('read endpoints retry transient EOF and log structured metadata', async () => {
  await withFakeGh(`
let state = readState();
state.calls = (state.calls || 0) + 1;
writeState(state);
if (state.calls === 1) {
  process.stderr.write('Get "https://api.github.com/repos/OWNER/REPO/issues/123/comments": EOF');
  process.exit(1);
}
process.stdout.write(JSON.stringify([[{ id: 1 }]]));
`, async ({ client, statePath, events }) => {
    assert.deepEqual(await client.listIssueComments(), [{ id: 1 }]);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.calls, 2);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'github_backoff');
    assert.equal(events[0].operation, 'listIssueComments');
    assert.equal(events[0].method, 'GET');
    assert.equal(events[0].path, 'repos/OWNER/REPO/issues/123/comments');
    assert.equal(Object.hasOwn(events[0], 'args'), false);
  });
});

test('read endpoints retry invalid JSON before succeeding', async () => {
  await withFakeGh(`
let state = readState();
state.calls = (state.calls || 0) + 1;
writeState(state);
if (state.calls === 1) {
  process.stdout.write('{');
} else {
  process.stdout.write(JSON.stringify([[{ id: 501 }]]));
}
`, async ({ client, statePath }) => {
    assert.deepEqual(await client.listPullReviews(), [{ id: 501 }]);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.calls, 2);
  });
});

test('read endpoints fail clearly after invalid JSON retries are exhausted', async () => {
  await withFakeGh(`
let state = readState();
state.calls = (state.calls || 0) + 1;
writeState(state);
process.stdout.write('{');
`, async ({ client, statePath }) => {
    await assert.rejects(
      () => client.api(['repos/OWNER/REPO/pulls/123/reviews'], {
        operation: 'listPullReviews',
        retryTransient: true,
        retryDelayMs: 0,
        maxAttempts: 2
      }),
      /GitHub API returned invalid JSON for listPullReviews/
    );
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.calls, 2);
  });
});

test('auth failures do not retry', async () => {
  await withFakeGh(`
let state = readState();
state.calls = (state.calls || 0) + 1;
writeState(state);
process.stderr.write('HTTP 401: Bad credentials');
process.exit(1);
`, async ({ client, statePath }) => {
    await assert.rejects(() => client.getPull(), /Bad credentials/);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.calls, 1);
  });
});

test('create issue comment does not retry ambiguous EOF', async () => {
  await withFakeGh(`
let state = readState();
state.calls = (state.calls || 0) + 1;
writeState(state);
process.stderr.write('Post "https://api.github.com/repos/OWNER/REPO/issues/123/comments": EOF');
process.exit(1);
`, async ({ client, statePath }) => {
    await assert.rejects(() => client.createIssueComment('@codex review'), /EOF/);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.calls, 1);
  });
});

test('delete issue comment accepts empty successful response', async () => {
  await withFakeGh(`
let state = readState();
state.calls = (state.calls || 0) + 1;
writeState(state);
`, async ({ client, statePath }) => {
    assert.equal(await client.deleteIssueComment(123), null);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.calls, 1);
  });
});

async function withFakeGh(scriptBody, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'crl-gh-client-'));
  try {
    const ghPath = join(dir, 'gh');
    const statePath = join(dir, 'state.json');
    await writeFile(ghPath, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
function readState() {
  return existsSync(process.env.STATE_PATH) ? JSON.parse(readFileSync(process.env.STATE_PATH, 'utf8')) : { calls: 0, argv: [] };
}
function writeState(state) {
  state.argv = state.argv || [];
  state.argv.push(args);
  writeFileSync(process.env.STATE_PATH, JSON.stringify(state, null, 2));
}
${scriptBody}
`);
    await chmod(ghPath, 0o755);
    const events = [];
    const client = new GhClient({
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STATE_PATH: statePath },
      owner: 'OWNER',
      repo: 'REPO',
      number: 123,
      logger: {
        async event(type, payload) {
          events.push({ type, ...payload });
        }
      }
    });
    await fn({ client, statePath, events });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
