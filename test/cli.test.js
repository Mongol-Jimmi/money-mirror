import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/cli.js';

function capture() {
  let output = '';
  return {
    io: { write: (value) => { output += value; } },
    text: () => output,
  };
}

test('runs the import, status, anomalies, and label journey', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-cli-'));
  const dataHome = path.join(root, 'data');
  const csvPath = path.join(root, 'statement.csv');
  await writeFile(csvPath, 'Date,Description,Amount\n2026-07-01,Camera Shop,-900\n');

  const imported = capture();
  assert.equal(await run(['import', csvPath], imported.io, { home: dataHome }), 0);
  assert.match(imported.text(), /Imported 1 new transaction/);

  const status = capture();
  await run(['status'], status.io, { home: dataHome });
  assert.match(status.text(), /Transactions: 1/);

  const anomalies = capture();
  await run(['anomalies'], anomalies.io, { home: dataHome });
  assert.match(anomalies.text(), /-900.00/);
  assert.doesNotMatch(anomalies.text(), /\$/);
  assert.match(anomalies.text(), /new-merchant/);
  const id = anomalies.text().match(/\[([a-f0-9]+)\]/)[1];

  const labelled = capture();
  await run(['label', id, 'expected', '--note', 'Planned purchase'], labelled.io, { home: dataHome });
  assert.match(labelled.text(), /Learned expected/);
});

test('runs the budgeting, categorization, recurring, and dashboard journey', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-dashboard-'));
  const dataHome = path.join(root, 'data');
  const csvPath = path.join(root, 'statement.csv');
  await writeFile(
    csvPath,
    'Date,Description,Amount\n2026-07-01,Salary,3000\n2026-07-03,Market,-400\n2026-07-04,Cafe,-50\n',
  );
  await run(['import', csvPath], capture().io, { home: dataHome });

  const listed = capture();
  await run(['transactions', '--month', '2026-07'], listed.io, { home: dataHome });
  const marketId = listed.text().match(/\[([a-f0-9]+)\].*market/i)[1];

  await run(['category', marketId, 'Groceries'], capture().io, { home: dataHome });
  await run(['budget', 'set', 'Groceries', '500'], capture().io, { home: dataHome });
  await run(['recurring', 'add', 'Rent', '1200', '1', '--category', 'Housing'], capture().io, { home: dataHome });

  const dashboard = capture();
  await run(['dashboard', '--month', '2026-07'], dashboard.io, { home: dataHome });
  assert.match(dashboard.text(), /Income: 3000.00/);
  assert.match(dashboard.text(), /Spending: 450.00/);
  assert.match(dashboard.text(), /groceries: 400.00 \/ 500.00/);
  assert.match(dashboard.text(), /Uncategorized: 50.00/);
  assert.match(dashboard.text(), /Rent: 1200.00 due day 1/);
});

test('lists prototype-shaped merchants as uncategorized', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-prototype-'));
  const dataHome = path.join(root, 'data');
  const csvPath = path.join(root, 'statement.csv');
  await writeFile(csvPath, 'Date,Description,Amount\n2026-07-01,constructor,-5\n');
  await run(['import', csvPath], capture().io, { home: dataHome });

  const listed = capture();
  await run(['transactions'], listed.io, { home: dataHome });
  assert.match(listed.text(), /constructor \[uncategorized\]/);
});

test('previews Claude data, requires approval, and prints structured reflection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-reflect-'));
  const dataHome = path.join(root, 'data');
  const csvPath = path.join(root, 'statement.csv');
  await writeFile(csvPath, 'Date,Description,Amount\n2026-07-01,Camera Shop,-900\n');
  await run(['import', csvPath], capture().io, { home: dataHome });

  const cancelled = capture();
  await run(['reflect'], cancelled.io, { home: dataHome, confirm: async () => false });
  assert.match(cancelled.text(), /Only the following payload/);
  assert.match(cancelled.text(), /Cancelled; nothing was sent/);

  const reflected = capture();
  const reflector = async () => ({
    summary: 'One \u001b[2Junfamiliar purchase appeared.',
    observations: [{
      transactionId: 'sample-id',
      interpretation: 'This differs from prior activity.',
      confidence: 'low',
      evidence: ['First observed merchant'],
    }],
    questions: ['Was this planned?'],
  });
  await run(['reflect', '--yes'], reflected.io, { home: dataHome, reflector });
  assert.doesNotMatch(reflected.text(), /camera shop|\u001b/);
  assert.match(reflected.text(), /One \\u001b\[2Junfamiliar purchase appeared/);
  assert.match(reflected.text(), /First observed merchant/);
  assert.match(reflected.text(), /Was this planned/);
});

test('rejects unknown flags and invalid date formats', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-flags-'));
  const csvPath = path.join(root, 'statement.csv');
  await writeFile(csvPath, 'Date,Description,Amount\n2026-07-01,Cafe,-5\n');

  await assert.rejects(
    () => run(['import', csvPath, '--surprise', 'yes'], capture().io, { home: path.join(root, 'data') }),
    /Unknown flag/,
  );
  await assert.rejects(
    () => run(['import', csvPath, '--date-format', 'nonsense'], capture().io, { home: path.join(root, 'data') }),
    /date-format must be/,
  );
});

test('prints help and reports invalid commands without terminating the process', async () => {
  const help = capture();
  assert.equal(await run([], help.io), 0);
  assert.match(help.text(), /money-mirror import/);

  const invalid = capture();
  assert.equal(await run(['unknown'], invalid.io), 1);
  assert.match(invalid.text(), /Unknown command/);
});
