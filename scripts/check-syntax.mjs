import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const roots = ['bin', 'scripts', 'src', 'test'];
const files = [];

async function collect(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    if (entry.isFile() && path.endsWith('.mjs')) files.push(path);
  }
}

for (const root of roots) await collect(root);

for (const file of files) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Syntax check failed for ${file}`));
    });
  });
}

console.log(`Syntax OK (${files.length} files)`);
