import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitWorktree } from '../src/git/worktree.mjs';
import { runProcess } from '../src/subprocess.mjs';
import { withTempRepo } from './helpers/temp-repo.mjs';

test('generated-root checks parse quoted paths and rename entries from porcelain status', async () => {
  await withTempRepo(async ({ root }) => {
    const generatedRoot = join(root, 'generated state');
    await mkdir(generatedRoot);
    await writeFile(join(generatedRoot, 'run state.json'), '{}\n');

    const git = new GitWorktree({ cwd: root });
    await assert.doesNotReject(() => git.ensureClean([generatedRoot]));
    assert.equal(await git.hasChangesOutside([generatedRoot]), false);

    const oldPath = join(generatedRoot, 'old name.txt');
    const newPath = join(generatedRoot, 'new name.txt');
    await writeFile(oldPath, 'generated\n');
    await runProcess('git', ['add', oldPath], { cwd: root });
    await runProcess('git', ['commit', '-m', 'Add generated fixture'], { cwd: root });
    await runProcess('git', ['mv', oldPath, newPath], { cwd: root });

    const entries = await git.statusEntries();
    assert.ok(entries.some((entry) => entry.index === 'R' && entry.path === 'generated state/new name.txt'));
    assert.equal(await git.hasChangesOutside([generatedRoot]), false);
    await assert.rejects(
      () => git.ensureGeneratedPathsUnstaged([generatedRoot]),
      /Generated state\/log paths are staged unexpectedly/
    );
  });
});

test('generated-root checks treat both sides of cross-root rename entries as dirty', async () => {
  await withTempRepo(async ({ root }) => {
    const generatedRoot = join(root, 'generated');
    await mkdir(generatedRoot);

    const oldPath = join(root, 'unsafe.txt');
    const newPath = join(generatedRoot, 'safe.txt');
    await writeFile(oldPath, 'source\n');
    await runProcess('git', ['add', oldPath], { cwd: root });
    await runProcess('git', ['commit', '-m', 'Add unsafe source fixture'], { cwd: root });
    await runProcess('git', ['mv', oldPath, newPath], { cwd: root });

    const git = new GitWorktree({ cwd: root });
    const entries = await git.statusEntries();
    assert.ok(entries.some((entry) => entry.index === 'R' && entry.path === 'generated/safe.txt'));
    assert.ok(entries.some((entry) => entry.index === 'R' && entry.path === 'unsafe.txt'));
    assert.equal(await git.hasChangesOutside([generatedRoot]), true);
    await assert.rejects(
      () => git.ensureClean([generatedRoot]),
      /Dirty worktree contains unsafe paths: unsafe\.txt/
    );
  });
});
