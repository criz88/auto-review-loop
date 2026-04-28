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
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runProcess('gh', ['api', ...args], {
        cwd: this.cwd,
        env: this.env,
        allowFailure: true,
        timeoutMs: options.timeoutMs || 30_000,
        input: options.input || ''
      });
      if (result.code === 0) {
        const body = result.stdout.trim();
        if (!body) return null;
        try {
          return JSON.parse(body);
        } catch (error) {
          fail(`GitHub API returned invalid JSON: ${error.message}`, 'GITHUB_INVALID_JSON');
        }
      }
      const message = result.stderr || result.stdout || `gh exited ${result.code}`;
      const reason = classifyGhFailure(message);
      if (reason === 'GITHUB_RATE_LIMIT' && attempt < maxAttempts) {
        const delayMs = retryDelayMs(message, attempt);
        await this.logger?.event('github_backoff', { attempt, delayMs, reason, args });
        await sleep(delayMs);
        continue;
      }
      fail(`GitHub API failed: ${message.trim()}`, reason);
    }
  }

  getPull() {
    return this.api([`repos/${this.fullName}/pulls/${this.number}`]);
  }

  createIssueComment(body) {
    return this.api([
      `repos/${this.fullName}/issues/${this.number}/comments`,
      '-f',
      `body=${body}`
    ]);
  }

  deleteIssueComment(commentId) {
    return this.api([
      '-X',
      'DELETE',
      `repos/${this.fullName}/issues/comments/${commentId}`
    ]);
  }

  listIssueComments() {
    return this.api([
      `repos/${this.fullName}/issues/${this.number}/comments`,
      '--paginate'
    ]).then((value) => value || []);
  }

  listPullReviews() {
    return this.api([
      `repos/${this.fullName}/pulls/${this.number}/reviews`,
      '--paginate'
    ]).then((value) => value || []);
  }

  listPullReviewComments() {
    return this.api([
      `repos/${this.fullName}/pulls/${this.number}/comments`,
      '--paginate'
    ]).then((value) => value || []);
  }

  listIssueCommentReactions(commentId) {
    return this.api([
      `repos/${this.fullName}/issues/comments/${commentId}/reactions`,
      '-H',
      'Accept: application/vnd.github+json',
      '--paginate'
    ]).then((value) => value || []);
  }
}

function classifyGhFailure(message) {
  if (/rate limit|429|403/i.test(message)) return 'GITHUB_RATE_LIMIT';
  if (/auth|credential|401/i.test(message)) return 'GITHUB_AUTH';
  return 'GITHUB_API';
}

function retryDelayMs(message, attempt) {
  const retryAfter = /retry-after:\s*([0-9]+)/i.exec(message);
  if (retryAfter) return Number(retryAfter[1]) * 1000;
  return Math.min(1000 * 2 ** (attempt - 1), 5000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
