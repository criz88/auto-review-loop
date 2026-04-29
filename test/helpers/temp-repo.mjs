import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../src/subprocess.mjs';

export async function withTempRepo(fn) {
  const root = await mkdtemp(join(tmpdir(), 'crl-repo-'));
  const remote = await mkdtemp(join(tmpdir(), 'crl-remote-'));
  try {
    await runProcess('git', ['init', '--bare'], { cwd: remote });
    await runProcess('git', ['init', '-b', 'feature/test'], { cwd: root });
    await runProcess('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await runProcess('git', ['config', 'user.name', 'Test User'], { cwd: root });
    await writeFile(join(root, 'subject.txt'), 'initial\n');
    await runProcess('git', ['add', 'subject.txt'], { cwd: root });
    await runProcess('git', ['commit', '-m', 'Initial commit'], { cwd: root });
    await runProcess('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await runProcess('git', ['push', '-u', 'origin', 'feature/test'], { cwd: root });
    const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await fn({ root, remote, head });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
}
