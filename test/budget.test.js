import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addRecurring,
  buildDashboard,
  categorizeTransaction,
  parseMoneyToCents,
  setEnvelope,
} from '../src/budget.js';
import { importTransactions, loadState } from '../src/store.js';

const transactions = [
  { id: 'salary0000000000', date: '2026-07-01', description: 'Salary', merchant: 'salary', amountCents: 300000 },
  { id: 'market0000000000', date: '2026-07-03', description: 'Market', merchant: 'market', amountCents: -40000 },
  { id: 'coffee0000000000', date: '2026-07-04', description: 'Cafe', merchant: 'cafe', amountCents: -5000 },
];

test('parses decimal money without floating-point rounding', () => {
  assert.equal(parseMoneyToCents('123.45'), 12345);
  assert.throws(() => parseMoneyToCents('-1'), /positive/);
  assert.throws(() => parseMoneyToCents('12.345'), /amount/i);
  assert.throws(() => parseMoneyToCents('1,2,3'), /amount/i);
  assert.throws(() => parseMoneyToCents('1 2'), /amount/i);
});

test('stores envelopes, learned categories, and recurring obligations', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-budget-'));
  await importTransactions(transactions, home);

  await setEnvelope('Groceries', '500', home);
  await categorizeTransaction('market', 'Groceries', home);
  await addRecurring('Rent', '1200', '1', 'Housing', home);
  const state = await loadState(home);

  assert.equal(state.budget.envelopes.groceries, 50000);
  assert.equal(state.budget.merchantCategories.market, 'groceries');
  assert.deepEqual(state.budget.recurring.rent, {
    name: 'Rent',
    amountCents: 120000,
    dueDay: 1,
    category: 'housing',
  });
  assert.equal((await stat(path.join(home, 'budget.json'))).mode & 0o777, 0o600);
});

test('rejects alternate due-day syntax and terminal controls', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-validation-'));

  await assert.rejects(() => addRecurring('Rent', '1200', '1e1', 'housing', home), /due day/i);
  await assert.rejects(() => addRecurring('Rent', '1200', '0x10', 'housing', home), /due day/i);
  await assert.rejects(() => addRecurring(`Rent\u009bspoof`, '1200', '1', 'housing', home), /printable/i);
});

test('builds a monthly zero-based dashboard with uncategorized spending visible', () => {
  const state = {
    ledger: { transactions },
    budget: {
      envelopes: { groceries: 50000, housing: 120000 },
      merchantCategories: { market: 'groceries' },
      recurring: {
        rent: { name: 'Rent', amountCents: 120000, dueDay: 1, category: 'housing' },
      },
    },
  };

  const dashboard = buildDashboard(state, '2026-07');

  assert.equal(dashboard.incomeCents, 300000);
  assert.equal(dashboard.spendingCents, 45000);
  assert.equal(dashboard.netCents, 255000);
  assert.equal(dashboard.plannedCents, 170000);
  assert.equal(dashboard.unassignedCents, 130000);
  assert.equal(dashboard.uncategorizedCents, 5000);
  assert.deepEqual(dashboard.categories, [
    { category: 'groceries', budgetCents: 50000, spentCents: 40000, remainingCents: 10000 },
    { category: 'housing', budgetCents: 120000, spentCents: 0, remainingCents: 120000 },
  ]);
});

test('treats prototype-shaped merchant and category names as ordinary data', () => {
  const transaction = {
    id: 'constructor0000',
    date: '2026-07-01',
    description: 'constructor',
    merchant: 'constructor',
    amountCents: -100,
  };
  const dashboard = buildDashboard({
    ledger: { transactions: [transaction] },
    budget: { envelopes: {}, merchantCategories: {}, recurring: {} },
  }, '2026-07');

  assert.equal(dashboard.uncategorizedCents, 100);
  assert.deepEqual(dashboard.categories, []);

  const categorized = buildDashboard({
    ledger: { transactions: [transaction] },
    budget: {
      envelopes: { constructor: 500 },
      merchantCategories: { constructor: 'constructor' },
      recurring: {},
    },
  }, '2026-07');
  assert.deepEqual(categorized.categories, [
    { category: 'constructor', budgetCents: 500, spentCents: 100, remainingCents: 400 },
  ]);
});
