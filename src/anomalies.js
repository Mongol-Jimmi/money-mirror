const NEW_MERCHANT_MINIMUM_CENTS = 5_000;
const AMOUNT_MINIMUM_DIFFERENCE_CENTS = 2_000;
const AMOUNT_RATIO_THRESHOLD = 1.5;
const RECURRING_HISTORY_MINIMUM = 3;
const MAX_RECURRING_CADENCE_DAYS = 60;
const LATE_CADENCE_MULTIPLIER = 1.75;
const ANALYSIS_WINDOW_DAYS = 45;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function daysBetween(first, second) {
  return (new Date(`${second}T00:00:00Z`) - new Date(`${first}T00:00:00Z`)) / 86_400_000;
}

function amountSignal(transaction, history) {
  if (history.length < RECURRING_HISTORY_MINIMUM) return null;
  const typical = median(history.map((item) => Math.abs(item.amountCents)));
  const current = Math.abs(transaction.amountCents);
  if (current - typical < AMOUNT_MINIMUM_DIFFERENCE_CENTS || current / typical < AMOUNT_RATIO_THRESHOLD) {
    return null;
  }
  return {
    type: 'amount',
    detail: `Amount is ${Math.round((current / typical) * 10) / 10}× the prior median`,
  };
}

function timingSignal(transaction, history) {
  if (history.length < RECURRING_HISTORY_MINIMUM) return null;
  const dates = history.map((item) => item.date).sort();
  const intervals = dates.slice(1).map((date, index) => daysBetween(dates[index], date));
  const cadence = median(intervals);
  const gap = daysBetween(dates.at(-1), transaction.date);
  if (cadence <= 0 || cadence > MAX_RECURRING_CADENCE_DAYS || gap <= cadence * LATE_CADENCE_MULTIPLIER) {
    return null;
  }
  return {
    type: 'timing',
    detail: `Arrived after ${Math.round(gap)} days versus a typical ${Math.round(cadence)}-day cadence`,
  };
}

export function detectAnomalies(transactions, batchId, feedback = {}) {
  const batch = transactions.filter((transaction) => transaction.batchId === batchId);
  if (batch.length === 0) return [];
  const latestDate = batch.map((transaction) => transaction.date).sort().at(-1);
  const current = batch.filter(
    (transaction) => daysBetween(transaction.date, latestDate) <= ANALYSIS_WINDOW_DAYS,
  );

  return current.flatMap((transaction) => {
    if (transaction.amountCents >= 0 || feedback[transaction.merchant]?.label === 'ignore') return [];

    const merchantHistory = transactions
      .filter((item) => (
        item.id !== transaction.id
        && item.merchant === transaction.merchant
        && item.amountCents < 0
        && item.date < transaction.date
      ))
      .sort((a, b) => a.date.localeCompare(b.date));
    const signals = [];

    if (merchantHistory.length === 0 && Math.abs(transaction.amountCents) >= NEW_MERCHANT_MINIMUM_CENTS) {
      signals.push({ type: 'new-merchant', detail: 'First observed expense at this merchant' });
    } else {
      const amount = amountSignal(transaction, merchantHistory);
      const timing = timingSignal(transaction, merchantHistory);
      if (amount) signals.push(amount);
      if (timing) signals.push(timing);
    }

    if (signals.length === 0) return [];
    return [{
      transactionId: transaction.id,
      date: transaction.date,
      merchant: transaction.merchant,
      amountCents: transaction.amountCents,
      signals,
      memory: feedback[transaction.merchant] ?? null,
    }];
  });
}
