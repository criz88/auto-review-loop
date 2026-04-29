import { fail } from './errors.mjs';

const UNLIMITED_FIELDS = new Set([
  'maxRounds',
  'reviewTimeout',
  'runnerTimeout',
  'maxRunnerFailures'
]);

export function parseDuration(value, field = 'duration') {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) fail(`Invalid ${field}: expected a non-negative integer`);
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '') fail(`Invalid ${field}: expected duration string`);
  const text = value.trim();
  if (text === '0') return 0;
  const match = /^([0-9]+)(s|m|h)$/.exec(text);
  if (!match) fail(`Invalid ${field}: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isSafeInteger(amount)) fail(`Invalid ${field}: ${value}`);
  const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return amount * multiplier;
}

export function parseBound(value, field) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) fail(`Invalid ${field}: expected a non-negative integer`);
  if (number === 0 && !UNLIMITED_FIELDS.has(field)) return 0;
  return number;
}
