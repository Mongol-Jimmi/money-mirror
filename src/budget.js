import { loadState, updateBudgetSettings } from './store.js';

const MAX_AMOUNT_CENTS = 100_000_000_000n;

function normalizeCategory(value) {
  const category = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^[a-z0-9][a-z0-9 -]{0,49}$/.test(category)) {
    throw new Error('Category must be 1-50 letters, numbers, spaces, or hyphens.');
  }
  return category;
}

export function formatMoney(cents) {
  return `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function parseMoneyToCents(value) {
  const input = String(value).trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(input)) {
    throw new Error('Amount must be a positive number with at most two decimal places.');
  }
  const [whole, decimals = ''] = input.replaceAll(',', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0'));
  if (cents <= 0n) throw new Error('Amount must be positive.');
  if (cents > MAX_AMOUNT_CENTS) throw new Error('Amount is outside the supported range.');
  return Number(cents);
}

export async function setEnvelope(categoryInput, amount, home) {
  const category = normalizeCategory(categoryInput);
  const amountCents = parseMoneyToCents(amount);
  await updateBudgetSettings((budget) => ({
    ...budget,
    envelopes: { ...budget.envelopes, [category]: amountCents },
  }), home);
  return { category, amountCents };
}

export async function categorizeTransaction(idPrefix, categoryInput, home) {
  const category = normalizeCategory(categoryInput);
  const { ledger } = await loadState(home);
  const matches = ledger.transactions.filter((transaction) => transaction.id.startsWith(idPrefix));
  if (matches.length === 0) throw new Error(`No transaction matches "${idPrefix}".`);
  if (matches.length > 1) throw new Error(`Transaction prefix "${idPrefix}" is ambiguous.`);
  const transaction = matches[0];

  await updateBudgetSettings((budget) => ({
    ...budget,
    merchantCategories: { ...budget.merchantCategories, [transaction.merchant]: category },
  }), home);
  return { transaction, category };
}

export async function addRecurring(nameInput, amount, dueDayInput, categoryInput, home) {
  const name = String(nameInput).trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new Error('Recurring name must be 1-80 printable characters.');
  }
  const amountCents = parseMoneyToCents(amount);
  const dueDayText = String(dueDayInput).trim();
  if (!/^(?:[1-9]|[12]\d|3[01])$/.test(dueDayText)) {
    throw new Error('Recurring due day must be an integer from 1 to 31.');
  }
  const dueDay = Number(dueDayText);
  const category = normalizeCategory(categoryInput ?? 'bills');
  const key = name.toLowerCase().replace(/\s+/g, ' ');
  const recurring = { name, amountCents, dueDay, category };

  await updateBudgetSettings((budget) => ({
    ...budget,
    recurring: { ...budget.recurring, [key]: recurring },
  }), home);
  return recurring;
}

function dashboardMonth(transactions, requestedMonth) {
  if (requestedMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)) {
    throw new Error('Month must use YYYY-MM format.');
  }
  if (requestedMonth) return requestedMonth;
  const latest = transactions.map((transaction) => transaction.date.slice(0, 7)).sort().at(-1);
  return latest ?? new Date().toISOString().slice(0, 7);
}

export function buildDashboard(state, requestedMonth) {
  const month = dashboardMonth(state.ledger.transactions, requestedMonth);
  const budget = state.budget ?? { envelopes: {}, merchantCategories: {}, recurring: {} };
  const transactions = state.ledger.transactions.filter((transaction) => transaction.date.startsWith(month));
  const incomeCents = transactions
    .filter((transaction) => transaction.amountCents > 0)
    .reduce((total, transaction) => total + transaction.amountCents, 0);
  const expenses = transactions.filter((transaction) => transaction.amountCents < 0);
  const spendingCents = expenses.reduce((total, transaction) => total + Math.abs(transaction.amountCents), 0);
  const categorySpending = new Map();
  let uncategorizedCents = 0;

  for (const transaction of expenses) {
    const amount = Math.abs(transaction.amountCents);
    const category = Object.hasOwn(budget.merchantCategories, transaction.merchant)
      ? budget.merchantCategories[transaction.merchant]
      : undefined;
    if (!category) {
      uncategorizedCents += amount;
      continue;
    }
    categorySpending.set(category, (categorySpending.get(category) ?? 0) + amount);
  }

  const categoryNames = new Set([
    ...Object.keys(budget.envelopes),
    ...categorySpending.keys(),
  ]);
  const categories = [...categoryNames].sort().map((category) => {
    const budgetCents = Object.hasOwn(budget.envelopes, category) ? budget.envelopes[category] : 0;
    const spentCents = categorySpending.get(category) ?? 0;
    return { category, budgetCents, spentCents, remainingCents: budgetCents - spentCents };
  });
  const plannedCents = Object.values(budget.envelopes).reduce((total, amount) => total + amount, 0);

  return {
    month,
    incomeCents,
    spendingCents,
    netCents: incomeCents - spendingCents,
    plannedCents,
    unassignedCents: incomeCents - plannedCents,
    uncategorizedCents,
    categories,
    recurring: Object.values(budget.recurring).sort((a, b) => a.dueDay - b.dueDay),
  };
}
