import { createHash } from 'node:crypto';

import { parse } from 'csv-parse/sync';

const MAX_AMOUNT_CENTS = 100_000_000_000n;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ROWS = 50_000;

const COLUMN_CANDIDATES = {
  date: ['date', 'transaction date', 'posted date'],
  description: ['description', 'merchant', 'name', 'memo'],
  amount: ['amount', 'transaction amount'],
};

function selectColumn(headers, explicit, kind) {
  const lowerHeaders = new Map(headers.map((header) => [header.toLowerCase().trim(), header]));
  const requested = explicit ? [explicit] : COLUMN_CANDIDATES[kind];
  const match = requested.map((name) => lowerHeaders.get(name.toLowerCase().trim())).find(Boolean);

  if (!match) {
    throw new Error(`Could not find the ${kind} column. Available columns: ${headers.join(', ')}`);
  }
  return match;
}

function parseDate(value, dateFormat) {
  const clean = String(value).trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (isoMatch) return validIsoDate(clean);

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean);
  if (!slashMatch) throw new Error(`Unsupported date "${clean}". Use YYYY-MM-DD.`);
  if (!['mdy', 'dmy'].includes(dateFormat)) {
    throw new Error(`Ambiguous date "${clean}". Pass --date-format mdy or dmy.`);
  }

  const [, first, second, year] = slashMatch;
  const month = dateFormat === 'mdy' ? first : second;
  const day = dateFormat === 'mdy' ? second : first;
  return validIsoDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
}

function validIsoDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid date "${value}".`);
  }
  return value;
}

function parseAmount(value) {
  const text = String(value).trim();
  const isParenthesized = text.startsWith('(') && text.endsWith(')');
  const normalized = text.replace(/[,$£€\s()]/g, '');
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Invalid amount "${text}".`);
  }

  const [wholePart, decimalPart = ''] = normalized.replace(/^[+-]/, '').split('.');
  const absoluteCents = BigInt(wholePart) * 100n + BigInt(decimalPart.padEnd(2, '0'));
  if (absoluteCents > MAX_AMOUNT_CENTS) {
    throw new Error('Amount is outside the supported range.');
  }
  const sign = normalized.startsWith('-') || isParenthesized ? -1 : 1;
  return sign * Number(absoluteCents);
}

export function normalizeMerchant(description) {
  return String(description)
    .toLowerCase()
    .replace(/\b(?:pos|debit|purchase|card)\b/g, ' ')
    .replace(/[#*]?\d{3,}/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function transactionId(date, description, amountCents, occurrence) {
  return createHash('sha256')
    .update(`${date}\u0000${description}\u0000${amountCents}\u0000${occurrence}`)
    .digest('hex')
    .slice(0, 16);
}

export function parseStatement(csvText, options = {}) {
  const records = parse(csvText, {
    bom: true,
    columns: true,
    max_record_size: 10_000,
    skip_empty_lines: true,
    trim: true,
  });
  if (records.length === 0) return [];
  if (records.length > MAX_ROWS) throw new Error(`CSV exceeds the ${MAX_ROWS}-row limit.`);

  const headers = Object.keys(records[0]);
  const dateColumn = selectColumn(headers, options.dateColumn, 'date');
  const descriptionColumn = selectColumn(headers, options.descriptionColumn, 'description');
  const amountColumn = selectColumn(headers, options.amountColumn, 'amount');

  const occurrences = new Map();
  return records.map((record, index) => {
    try {
      const date = parseDate(record[dateColumn], options.dateFormat);
      const description = String(record[descriptionColumn]).trim();
      if (!description) throw new Error('Description is empty.');
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        throw new Error(`Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`);
      }
      const parsedAmount = parseAmount(record[amountColumn]);
      const amountCents = options.expensesPositive ? -parsedAmount : parsedAmount;
      const merchant = normalizeMerchant(description);
      if (!merchant) throw new Error('Description has no usable merchant text.');
      const occurrenceKey = `${date}\u0000${description}\u0000${amountCents}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);

      return {
        id: transactionId(date, description, amountCents, occurrence),
        date,
        description,
        merchant,
        amountCents,
      };
    } catch (error) {
      throw new Error(`CSV row ${index + 2}: ${error.message}`);
    }
  });
}
