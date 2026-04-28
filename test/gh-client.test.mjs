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
