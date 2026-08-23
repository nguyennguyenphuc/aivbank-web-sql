#!/usr/bin/env node
/*
 * Codex requires every Stop hook invocation to return a JSON object. The
 * Impeccable hook is intentionally silent for a clean deep pass, so this
 * adapter preserves its JSON payload when present and emits an empty object
 * when the detector has nothing to report.
 */

import { spawn } from 'node:child_process';

const input = await new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve('');
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const child = spawn(process.execPath, ['.agents/skills/impeccable/scripts/hook.mjs'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

const output = [];
child.stdout.on('data', (chunk) => output.push(chunk));
child.stdin.end(input);

child.on('close', (code) => {
  const raw = Buffer.concat(output).toString('utf8').trim();
  if (!raw) {
    process.stdout.write('{}\n');
  } else {
    try {
      JSON.parse(raw);
      process.stdout.write(`${raw}\n`);
    } catch {
      process.stdout.write('{}\n');
    }
  }
  process.exit(code || 0);
});
