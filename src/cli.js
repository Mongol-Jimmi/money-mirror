import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

import { buildLlmPayload, requestReflection } from './claude.js';
import { detectAnomalies } from './anomalies.js';
import {
  addRecurring,
  buildDashboard,
  categorizeTransaction,
  formatMoney,
  setEnvelope,
} from './budget.js';
import { parseStatement } from './csv.js';
import { importTransactions, loadState, recordFeedback } from './store.js';

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const ALLOWED_FLAGS = {
  import: new Set(['date-column', 'description-column', 'amount-column', 'date-format', 'expenses-positive']),
  status: new Set(),
  anomalies: new Set(),
  transactions: new Set(['month']),
  dashboard: new Set(['month']),
  category: new Set(),
  budget: new Set(),
  recurring: new Set(['category']),
  reflect: new Set(['yes']),
  label: new Set(['note']),
};

const HELP = `Money Mirror — qualitative finance reflection from your terminal

Usage:
  money-mirror import <statement.csv> [options]
  money-mirror status
  money-mirror transactions [--month YYYY-MM]
  money-mirror dashboard [--month YYYY-MM]
  money-mirror category <transaction-id> <category>
  money-mirror budget set <category> <amount>
  money-mirror recurring add <name> <amount> <due-day> [--category <category>]
  money-mirror anomalies
  money-mirror reflect [--yes]
  money-mirror label <transaction-id> <label> [--note "..."]

Import options:
  --date-column <name>          Override the date column
  --description-column <name>   Override the description column
  --amount-column <name>        Override the amount column
  --date-format <mdy|dmy>       Required for slash-formatted dates
  --expenses-positive           Treat positive CSV amounts as expenses

Labels: expected, necessary, treat, regret, ignore
Environment: CLAUDE_MODEL, MONEY_MIRROR_CLAUDE_BIN, MONEY_MIRROR_HOME
`;

function parseArguments(args) {
  const positional = [];
  const flags = {};
  const booleanFlags = new Set(['expenses-positive', 'yes']);

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }

    const name = value.slice(2);
    if (booleanFlags.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Flag --${name} requires a value.`);
    flags[name] = next;
    index += 1;
  }
  return { positional, flags };
}

function validateFlags(command, flags) {
  const allowed = ALLOWED_FLAGS[command];
  if (!allowed) return;
  const unknown = Object.keys(flags).find((flag) => !allowed.has(flag));
  if (unknown) throw new Error(`Unknown flag --${unknown} for ${command}.`);
  if (flags['date-format'] && !['mdy', 'dmy'].includes(flags['date-format'])) {
    throw new Error('--date-format must be mdy or dmy.');
  }
}

function anomaliesFor(state) {
  if (!state.ledger.latestBatchId) return [];
  return detectAnomalies(
    state.ledger.transactions,
    state.ledger.latestBatchId,
    state.feedback,
  );
}

async function confirmSend() {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question('Send this payload through Claude CLI? [y/N] ');
  prompt.close();
  return /^y(?:es)?$/i.test(answer.trim());
}

function printAnomalies(anomalies, io) {
  if (anomalies.length === 0) {
    io.write('No irregular transactions found in the latest import.\n');
    return;
  }
  for (const anomaly of anomalies) {
    const signals = anomaly.signals.map((signal) => signal.type).join(', ');
    io.write(`[${anomaly.transactionId}] ${anomaly.date} ${formatMoney(anomaly.amountCents)} ${anomaly.merchant} — ${signals}\n`);
  }
}

function printTransactions(state, requestedMonth, io) {
  const month = buildDashboard(state, requestedMonth).month;
  const transactions = state.ledger.transactions
    .filter((transaction) => transaction.date.startsWith(month))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (transactions.length === 0) {
    io.write(`No transactions found for ${month}.\n`);
    return;
  }
  for (const transaction of transactions) {
    const category = Object.hasOwn(state.budget.merchantCategories, transaction.merchant)
      ? state.budget.merchantCategories[transaction.merchant]
      : 'uncategorized';
    io.write(`[${transaction.id}] ${transaction.date} ${formatMoney(transaction.amountCents)} ${terminalSafe(transaction.merchant)} [${terminalSafe(category)}]\n`);
  }
}

function printDashboard(dashboard, irregularityCount, io) {
  io.write(`Money Mirror dashboard - ${dashboard.month}\n`);
  io.write(`Income: ${formatMoney(dashboard.incomeCents)}\n`);
  io.write(`Spending: ${formatMoney(dashboard.spendingCents)}\n`);
  io.write(`Net cash flow: ${formatMoney(dashboard.netCents)}\n`);
  io.write(`Planned: ${formatMoney(dashboard.plannedCents)}\n`);
  io.write(`Unassigned income: ${formatMoney(dashboard.unassignedCents)}\n`);
  io.write('Envelopes:\n');
  if (dashboard.categories.length === 0) io.write('  No envelopes configured.\n');
  for (const category of dashboard.categories) {
    io.write(`  ${terminalSafe(category.category)}: ${formatMoney(category.spentCents)} / ${formatMoney(category.budgetCents)} (${formatMoney(category.remainingCents)} remaining)\n`);
  }
  io.write(`Uncategorized: ${formatMoney(dashboard.uncategorizedCents)}\n`);
  io.write('Recurring obligations:\n');
  if (dashboard.recurring.length === 0) io.write('  None configured.\n');
  for (const recurring of dashboard.recurring) {
    io.write(`  ${terminalSafe(recurring.name)}: ${formatMoney(recurring.amountCents)} due day ${recurring.dueDay} [${terminalSafe(recurring.category)}]\n`);
  }
  io.write(`Latest irregularities: ${irregularityCount}\n`);
}

function terminalSafe(value) {
  return String(value).replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  );
}

function printReflection(reflection, io) {
  io.write(`\n${terminalSafe(reflection.summary)}\n`);
  for (const observation of reflection.observations) {
    io.write(`\n[${terminalSafe(observation.transactionId)}] ${terminalSafe(observation.interpretation)} (${terminalSafe(observation.confidence)} confidence)\n`);
    for (const evidence of observation.evidence) io.write(`  - ${terminalSafe(evidence)}\n`);
  }
  if (reflection.questions.length > 0) {
    io.write('\nQuestions for you:\n');
    for (const question of reflection.questions) io.write(`  - ${terminalSafe(question)}\n`);
  }
}

export async function run(args, io = process.stdout, options = {}) {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.write(HELP);
    return 0;
  }

  const { positional, flags } = parseArguments(rest);
  validateFlags(command, flags);
  const home = options.home;

  if (command === 'import') {
    const [filePath] = positional;
    if (!filePath) throw new Error('Import requires a CSV file path.');
    if ((await stat(filePath)).size > MAX_CSV_BYTES) {
      throw new Error('CSV exceeds the 10 MB file-size limit.');
    }
    const csvText = await readFile(filePath, 'utf8');
    const transactions = parseStatement(csvText, {
      dateColumn: flags['date-column'],
      descriptionColumn: flags['description-column'],
      amountColumn: flags['amount-column'],
      dateFormat: flags['date-format'],
      expensesPositive: flags['expenses-positive'] === true,
    });
    const result = await importTransactions(transactions, home);
    io.write(`Imported ${result.added} new transaction${result.added === 1 ? '' : 's'} locally.\n`);
    return 0;
  }

  if (command === 'status') {
    const state = await loadState(home);
    io.write(`Transactions: ${state.ledger.transactions.length}\n`);
    io.write(`Learned merchant patterns: ${Object.keys(state.feedback).length}\n`);
    io.write(`Budget envelopes: ${Object.keys(state.budget.envelopes).length}\n`);
    io.write(`Recurring obligations: ${Object.keys(state.budget.recurring).length}\n`);
    return 0;
  }

  if (command === 'transactions') {
    printTransactions(await loadState(home), flags.month, io);
    return 0;
  }

  if (command === 'dashboard') {
    const state = await loadState(home);
    printDashboard(buildDashboard(state, flags.month), anomaliesFor(state).length, io);
    return 0;
  }

  if (command === 'category') {
    const [idPrefix, category] = positional;
    if (!idPrefix || !category) throw new Error('Category requires a transaction ID and category.');
    const learned = await categorizeTransaction(idPrefix, category, home);
    io.write(`Learned ${learned.category} for ${learned.transaction.merchant}.\n`);
    return 0;
  }

  if (command === 'budget') {
    const [action, category, amount] = positional;
    if (action !== 'set' || !category || !amount) {
      throw new Error('Usage: money-mirror budget set <category> <amount>.');
    }
    const envelope = await setEnvelope(category, amount, home);
    io.write(`Budgeted ${formatMoney(envelope.amountCents)} for ${envelope.category}.\n`);
    return 0;
  }

  if (command === 'recurring') {
    const [action, name, amount, dueDay] = positional;
    if (action !== 'add' || !name || !amount || !dueDay) {
      throw new Error('Usage: money-mirror recurring add <name> <amount> <due-day>.');
    }
    const recurring = await addRecurring(name, amount, dueDay, flags.category, home);
    io.write(`Saved ${terminalSafe(recurring.name)}: ${formatMoney(recurring.amountCents)} due day ${recurring.dueDay}.\n`);
    return 0;
  }

  if (command === 'anomalies') {
    printAnomalies(anomaliesFor(await loadState(home)), io);
    return 0;
  }

  if (command === 'label') {
    const [idPrefix, label] = positional;
    if (!idPrefix || !label) throw new Error('Label requires a transaction ID and label.');
    const transaction = await recordFeedback(idPrefix, label, flags.note ?? '', home);
    io.write(`Learned ${label} for ${transaction.merchant}.\n`);
    return 0;
  }

  if (command === 'reflect') {
    const anomalies = anomaliesFor(await loadState(home));
    if (anomalies.length === 0) {
      printAnomalies(anomalies, io);
      return 0;
    }

    const payload = buildLlmPayload(anomalies);
    if (flags.yes === true) {
      io.write(`Sending ${payload.transactions.length} approved anomaly record${payload.transactions.length === 1 ? '' : 's'} through Claude CLI.\n`);
    } else {
      io.write('Only the following payload will be sent through Claude CLI:\n');
      io.write(`${JSON.stringify(payload, null, 2)}\n`);
    }
    const approved = flags.yes === true || await (options.confirm ?? confirmSend)();
    if (!approved) {
      io.write('Cancelled; nothing was sent.\n');
      return 0;
    }

    const reflection = await (options.reflector ?? requestReflection)(anomalies);
    printReflection(reflection, io);
    return 0;
  }

  io.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}
