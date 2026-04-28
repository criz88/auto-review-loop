#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).catch((error) => {
  const code = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  const message = error?.message || String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
});
