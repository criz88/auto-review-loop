import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /glpat-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /(authorization:\s*bearer\s+)[^\s]+/gi,
  /(token=)[^&\s]+/gi,
  /(password=)[^&\s]+/gi,
  /(secret=)[^&\s]+/gi,
  /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi
];

const SECRET_KEYS = /^(authorization|cookie|token|access[_-]?token|secret|password|passwd|api[_-]?key|client[_-]?secret)$/i;

export class Logger {
  constructor(root) {
    this.root = root;
    this.path = join(root, `${new Date().toISOString().slice(0, 10)}.ndjson`);
  }

  async event(type, payload = {}) {
    await mkdir(this.root, { recursive: true });
    const entry = redactObject({
      ts: new Date().toISOString(),
      type,
      ...payload
    });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
  }
}

function redactObject(value, key = '') {
  if (SECRET_KEYS.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redactObject(item, childKey)]));
  }
  return value;
}

export function redact(text) {
  let result = String(text);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (...args) => {
      const [match, prefix] = args;
      if (String(match).startsWith('http')) return `${typeof prefix === 'string' ? prefix : ''}[REDACTED]@`;
      return typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }
  if (result.length > 4000) return `${result.slice(0, 4000)}...[truncated ${result.length - 4000} chars]`;
  return result;
}
