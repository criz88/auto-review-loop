#!/usr/bin/env node
import { main } from '../src/cli.mjs';
import { errorEnvelope } from '../src/errors.mjs';

main(process.argv.slice(2)).catch((error) => {
  const code = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  if (process.argv.slice(2).includes('--json')) {
    process.stderr.write(`${JSON.stringify(errorEnvelope(error))}\n`);
  } else {
    const message = error?.message || String(error);
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = code;
});
