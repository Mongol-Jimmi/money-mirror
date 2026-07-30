import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

import { buildLlmPayload, requestReflection } from './anthropic.js';
import { detectAnomalies } from './anomalies.js';
import { parseStatement } from './csv.js';
import { importTransactions, loadState, recordFeedback } from './store.js';

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const ALLOWED_FLAGS = {
  import: new Set(['date-column', 'description-column', 'amount-column', 'date-format', 'expenses-positive']),
  status: new Set(),
  anomalies: new Set(),
  reflect: new Set(['yes']),
  label: new Set(['note']),
};

const HELP = `Money Mirror — qualitative finance reflection from your terminal

Usage:
  money-mirror import <statement.csv> [options]
  money-mirror status
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
Environment: ANTHROPIC_API_KEY, ANTHROPIC_MODEL, MONEY_MIRROR_HOME
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

function formatMoney(cents) {
  return `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toFixed(2)}`;
}

async function confirmSend() {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question('Send this payload to Anthropic? [y/N] ');
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

function printReflection(reflection, io) {
  io.write(`\n${reflection.summary}\n`);
  for (const observation of reflection.observations) {
    io.write(`\n[${observation.transactionId}] ${observation.interpretation} (${observation.confidence} confidence)\n`);
    for (const evidence of observation.evidence) io.write(`  - ${evidence}\n`);
  }
  if (reflection.questions.length > 0) {
    io.write('\nQuestions for you:\n');
    for (const question of reflection.questions) io.write(`  - ${question}\n`);
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
      io.write(`Sending ${payload.transactions.length} approved anomaly record${payload.transactions.length === 1 ? '' : 's'} to Anthropic.\n`);
    } else {
      io.write('Only the following payload will be sent to Anthropic:\n');
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
