import { join } from 'node:path';
import { runProcess } from '../subprocess.mjs';
import { fail } from '../errors.mjs';

export async function runCodex({ worktree, stateDir, prompt, config, env, logger }) {
  if (config.unsafeAllowBypassApprovals) {
    fail('unsafeAllowBypassApprovals is not supported for Codex v1 adapter', 'UNSAFE_CONFIG');
  }
  const args = [
    'exec',
    '--cd',
    worktree,
    '--json',
    '--output-last-message',
    join(stateDir, 'runner-last-message.md'),
    '--full-auto',
    '--sandbox',
    'workspace-write',
    '-'
  ];
  await logger?.event('runner_start', { runner: 'codex', command: 'codex', args });
  const result = await runProcess('codex', args, {
    cwd: worktree,
    env,
    input: prompt,
    allowFailure: true,
    timeoutMs: config.runnerTimeoutMs,
    outputLimit: 128 * 1024
  });
  await logger?.event('runner_exit', {
    runner: 'codex',
    code: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr
  });
  return result;
}
