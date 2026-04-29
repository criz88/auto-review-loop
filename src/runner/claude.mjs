import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from '../subprocess.mjs';
import { fail } from '../errors.mjs';

export async function runClaude({ worktree, stateDir, prompt, config, env, logger }) {
  if (config.unsafeAllowBypassApprovals) {
    fail('unsafeAllowBypassApprovals is not supported for Claude v1 adapter', 'UNSAFE_CONFIG');
  }
  const sandbox = await claudeSandboxCommand({ worktree, stateDir });
  const claudeArgs = ['--print', '--output-format', 'json', '--permission-mode', 'acceptEdits'];
  const command = sandbox.command;
  const args = [...sandbox.args, 'claude', ...claudeArgs];
  await logger?.event('runner_start', { runner: 'claude', command, args });
  const result = await runProcess(command, args, {
    cwd: worktree,
    env,
    input: prompt,
    allowFailure: true,
    timeoutMs: config.runnerTimeoutMs,
    outputLimit: 128 * 1024
  });
  await logger?.event('runner_exit', {
    runner: 'claude',
    code: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr
  });
  return result;
}

async function claudeSandboxCommand({ worktree, stateDir }) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    fail('Claude runner requires macOS sandbox-exec for v1 worktree write confinement; use --runner codex on this platform', 'CLAUDE_SANDBOX_UNAVAILABLE');
  }
  const profilePath = join(stateDir, 'claude-sandbox.sb');
  const profile = buildClaudeSandboxProfile({ worktree, stateDir });
  await writeFile(profilePath, profile, { mode: 0o600 });
  return { command: '/usr/bin/sandbox-exec', args: ['-f', profilePath] };
}

export function buildClaudeSandboxProfile({ worktree, stateDir }) {
  return `(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read*
  (subpath ${sandboxString(worktree)})
  (subpath ${sandboxString(stateDir)})
  (subpath "/bin")
  (subpath "/usr/bin")
  (subpath "/usr/lib")
  (subpath "/usr/local/bin")
  (subpath "/opt/homebrew/bin")
  (subpath "/opt/homebrew/lib")
  (subpath "/System/Library")
  (subpath "/Library/Apple")
  (subpath "/private/tmp")
  (subpath "/tmp"))
(allow file-write*
  (subpath ${sandboxString(worktree)})
  (subpath ${sandboxString(stateDir)})
  (subpath "/private/tmp")
  (subpath "/tmp"))
`;
}

function sandboxString(value) {
  return JSON.stringify(String(value));
}
