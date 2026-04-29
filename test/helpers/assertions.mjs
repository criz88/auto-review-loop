import assert from 'node:assert/strict';

export function assertIncludes(haystack, needle) {
  assert.ok(String(haystack).includes(needle), `Expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
}
