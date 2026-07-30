import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeEnvironment,
  buildLlmPayload,
  requestReflection,
  runClaudeCli,
} from '../src/claude.js';

const anomaly = {
  transactionId: 'abc',
  date: '2026-07-01',
  merchant: 'camera shop',
  amountCents: -90000,
  signals: [{ type: 'new-merchant', detail: 'First observed expense at this merchant' }],
  memory: null,
};

const reflection = {
  summary: 'A change appeared.',
  observations: [],
  questions: [],
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

test('requests a structured reflection through a Claude CLI runner', async () => {
  let request;
  const runner = async (prompt, options) => {
    request = { prompt, options };
    return reflection;
  };

  const result = await requestReflection([anomaly], { runner, model: 'test-model' });

  assert.deepEqual(result, reflection);
  assert.equal(request.options.model, 'test-model');
  assert.equal(request.options.schema.type, 'object');
  assert.match(request.options.systemPrompt, /not financial advice/i);
  assert.match(request.options.systemPrompt, /untrusted data/i);
  assert.match(request.options.systemPrompt, /currency is unspecified/i);
  assert.doesNotMatch(JSON.stringify(request.options.schema), /abc/);
  assert.match(request.prompt, /user-approved JSON payload/i);
});

test('passes prompts over stdin and disables Claude tools and persistence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-claude-'));
  const command = path.join(root, 'fake-claude');
  await writeFile(command, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    is_error: false,
    structured_output: { input, args: process.argv.slice(2) }
  }));
});
`);
  await chmod(command, 0o700);

  const result = await runClaudeCli('sensitive prompt', {
    command,
    model: 'sonnet',
    schema: { type: 'object' },
  });

  assert.equal(result.input, 'sensitive prompt');
  assert.ok(result.args.includes('--safe-mode'));
  assert.ok(result.args.includes('--no-session-persistence'));
  assert.equal(result.args[result.args.indexOf('--tools') + 1], '');
  assert.doesNotMatch(result.args.join(' '), /sensitive prompt/);
});

test('limits the environment inherited by Claude CLI', () => {
  const environment = buildClaudeEnvironment({
    PATH: '/bin',
    HOME: '/home/user',
    CLAUDE_CODE_OAUTH_TOKEN: 'required-auth',
    UNRELATED_DATABASE_PASSWORD: 'must-not-leak',
  });

  assert.deepEqual(environment, {
    PATH: '/bin',
    HOME: '/home/user',
    CLAUDE_CODE_OAUTH_TOKEN: 'required-auth',
  });
});

test('bounds output and terminates a child that ignores SIGTERM', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-resistant-'));
  const command = path.join(root, 'resistant-claude');
  await writeFile(command, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
setInterval(() => process.stdout.write('x'.repeat(512)), 1);
`);
  await chmod(command, 0o700);

  await assert.rejects(
    () => runClaudeCli('prompt', {
      command,
      maxOutputBytes: 1_024,
      terminationGraceMs: 25,
      timeoutMs: 1_000,
      schema: {},
    }),
    /output exceeded/i,
  );
});

test('enforces timeout when a child ignores SIGTERM', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-mirror-timeout-'));
  const command = path.join(root, 'stalled-claude');
  await writeFile(command, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
setInterval(() => {}, 1_000);
`);
  await chmod(command, 0o700);

  await assert.rejects(
    () => runClaudeCli('prompt', {
      command,
      terminationGraceMs: 25,
      timeoutMs: 50,
      schema: {},
    }),
    /timed out/i,
  );
});

test('rejects oversized payloads, CLI failures, and invalid model output', async () => {
  assert.throws(() => buildLlmPayload(Array(26).fill(anomaly)), /at most 25/i);

  await assert.rejects(
    () => runClaudeCli('prompt', { command: '/missing/money-mirror-claude', schema: {} }),
    /Claude CLI/i,
  );
  await assert.rejects(
    () => requestReflection([anomaly], { runner: async () => null }),
    /structured output/i,
  );

  const wrongId = async () => ({
    summary: 'Bad ID',
    observations: [{ transactionId: 'invented', interpretation: '', confidence: 'low', evidence: [] }],
    questions: [],
  });
  await assert.rejects(() => requestReflection([anomaly], { runner: wrongId }), /unknown transaction ID/i);

  const emptyId = async () => ({
    summary: 'Empty ID',
    observations: [{ transactionId: '', interpretation: '', confidence: 'low', evidence: [] }],
    questions: [],
  });
  await assert.rejects(() => requestReflection([anomaly], { runner: emptyId }), /bounded structured output/i);

  await assert.rejects(
    () => requestReflection([anomaly], {
      runner: async () => ({ ...reflection, questions: Array(11).fill('too many') }),
    }),
    /bounded structured output/i,
  );
});
