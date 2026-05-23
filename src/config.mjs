import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDuration, parseBound } from './duration.mjs';
import { fail } from './errors.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  defaultRunner: 'codex',
  pollInterval: '30s',
  maxRounds: 0,
  reviewTimeout: '0',
  runnerTimeout: '0',
  maxRunnerFailures: 0,
  pushRemote: 'origin',
  trustedReviewActors: [],
  trustedCleanActors: [],
  trustedAckActors: [],
  triggerAckTimeout: '60s',
  maxTriggerReposts: 0,
  allowRunnerCommit: false,
  unsafeAllowBypassApprovals: false,
  runnerPromptAppend: ''
});

export async function loadConfig(cwd, flags) {
  const configPath = resolveConfigPath(cwd, flags.config);
  const fileConfig = configPath ? await readJsonConfig(configPath) : {};
  const merged = normalizeConfig({ ...DEFAULT_CONFIG, ...fileConfig }, flags);
  return { config: merged, configPath };
}

export function configSnapshot(config) {
  return {
    defaultRunner: config.defaultRunner,
    pollInterval: config.pollInterval,
    maxRounds: config.maxRounds,
    reviewTimeout: config.reviewTimeout,
    runnerTimeout: config.runnerTimeout,
    maxRunnerFailures: config.maxRunnerFailures,
    pushRemote: config.pushRemote,
    trustedReviewActors: config.trustedReviewActors,
    trustedCleanActors: config.trustedCleanActors,
    trustedAckActors: config.trustedAckActors,
    triggerAckTimeout: config.triggerAckTimeout,
    maxTriggerReposts: config.maxTriggerReposts,
    allowRunnerCommit: config.allowRunnerCommit,
    unsafeAllowBypassApprovals: config.unsafeAllowBypassApprovals,
    runnerPromptAppend: config.runnerPromptAppend
  };
}

export function loadResumeConfig(snapshot, flags) {
  return normalizeConfig({ ...DEFAULT_CONFIG, ...(snapshot || {}) }, flags);
}

function resolveConfigPath(cwd, explicitPath) {
  if (explicitPath) return resolve(cwd, explicitPath);
  const local = resolve(cwd, '.cloud-review-loop.json');
  return existsSync(local) ? local : null;
}

async function readJsonConfig(path) {
  if (!path.endsWith('.json')) fail(`Only JSON config is supported: ${path}`, 'INVALID_CONFIG');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    fail(`Unable to read config ${path}: ${error.message}`, 'INVALID_CONFIG');
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Invalid JSON config ${path}: ${error.message}`, 'INVALID_CONFIG');
  }
}

function normalizeConfig(base, flags) {
  const config = { ...base };
  if (flags.runner) config.defaultRunner = flags.runner;
  if (flags.maxRounds !== undefined) config.maxRounds = Number(flags.maxRounds);
  if (flags.reviewTimeout) config.reviewTimeout = flags.reviewTimeout;
  if (flags.runnerTimeout) config.runnerTimeout = flags.runnerTimeout;
  if (flags.maxRunnerFailures !== undefined) config.maxRunnerFailures = Number(flags.maxRunnerFailures);
  if (flags.pollInterval) config.pollInterval = flags.pollInterval;
  if (flags.pushRemote) config.pushRemote = flags.pushRemote;
  if (flags.trustedReviewActors?.length) config.trustedReviewActors = flags.trustedReviewActors;
  if (flags.trustedCleanActors?.length) config.trustedCleanActors = flags.trustedCleanActors;
  if (flags.trustedAckActors?.length) config.trustedAckActors = flags.trustedAckActors;
  if (flags.triggerAckTimeout) config.triggerAckTimeout = flags.triggerAckTimeout;
  if (flags.maxTriggerReposts !== undefined) config.maxTriggerReposts = Number(flags.maxTriggerReposts);
  if (flags.allowRunnerCommit) config.allowRunnerCommit = true;
  if (flags.unsafeAllowBypassApprovals) config.unsafeAllowBypassApprovals = true;

  if (!['codex', 'claude'].includes(config.defaultRunner)) {
    fail(`Invalid runner: ${config.defaultRunner}`, 'INVALID_RUNNER');
  }

  config.pollIntervalMs = parseDuration(config.pollInterval, 'pollInterval');
  config.reviewTimeoutMs = parseDuration(config.reviewTimeout, 'reviewTimeout');
  config.runnerTimeoutMs = parseDuration(config.runnerTimeout, 'runnerTimeout');
  config.triggerAckTimeoutMs = parseDuration(config.triggerAckTimeout, 'triggerAckTimeout');
  config.maxRounds = parseBound(config.maxRounds, 'maxRounds');
  config.maxRunnerFailures = parseBound(config.maxRunnerFailures, 'maxRunnerFailures');
  config.maxTriggerReposts = parseBound(config.maxTriggerReposts, 'maxTriggerReposts');
  config.trustedReviewActors = uniqueStrings(config.trustedReviewActors);
  config.trustedCleanActors = uniqueStrings(config.trustedCleanActors);
  config.trustedAckActors = uniqueStrings(config.trustedAckActors);
  config.runnerPromptAppend = normalizeOptionalString(config.runnerPromptAppend, 'runnerPromptAppend');
  return config;
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) fail('Trusted actor lists must be arrays', 'INVALID_CONFIG');
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))];
}

function normalizeOptionalString(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(`${name} must be a string`, 'INVALID_CONFIG');
  return value.trim();
}

export function requireTrustedActors(config) {
  if (config.trustedReviewActors.length === 0) fail('trustedReviewActors must be configured for live run', 'MISSING_TRUSTED_ACTORS');
  if (config.trustedCleanActors.length === 0) fail('trustedCleanActors must be configured for live run', 'MISSING_TRUSTED_ACTORS');
  if (config.trustedAckActors.length === 0) fail('trustedAckActors must be configured for live run', 'MISSING_TRUSTED_ACTORS');
}
