import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStatement } from '../src/csv.js';

test('parses quoted transactions and normalizes expenses to integer cents', () => {
  const rows = parseStatement(
    'Date,Description,Amount\n2026-07-01,"CAFE, CENTRAL",-12.34\n2026-07-02,Salary,"$1,500.00"\n',
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].amountCents, -1234);
  assert.equal(rows[0].merchant, 'cafe central');
  assert.equal(rows[1].amountCents, 150000);
  assert.match(rows[0].id, /^[a-f0-9]{16}$/);
});

test('requires an explicit format for ambiguous slash dates', () => {
  assert.throws(
    () => parseStatement('Date,Description,Amount\n01/02/2026,Cafe,-5\n'),
    /date-format/,
  );

  const [row] = parseStatement(
    'Date,Description,Amount\n01/02/2026,Cafe,-5\n',
    { dateFormat: 'mdy' },
  );
  assert.equal(row.date, '2026-01-02');
});

test('supports explicit column names and positive-expense exports', () => {
  const [row] = parseStatement(
    'Posted,Memo,Debit\n2026-07-01,Book Shop,42.10\n',
    {
      dateColumn: 'Posted',
      descriptionColumn: 'Memo',
      amountColumn: 'Debit',
      expensesPositive: true,
    },
  );

  assert.equal(row.amountCents, -4210);
  assert.equal(row.merchant, 'book shop');
});

test('preserves identical same-day purchases as separate stable occurrences', () => {
  const csv = 'Date,Description,Amount\n2026-07-01,Same Shop,-60\n2026-07-01,Same Shop,-60\n';
  const first = parseStatement(csv);
  const second = parseStatement(csv);

  assert.notEqual(first[0].id, first[1].id);
  assert.deepEqual(first.map((row) => row.id), second.map((row) => row.id));
});

test('rejects missing columns, invalid money, and unsafe amounts', () => {
  assert.throws(
    () => parseStatement('When,Who,Value\n2026-07-01,Cafe,nope\n'),
    /date column/i,
  );
  assert.throws(
    () => parseStatement('Date,Description,Amount\n2026-07-01,Cafe,nope\n'),
    /invalid amount/i,
  );
  assert.throws(
    () => parseStatement('Date,Description,Amount\n2026-07-01,Cafe,999999999999999999999\n'),
    /supported range/i,
  );
});
