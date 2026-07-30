#!/usr/bin/env node
// Syntax-checks every .js file under src/ and test/.
// Written in Node rather than bash so it runs on Windows shells too.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const roots = ['src', 'test'];
const repoRoot = path.join(__dirname, '..');

function collect(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return found;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      collect(full, found);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

const files = roots
  .flatMap(root => collect(path.join(repoRoot, root)))
  .sort();

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    failed += 1;
    process.stderr.write(`${path.relative(repoRoot, file)}\n${err.stderr ? err.stderr.toString() : err.message}\n`);
  }
}

if (failed > 0) {
  console.error(`${failed} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`Checked ${files.length} file(s), no syntax errors.`);
