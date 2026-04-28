import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCodex } from './codex.mjs';
import { runClaude } from './claude.mjs';
import { fail } from '../errors.mjs';

export async function runSelectedRunner(options) {
  const runner = options.config.defaultRunner;
  if (runner === 'codex') return runCodex(options);
  if (runner === 'claude') return runClaude(options);
  fail(`Unknown runner: ${runner}`, 'INVALID_RUNNER');
}

export async function readRunnerResult(stateDir) {
  const path = join(stateDir, 'runner-result.json');
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Invalid runner-result.json: ${error.message}`, 'RUNNER_RESULT_INVALID');
  }
}

export function classifyRunnerOutcome({ result, runnerResult, hasChanges }) {
  if (result.code !== 0 || result.timedOut) fail('Runner failed before producing a valid repair', 'RUNNER_FAILED');
  if (runnerResult?.status === 'failed') fail(`Runner reported failure: ${runnerResult.summary || ''}`, 'RUNNER_FAILED');
  if (!hasChanges) {
    if (runnerResult?.status === 'no_op') fail(`NO_FIX_PRODUCED: ${runnerResult.noOpReason || 'runner made no changes'}`, 'NO_FIX_PRODUCED');
    fail('NO_FIX_PRODUCED: runner succeeded without a git diff', 'NO_FIX_PRODUCED');
  }
  return 'fixed';
}
