export class CliError extends Error {
  constructor(message, exitCode = 1, reason = 'ERROR') {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.reason = reason;
  }
}

export function fail(message, reason = 'ERROR', exitCode = 1) {
  throw new CliError(message, exitCode, reason);
}
