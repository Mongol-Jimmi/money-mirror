import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { importTransactions, loadState, recordFeedback } from '../src/store.js';

const execFileAsync = promisify(execFile);

const sample = {
  id: 'abc1234567890000',
  date: '2026-07-01',
  description: 'Cafe',
  merchant: 'cafe',
  amountCents: -500,
};

test('stores local transactions, deduplicates imports, and learns feedback', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-'));

  const first = await importTransactions([sample], home);
  const second = await importTransactions([sample], home);
  await recordFeedback('abc123', 'expected', 'Weekly visit', home);
  const state = await loadState(home);

  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(state.ledger.transactions.length, 1);
  assert.deepEqual(state.feedback.cafe, {
    label: 'expected',
    note: 'Weekly visit',
  });
  assert.equal((await stat(path.join(home, 'ledger.json'))).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path.join(home, 'feedback.json'), 'utf8'), /undefined/);
});

test('serializes concurrent imports without losing transactions', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-concurrent-'));
  const second = { ...sample, id: 'def1234567890000', merchant: 'book shop' };

  await Promise.all([
    importTransactions([sample], home),
    importTransactions([second], home),
  ]);

  const state = await loadState(home);
  assert.deepEqual(
    state.ledger.transactions.map((transaction) => transaction.id).sort(),
    [sample.id, second.id].sort(),
  );
});

test('serializes concurrent child-process imports', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-processes-'));
  const storeUrl = new URL('../src/store.js', import.meta.url).href;
  const script = `
    import { importTransactions } from ${JSON.stringify(storeUrl)};
    await importTransactions([{
      id: process.env.TX_ID,
      date: '2026-07-01',
      description: process.env.TX_ID,
      merchant: process.env.TX_ID,
      amountCents: -500,
    }], process.env.DATA_HOME);
  `;

  await Promise.all(Array.from({ length: 25 }, (_, index) => execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { env: { ...process.env, DATA_HOME: home, TX_ID: `tx-${index}` } },
  )));

  assert.equal((await loadState(home)).ledger.transactions.length, 25);
});

test('refuses to store finance data inside a Git worktree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-git-'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  await assert.rejects(
    () => importTransactions([sample], path.join(root, 'private-data')),
    /Git worktree/,
  );
});

test('refuses a symlinked home that targets a Git worktree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-symlink-'));
  const worktree = path.join(root, 'worktree');
  const target = path.join(worktree, 'private-data');
  await mkdir(path.join(worktree, '.git'), { recursive: true });
  await writeFile(path.join(worktree, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(target);
  const alias = path.join(root, 'alias');
  await symlink(target, alias, 'dir');

  await assert.rejects(() => importTransactions([sample], alias), /Git worktree/);
});

test('rejects ambiguous transaction prefixes and unknown labels', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-'));
  await importTransactions([
    sample,
    { ...sample, id: 'abc9999999999999', description: 'Shop', merchant: 'shop' },
  ], home);

  await assert.rejects(() => recordFeedback('abc', 'expected', '', home), /ambiguous/i);
  await assert.rejects(() => recordFeedback('abc123', 'mystery', '', home), /label/i);
});
