#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const forbidden = tracked.filter((file) => {
  const name = path.basename(file);
  if (name === 'ledger.json' || name === 'feedback.json') return true;
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  return file.toLowerCase().endsWith('.csv') && file !== 'demo/statement.csv';
});

const secretPattern = /sk-ant-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const secretFiles = tracked.filter((file) => {
  try {
    return secretPattern.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
});

if (forbidden.length || secretFiles.length) {
  if (forbidden.length) console.error(`Sensitive file paths are tracked:\n${forbidden.join('\n')}`);
  if (secretFiles.length) console.error(`Possible secrets found in:\n${secretFiles.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Security check passed: no tracked finance state, private CSV, environment file, or obvious secret.');
}
