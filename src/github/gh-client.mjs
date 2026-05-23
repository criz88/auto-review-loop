import { runProcess } from '../subprocess.mjs';
import { fail } from '../errors.mjs';

export class GhClient {
  constructor({ cwd, env = process.env, owner, repo, number, logger = null }) {
    this.cwd = cwd;
    this.env = env;
    this.owner = owner;
    this.repo = repo;
    this.number = number;
    this.fullName = `${owner}/${repo}`;
    this.logger = logger;
  }

  async api(args, options = {}) {
    const maxAttempts = options.maxAttempts || 3;
    const retryTransient = options.retryTransient === true;
    const metadata = githubOperationMetadata(args, options);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runProcess('gh', ['api', ...args], {
        cwd: this.cwd,
        env: this.env,
        allowFailure: true,
        timeoutMs: options.timeoutMs || 30_000,
        outputLimit: options.outputLimit ?? null,
        input: options.input || ''
      });
      if (result.code === 0) {
        const body = result.stdout.trim();
        if (!body) {
          if (options.allowEmptySuccess) return null;
          const reason = 'GITHUB_EMPTY_RESPONSE';
          if (retryTransient && attempt < maxAttempts) {
            await this.backoff({ attempt, reason, message: 'empty response', metadata, delayOverrideMs: options.retryDelayMs });
            continue;
          }
          fail(`GitHub API returned empty response for ${metadata.operation}`, reason);
        }
        try {
          return JSON.parse(body);
        } catch (error) {
          const reason = 'GITHUB_INVALID_JSON';
          if (retryTransient && attempt < maxAttempts) {
            await this.backoff({ attempt, reason, message: error.message, metadata, delayOverrideMs: options.retryDelayMs });
            continue;
          }
          fail(`GitHub API returned invalid JSON for ${metadata.operation}: ${error.message}`, reason);
        }
      }
      const message = result.stderr || result.stdout || result.signal || `gh exited ${result.code}`;
      const reason = classifyGhFailure(message, result);
      if (shouldRetry({ reason, retryTransient }) && attempt < maxAttempts) {
        await this.backoff({ attempt, reason, message, metadata, delayOverrideMs: options.retryDelayMs });
        continue;
      }
      fail(`GitHub API failed: ${message.trim()}`, reason);
    }
  }

  async backoff({ attempt, reason, message, metadata, delayOverrideMs = null }) {
    const delayMs = delayOverrideMs ?? retryDelayMs(message, attempt);
    await this.logger?.event('github_backoff', { ...metadata, attempt, delayMs, reason });
    await sleep(delayMs);
  }

  getPull() {
    return this.api([`repos/${this.fullName}/pulls/${this.number}`], {
      operation: 'getPull',
      retryTransient: true
    });
  }

  createIssueComment(body) {
    return this.api([
      `repos/${this.fullName}/issues/${this.number}/comments`,
      '-f',
      `body=${body}`
    ], {
      operation: 'createIssueComment',
      method: 'POST',
      retryTransient: false
    });
  }

  deleteIssueComment(commentId) {
    return this.api([
      '-X',
      'DELETE',
      `repos/${this.fullName}/issues/comments/${commentId}`
    ], {
      operation: 'deleteIssueComment',
      method: 'DELETE',
      allowEmptySuccess: true,
      retryTransient: false
    });
  }

  listIssueComments() {
    return this.api([
      `repos/${this.fullName}/issues/${this.number}/comments`,
      '--paginate',
      '--slurp'
    ], {
      operation: 'listIssueComments',
      retryTransient: true
    }).then(normalizePaginatedList);
  }

  listPullReviews() {
    return this.api([
      `repos/${this.fullName}/pulls/${this.number}/reviews`,
      '--paginate',
      '--slurp'
    ], {
      operation: 'listPullReviews',
      retryTransient: true
    }).then(normalizePaginatedList);
  }

  listPullReviewComments() {
    return this.api([
      `repos/${this.fullName}/pulls/${this.number}/comments`,
      '--paginate',
      '--slurp'
    ], {
      operation: 'listPullReviewComments',
      retryTransient: true
    }).then(normalizePaginatedList);
  }

  listIssueCommentReactions(commentId) {
    return this.api([
      `repos/${this.fullName}/issues/comments/${commentId}/reactions`,
      '-H',
      'Accept: application/vnd.github+json',
      '--paginate',
      '--slurp'
    ], {
      operation: 'listIssueCommentReactions',
      retryTransient: true
    }).then(normalizePaginatedList);
  }
}

function normalizePaginatedList(value) {
  if (!value) return [];
  if (!Array.isArray(value)) return [value];
  if (value.every((page) => Array.isArray(page))) return value.flat();
  return value;
}

function classifyGhFailure(message, result = {}) {
  if (result.timedOut) return 'GITHUB_TRANSIENT';
  if (/auth|credential|401/i.test(message)) return 'GITHUB_AUTH';
  if (/rate limit|429|403/i.test(message)) return 'GITHUB_RATE_LIMIT';
  if (isTransientGhFailure(message)) return 'GITHUB_TRANSIENT';
  return 'GITHUB_API';
}

function shouldRetry({ reason, retryTransient }) {
  if (reason === 'GITHUB_RATE_LIMIT') return true;
  return retryTransient && reason === 'GITHUB_TRANSIENT';
}

function isTransientGhFailure(message) {
  return /eof|ECONNRESET|socket hang up|timed?\s*out|bad gateway|service unavailable|\b50[234]\b/i.test(message);
}

function githubOperationMetadata(args, options) {
  return {
    operation: options.operation || 'api',
    method: options.method || inferMethod(args),
    path: args.find((arg) => arg.startsWith('repos/')) || ''
  };
}

function inferMethod(args) {
  const explicit = args[args.indexOf('-X') + 1];
  if (args.includes('-X') && explicit) return explicit;
  if (args.some((arg) => arg.startsWith('body='))) return 'POST';
  return 'GET';
}

function retryDelayMs(message, attempt) {
  const retryAfter = /retry-after:\s*([0-9]+)/i.exec(message);
  if (retryAfter) return Number(retryAfter[1]) * 1000;
  return Math.min(1000 * 2 ** (attempt - 1), 5000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
