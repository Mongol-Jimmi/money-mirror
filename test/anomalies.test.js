import assert from 'node:assert/strict';
import test from 'node:test';

import { detectAnomalies } from '../src/anomalies.js';

function transaction(id, date, merchant, amountCents, batchId = 'old') {
  return { id, date, description: merchant, merchant, amountCents, batchId };
}

test('detects new, unusually large, and late recurring expenses', () => {
  const transactions = [
    transaction('a', '2026-01-01', 'rent', -100000),
    transaction('b', '2026-02-01', 'rent', -100000),
    transaction('c', '2026-03-01', 'rent', -100000),
    transaction('d', '2026-05-15', 'rent', -180000, 'current'),
    transaction('e', '2026-05-16', 'new camera', -90000, 'current'),
  ];

  const anomalies = detectAnomalies(transactions, 'current', {});
  const rent = anomalies.find((item) => item.transactionId === 'd');
  const camera = anomalies.find((item) => item.transactionId === 'e');

  assert.deepEqual(
    rent.signals.map((signal) => signal.type).sort(),
    ['amount', 'timing'],
  );
  assert.deepEqual(camera.signals.map((signal) => signal.type), ['new-merchant']);
});

test('ignores income, small new purchases, and known ignored merchants', () => {
  const transactions = [
    transaction('income', '2026-06-01', 'employer', 300000, 'current'),
    transaction('coffee', '2026-06-01', 'cafe', -500, 'current'),
    transaction('known', '2026-06-01', 'annual insurance', -100000, 'current'),
  ];
  const feedback = {
    'annual insurance': { label: 'ignore', note: 'Expected every June' },
  };

  assert.deepEqual(detectAnomalies(transactions, 'current', feedback), []);
});

test('uses older rows in a first imported statement as the baseline', () => {
  const transactions = [
    transaction('jan', '2026-01-01', 'market', -5000, 'first'),
    transaction('feb', '2026-02-01', 'market', -5100, 'first'),
    transaction('mar', '2026-03-01', 'market', -4900, 'first'),
    transaction('apr', '2026-04-01', 'market', -15000, 'first'),
  ];

  const anomalies = detectAnomalies(transactions, 'first', {});
  assert.deepEqual(anomalies.map((item) => item.transactionId), ['apr']);
  assert.deepEqual(anomalies[0].signals.map((signal) => signal.type), ['amount']);
});

test('attaches prior feedback to an anomaly', () => {
  const transactions = [
    transaction('old-1', '2026-01-01', 'bike shop', -20000),
    transaction('old-2', '2026-02-01', 'bike shop', -21000),
    transaction('old-3', '2026-03-01', 'bike shop', -19000),
    transaction('new', '2026-06-01', 'bike shop', -90000, 'current'),
  ];
  const feedback = {
    'bike shop': { label: 'treat', note: 'Cycling is important' },
  };

  const [anomaly] = detectAnomalies(transactions, 'current', feedback);
  assert.deepEqual(anomaly.memory, feedback['bike shop']);
});
