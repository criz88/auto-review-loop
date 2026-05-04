export class CliError extends Error {
  constructor(message, exitCode = null, reason = 'ERROR') {
    super(message);
    this.name = 'CliError';
    this.reason = reason;
    const metadata = reasonMetadata(reason);
    this.exitCode = Number.isInteger(exitCode) ? exitCode : metadata.exitCode;
    this.retryable = metadata.retryable;
    this.resumable = metadata.resumable;
  }
}

export function fail(message, reason = 'ERROR', exitCode = null) {
  throw new CliError(message, exitCode, reason);
}

export function reasonMetadata(reason = 'ERROR') {
  return REASON_METADATA[reason] || REASON_METADATA.ERROR;
}

export function errorEnvelope(error, extra = {}) {
  const reason = error?.reason || 'ERROR';
  const metadata = reasonMetadata(reason);
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : metadata.exitCode;
  return {
    schemaVersion: 1,
    kind: 'prloop.error',
    ok: false,
    exitCode,
    reason,
    message: error?.message || String(error),
    retryable: Boolean(error?.retryable ?? metadata.retryable),
    resumable: Boolean(error?.resumable ?? metadata.resumable),
    ...extra
  };
}

const REASON_METADATA = Object.freeze({
  ERROR: { exitCode: 1, retryable: false, resumable: false },
  USAGE: { exitCode: 2, retryable: false, resumable: false },
  INVALID_PR: { exitCode: 2, retryable: false, resumable: false },
  INVALID_CONFIG: { exitCode: 2, retryable: false, resumable: false },
  INVALID_RUNNER: { exitCode: 2, retryable: false, resumable: false },
  MISSING_TRUSTED_ACTORS: { exitCode: 2, retryable: false, resumable: false },
  NOT_GIT_REPO: { exitCode: 3, retryable: false, resumable: false },
  BRANCH_MISMATCH: { exitCode: 3, retryable: false, resumable: false },
  DIRTY_WORKTREE: { exitCode: 3, retryable: false, resumable: true },
  GENERATED_PATH_STAGED: { exitCode: 3, retryable: false, resumable: true },
  UNSAFE_GENERATED_ROOT: { exitCode: 3, retryable: false, resumable: false },
  LOCKED: { exitCode: 4, retryable: true, resumable: true },
  GITHUB_TRANSIENT: { exitCode: 5, retryable: true, resumable: true },
  GITHUB_RATE_LIMIT: { exitCode: 5, retryable: true, resumable: true },
  GITHUB_EMPTY_RESPONSE: { exitCode: 5, retryable: true, resumable: true },
  GITHUB_INVALID_JSON: { exitCode: 5, retryable: true, resumable: true },
  GITHUB_API: { exitCode: 5, retryable: false, resumable: true },
  GITHUB_AUTH: { exitCode: 5, retryable: false, resumable: false },
  PR_NOT_FOUND: { exitCode: 5, retryable: false, resumable: false },
  PR_NOT_OPEN: { exitCode: 5, retryable: false, resumable: false },
  PR_BRANCH_MISMATCH: { exitCode: 5, retryable: false, resumable: false },
  REVIEW_TIMEOUT: { exitCode: 1, retryable: true, resumable: true },
  ACK_TIMEOUT: { exitCode: 1, retryable: true, resumable: true },
  ACK_DELETE_FAILED: { exitCode: 5, retryable: true, resumable: true },
  MAX_ROUNDS: { exitCode: 1, retryable: false, resumable: false },
  MAX_RUNNER_FAILURES: { exitCode: 1, retryable: false, resumable: false },
  RUNNER_FAILED: { exitCode: 1, retryable: true, resumable: true },
  RUNNER_RESULT_INVALID: { exitCode: 1, retryable: false, resumable: true },
  NO_FIX_PRODUCED: { exitCode: 1, retryable: false, resumable: true },
  RUNNER_COMMIT_FORBIDDEN: { exitCode: 3, retryable: false, resumable: true },
  GIT_CONTROL_TAMPERED: { exitCode: 3, retryable: false, resumable: false },
  GIT_CONTROL_UNAVAILABLE: { exitCode: 3, retryable: false, resumable: false },
  REMOTE_HEAD_DRIFT: { exitCode: 5, retryable: false, resumable: false },
  RESUME_NOT_FOUND: { exitCode: 2, retryable: false, resumable: false },
  RESUME_MISMATCH: { exitCode: 2, retryable: false, resumable: false },
  RESUME_FIXING_RECONCILIATION: { exitCode: 3, retryable: false, resumable: false },
  RESUME_LOCAL_HEAD_DRIFT: { exitCode: 3, retryable: false, resumable: false }
});
