import { loadConfig, loadResumeConfig, requireTrustedActors } from './config.mjs';
import { runController } from './loop/controller.mjs';
import { fail } from './errors.mjs';
import { resolveRunContext } from './run-context.mjs';
import { StateStore } from './state/store.mjs';
import { buildStatus, formatStatus } from './status.mjs';

const HELP = `prloop

Usage:
  prloop run --pr <url|owner/repo#number|number> --worktree <path> --branch <name> [options]
  prloop resume --pr <url|owner/repo#number|number> --worktree <path> --branch <name> [options]
  prloop status (--state <path>|--pr <ref> --worktree <path> --branch <name>) [--json]
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
  --json                             Emit machine-readable JSON
  --state <path>                     Read a state.json file or state directory for status
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
  if (!['run', 'resume', 'status'].includes(command)) fail(`Unknown command: ${command}`, 'USAGE');
  const flags = parseFlags(argv.slice(1));
  const cwd = process.cwd();

  if (command === 'status') {
    const status = await buildStatus({ flags, cwd, env });
    io.stdout.write(flags.json ? `${JSON.stringify(status)}\n` : formatStatus(status));
    return 0;
  }

  if (command === 'resume') flags.resume = true;
  const context = await resolveRunContext({ flags, cwd, env });
  const { config, configPath } = await loadConfig(cwd, flags);
  const effectiveConfig = flags.resume
    ? await loadEffectiveResumeConfig({ context, config, flags })
    : config;
  requireTrustedActors(effectiveConfig);
  const exitCode = await runController({
    ...context,
    reviewPrompt: flags.reviewPrompt || '',
    stateDirOverride: flags.stateDir,
    logDirOverride: flags.logDir,
    resume: Boolean(flags.resume),
    config: effectiveConfig,
    configPath
  });
  if (flags.json) {
    io.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: 'prloop.result',
      ok: true,
      exitCode,
      runId: context.runId,
      statePath: context.statePath,
      logDir: context.logDir
    })}\n`);
  }
  return exitCode;
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
    ['--state', 'state'],
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
    if (arg === '--json') {
      flags.json = true;
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

async function loadEffectiveResumeConfig({ context, config, flags }) {
  const state = await new StateStore(context.stateDir).read();
  if (!state?.configSnapshot) return config;
  return loadResumeConfig(state.configSnapshot, flags);
}
