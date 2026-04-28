import { realpath } from 'node:fs/promises';
import { loadConfig, requireTrustedActors } from './config.mjs';
import { parsePrRef } from './github/pr-ref.mjs';
import { runController } from './loop/controller.mjs';
import { fail } from './errors.mjs';

const HELP = `prloop

Usage:
  prloop run --pr <url|owner/repo#number|number> --worktree <path> --branch <name> [options]
  prloop --help

Options:
  --repo <owner/repo>                 Required when --pr is numeric
  --runner <codex|claude>             Runner override
  --review-prompt <text>              Appended to "@codex review"
  --config <path>                     JSON config path
  --max-rounds <n>                    0 means unlimited
  --review-timeout <duration>         0 means unlimited
  --runner-timeout <duration>         0 means unlimited
  --max-runner-failures <n>           0 means unlimited
  --poll-interval <duration>          Default 30s
  --push-remote <name>                Default origin
  --resume                           Resume persisted state
  --state-dir <path>                  Override state directory
  --log-dir <path>                    Override log directory
  --trusted-review-actor <login>      Repeatable
  --trusted-clean-actor <login>       Repeatable
  --trusted-ack-actor <login>         Repeatable
  --trigger-ack-timeout <duration>    Default 60s
  --max-trigger-reposts <n>           0 means unlimited
`;

export async function main(argv, env = process.env, io = process) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(HELP);
    return 0;
  }
  const command = argv[0];
  if (command !== 'run') fail(`Unknown command: ${command}`, 'USAGE');
  const flags = parseFlags(argv.slice(1));
  if (!flags.worktree) fail('--worktree is required', 'USAGE');
  if (!flags.branch) fail('--branch is required', 'USAGE');
  const worktree = await realpath(flags.worktree).catch(() => fail(`Invalid --worktree: ${flags.worktree}`, 'USAGE'));
  const cwd = process.cwd();
  const { config, configPath } = await loadConfig(cwd, flags);
  requireTrustedActors(config);
  const pr = parsePrRef(flags.pr, flags.repo);
  return runController({
    cwd,
    env,
    pr,
    worktree,
    branch: flags.branch,
    reviewPrompt: flags.reviewPrompt || '',
    stateDir: flags.stateDir,
    logDir: flags.logDir,
    resume: Boolean(flags.resume),
    config,
    configPath
  });
}

export function parseFlags(args) {
  const flags = {
    trustedReviewActors: [],
    trustedCleanActors: [],
    trustedAckActors: []
  };
  const aliases = new Map([
    ['--pr', 'pr'],
    ['--repo', 'repo'],
    ['--worktree', 'worktree'],
    ['--branch', 'branch'],
    ['--runner', 'runner'],
    ['--review-prompt', 'reviewPrompt'],
    ['--config', 'config'],
    ['--max-rounds', 'maxRounds'],
    ['--review-timeout', 'reviewTimeout'],
    ['--runner-timeout', 'runnerTimeout'],
    ['--max-runner-failures', 'maxRunnerFailures'],
    ['--poll-interval', 'pollInterval'],
    ['--push-remote', 'pushRemote'],
    ['--state-dir', 'stateDir'],
    ['--log-dir', 'logDir'],
    ['--trigger-ack-timeout', 'triggerAckTimeout'],
    ['--max-trigger-reposts', 'maxTriggerReposts']
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--resume') {
      flags.resume = true;
      continue;
    }
    if (arg === '--allow-runner-commit') {
      flags.allowRunnerCommit = true;
      continue;
    }
    if (arg === '--unsafe-allow-bypass-approvals') {
      flags.unsafeAllowBypassApprovals = true;
      continue;
    }
    if (arg === '--trusted-review-actor') {
      flags.trustedReviewActors.push(nextValue(args, ++i, arg));
      continue;
    }
    if (arg === '--trusted-clean-actor') {
      flags.trustedCleanActors.push(nextValue(args, ++i, arg));
      continue;
    }
    if (arg === '--trusted-ack-actor') {
      flags.trustedAckActors.push(nextValue(args, ++i, arg));
      continue;
    }
    const key = aliases.get(arg);
    if (!key) fail(`Unknown option: ${arg}`, 'USAGE');
    flags[key] = nextValue(args, ++i, arg);
  }
  return flags;
}

function nextValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`, 'USAGE');
  return value;
}
