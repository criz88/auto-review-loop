import { realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { runProcess } from '../subprocess.mjs';
import { fail } from '../errors.mjs';

export async function runClaude({ worktree, stateDir, prompt, config, env, logger }) {
  if (config.unsafeAllowBypassApprovals) {
    fail('unsafeAllowBypassApprovals is not supported for Claude v1 adapter', 'UNSAFE_CONFIG');
  }
  const sandbox = await claudeSandboxCommand({ worktree, stateDir, env });
  const claudeArgs = ['--print', '--output-format', 'json', '--permission-mode', 'acceptEdits'];
  const command = sandbox.command;
  const args = [...sandbox.args, sandbox.executable, ...claudeArgs];
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

async function claudeSandboxCommand({ worktree, stateDir, env }) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    fail('Claude runner requires macOS sandbox-exec for v1 worktree write confinement; use --runner codex on this platform', 'CLAUDE_SANDBOX_UNAVAILABLE');
  }
  const executable = await resolveClaudeExecutable({ worktree, env });
  const profilePath = join(stateDir, 'claude-sandbox.sb');
  const profile = buildClaudeSandboxProfile({ worktree, stateDir, claudeExecutable: executable });
  await writeFile(profilePath, profile, { mode: 0o600 });
  return { command: '/usr/bin/sandbox-exec', args: ['-f', profilePath], executable };
}

async function resolveClaudeExecutable({ worktree, env }) {
  const result = await runProcess('/usr/bin/which', ['claude'], {
    cwd: worktree,
    env,
    allowFailure: true,
    timeoutMs: 5000
  });
  if (result.code !== 0 || !result.stdout.trim()) {
    fail('Unable to locate claude executable in PATH', 'CLAUDE_NOT_FOUND');
  }
  return realpath(result.stdout.trim());
}

export function buildClaudeSandboxProfile({ worktree, stateDir, claudeExecutable = '', homeDir = homedir() }) {
  const readPaths = uniquePaths([
    worktree,
    stateDir,
    dirname(claudeExecutable),
    join(homeDir, '.claude'),
    join(homeDir, '.claude.json'),
    join(homeDir, '.claude.json.backup'),
    join(homeDir, '.local', 'bin'),
    join(homeDir, '.local', 'share', 'claude'),
    join(homeDir, 'Library', 'Application Support', 'ClaudeCode'),
    join(homeDir, 'Library', 'Caches', 'ClaudeCode'),
    join(homeDir, 'Library', 'Keychains'),
    join(homeDir, 'Library', 'Logs', 'ClaudeCode'),
    join(homeDir, 'Library', 'Preferences'),
    '/bin',
    '/usr/bin',
    '/usr/lib',
    '/usr/share',
    '/usr/local/bin',
    '/usr/local/Cellar',
    '/usr/local/etc',
    '/usr/local/lib',
    '/usr/local/opt',
    '/opt/homebrew/bin',
    '/opt/homebrew/Cellar',
    '/opt/homebrew/etc',
    '/opt/homebrew/lib',
    '/opt/homebrew/opt',
    '/System/Library',
    '/Library/Apple',
    '/Library/Application Support/ClaudeCode',
    '/private/tmp',
    '/tmp',
    process.env.TMPDIR || ''
  ]);
  const writePaths = uniquePaths([
    worktree,
    stateDir,
    join(worktree, '.claude'),
    join(homeDir, '.claude'),
    join(homeDir, '.claude.json'),
    join(homeDir, 'Library', 'Application Support', 'ClaudeCode'),
    join(homeDir, 'Library', 'Caches', 'ClaudeCode'),
    join(homeDir, 'Library', 'Logs', 'ClaudeCode'),
    '/private/tmp',
    '/tmp',
    process.env.TMPDIR || ''
  ]);
  return `(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow network*)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read*
  (literal "/")
${sandboxSubpaths(readPaths)})
(allow file-write*
${sandboxSubpaths(writePaths)})
`;
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((path) => String(path)))];
}

function sandboxSubpaths(paths) {
  return paths.map((path) => `  (subpath ${sandboxString(path)})`).join('\n');
}

function sandboxString(value) {
  return JSON.stringify(String(value));
}
