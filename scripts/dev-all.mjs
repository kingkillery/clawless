#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(scriptsDir, '..');
const node = process.execPath;

const locald = spawn(node, [resolve(root, 'runner/locald.mjs')], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

const vite = spawn(node, [resolve(root, 'node_modules/vite/bin/vite.js')], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

const children = [locald, vite];
let exiting = false;

function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

for (const child of children) {
  child.on('exit', (code) => {
    const other = children.find((proc) => proc !== child);
    if (other && !other.killed) other.kill('SIGTERM');
    shutdown(code ?? 0);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}
