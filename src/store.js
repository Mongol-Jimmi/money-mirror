import { access, chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const LABELS = new Set(['expected', 'necessary', 'treat', 'regret', 'ignore']);
const DEFAULT_HOME = path.join(os.homedir(), '.money-mirror');
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasGitMarker(directory) {
  const gitPath = path.join(directory, '.git');
  if (await pathExists(path.join(gitPath, 'HEAD'))) return true;
  try {
    return (await readFile(gitPath, 'utf8')).trim().startsWith('gitdir:');
  } catch {
    return false;
  }
}

async function assertOutsideGitWorktree(home) {
  let current = path.resolve(home);
  while (true) {
    if (await hasGitMarker(current)) {
      throw new Error('MONEY_MIRROR_HOME must not be inside a Git worktree. Choose a private local directory.');
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function canonicalizeProspective(target) {
  let current = path.resolve(target);
  const missingSegments = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return path.join(existing, ...missingSegments.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

async function safeHomePath(home) {
  const canonical = await canonicalizeProspective(home);
  await assertOutsideGitWorktree(canonical);
  return canonical;
}

async function writePrivateJson(filePath, value) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function acquireLock(home) {
  const lockPath = path.join(home, '.write-lock');
  const ownerPath = path.join(lockPath, 'owner.json');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${lockPath}. If its owner is no longer running, remove that lock directory and retry.`);
      }
      await delay(LOCK_RETRY_MS);
      continue;
    }

    const owner = { pid: process.pid, token: randomUUID() };
    try {
      await writePrivateJson(ownerPath, owner);
      return { lockPath, ownerPath, token: owner.token };
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
  }
}

async function releaseLock(lock) {
  try {
    const owner = JSON.parse(await readFile(lock.ownerPath, 'utf8'));
    if (owner.token === lock.token) {
      await rm(lock.lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function withWriteLock(homeInput, operation) {
  const prospectiveHome = await safeHomePath(homeInput);
  await mkdir(prospectiveHome, { recursive: true, mode: 0o700 });
  const home = await realpath(prospectiveHome);
  await assertOutsideGitWorktree(home);
  await chmod(home, 0o700);
  const lock = await acquireLock(home);
  try {
    return await operation(home);
  } finally {
    await releaseLock(lock);
  }
}

export function resolveHome(override) {
  return override ?? process.env.MONEY_MIRROR_HOME ?? DEFAULT_HOME;
}

export async function loadState(homeOverride) {
  const home = await safeHomePath(resolveHome(homeOverride));
  const [ledger, feedback] = await Promise.all([
    readJson(path.join(home, 'ledger.json'), { transactions: [], latestBatchId: null }),
    readJson(path.join(home, 'feedback.json'), {}),
  ]);
  return { ledger, feedback };
}

export async function importTransactions(transactions, homeOverride) {
  return withWriteLock(resolveHome(homeOverride), async (home) => {
    const { ledger } = await loadState(home);
    const existingIds = new Set(ledger.transactions.map((transaction) => transaction.id));
    const additions = transactions.filter((transaction) => !existingIds.has(transaction.id));

    if (additions.length === 0) {
      return { added: 0, batchId: ledger.latestBatchId };
    }

    const batchId = randomUUID();
    const nextLedger = {
      transactions: [
        ...ledger.transactions,
        ...additions.map((transaction) => ({ ...transaction, batchId })),
      ],
      latestBatchId: batchId,
    };
    await writePrivateJson(path.join(home, 'ledger.json'), nextLedger);
    return { added: additions.length, batchId };
  });
}

export async function recordFeedback(idPrefix, label, note = '', homeOverride) {
  if (!LABELS.has(label)) {
    throw new Error(`Label must be one of: ${[...LABELS].join(', ')}.`);
  }
  const cleanNote = String(note).trim();
  if (cleanNote.length > 500) throw new Error('Feedback note must be at most 500 characters.');

  return withWriteLock(resolveHome(homeOverride), async (home) => {
    const { ledger, feedback } = await loadState(home);
    const matches = ledger.transactions.filter((transaction) => transaction.id.startsWith(idPrefix));
    if (matches.length === 0) throw new Error(`No transaction matches "${idPrefix}".`);
    if (matches.length > 1) throw new Error(`Transaction prefix "${idPrefix}" is ambiguous.`);

    const transaction = matches[0];
    const nextFeedback = {
      ...feedback,
      [transaction.merchant]: { label, note: cleanNote },
    };
    await writePrivateJson(path.join(home, 'feedback.json'), nextFeedback);
    return transaction;
  });
}
