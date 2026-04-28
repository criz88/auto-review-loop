import { spawn } from 'node:child_process';

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;

export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    input = '',
    timeoutMs = 0,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    allowFailure = false
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs) : null;

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk, outputLimit);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk, outputLimit);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      const result = { command, args, cwd, code, signal, stdout, stderr, timedOut };
      if (!allowFailure && (code !== 0 || timedOut)) {
        reject(Object.assign(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout || signal || code}`), { result }));
      } else {
        resolve(result);
      }
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function appendLimited(current, chunk, limit) {
  const next = current + chunk.toString('utf8');
  if (next.length <= limit) return next;
  const extra = next.length - limit;
  return `${next.slice(0, limit)}\n[truncated ${extra} bytes]`;
}
