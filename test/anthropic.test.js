import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLlmPayload, requestReflection } from '../src/anthropic.js';

const anomaly = {
  transactionId: 'abc',
  date: '2026-07-01',
  merchant: 'camera shop',
  amountCents: -90000,
  signals: [{ type: 'new-merchant', detail: 'First observed expense at this merchant' }],
  memory: null,
};

test('builds a bounded payload without raw descriptions or private notes', () => {
  const payload = buildLlmPayload([{
    ...anomaly,
    description: 'SECRET RAW MEMO',
    memory: { label: 'expected', note: 'PRIVATE HEALTH DETAIL' },
  }]);

  assert.equal(payload.transactions[0].amount, '-900.00');
  assert.equal(payload.transactions[0].merchant, 'camera shop');
  assert.deepEqual(payload.transactions[0].priorUserMemory, { label: 'expected' });
  assert.doesNotMatch(JSON.stringify(payload), /SECRET|PRIVATE/);
});

test('requests a structured reflection from Anthropic', async () => {
  let request;
  const expected = { summary: 'A change appeared.', observations: [], questions: [] };
  const client = {
    messages: {
      parse: async (value) => {
        request = value;
        return { parsed_output: expected };
      },
    },
  };

  const result = await requestReflection([anomaly], { client, model: 'test-model' });

  assert.deepEqual(result, expected);
  assert.equal(request.model, 'test-model');
  assert.equal(request.messages[0].role, 'user');
  assert.match(request.system, /not financial advice/i);
  assert.match(request.system, /untrusted data/i);
});

test('rejects missing credentials, oversized payloads, and malformed output', async () => {
  await assert.rejects(() => requestReflection([anomaly], { apiKey: '' }), /ANTHROPIC_API_KEY/);
  assert.throws(() => buildLlmPayload(Array(26).fill(anomaly)), /at most 25/i);

  const missing = { messages: { parse: async () => ({ parsed_output: null }) } };
  await assert.rejects(() => requestReflection([anomaly], { client: missing }), /structured output/i);

  const wrongId = {
    messages: {
      parse: async () => ({
        parsed_output: {
          summary: 'Bad ID',
          observations: [{ transactionId: 'invented', interpretation: '', confidence: 'low', evidence: [] }],
          questions: [],
        },
      }),
    },
  };
  await assert.rejects(() => requestReflection([anomaly], { client: wrongId }), /unknown transaction ID/i);

  wrongId.messages.parse = async () => ({
    parsed_output: {
      summary: 'Empty ID',
      observations: [{ transactionId: '', interpretation: '', confidence: 'low', evidence: [] }],
      questions: [],
    },
  });
  await assert.rejects(() => requestReflection([anomaly], { client: wrongId }), /unknown transaction ID/i);
});
