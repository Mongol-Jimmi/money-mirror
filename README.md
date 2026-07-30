# Money Mirror

A local-first CLI that notices unusual spending, asks Anthropic for a qualitative reflection, and learns from your labels.

> Deterministic code identifies what changed. Claude asks what it might mean. You decide.

Money Mirror is a reflection tool, **not financial advice**. It never moves money, connects to a bank, or silently uploads a statement.

## What it does

- Imports a CSV export into `~/.money-mirror/` with owner-only file permissions.
- Detects unusual amounts, new merchants, and late recurring expenses with visible rules.
- Shows the exact minimized payload before any Anthropic request.
- Sends normalized merchant, date, amount, signal, and prior feedback label—not the raw CSV memo or private feedback note.
- Learns merchant context from labels such as `expected`, `necessary`, `treat`, `regret`, and `ignore`.

## Requirements

- Node.js 20 or newer
- An [Anthropic API key](https://console.anthropic.com/settings/keys) for `reflect` only
- A single-currency CSV with date, description, and signed amount columns

## Install

```bash
git clone https://github.com/Mongol-Jimmi/money-mirror.git
cd money-mirror
npm ci
npm link
```

Set your Anthropic credentials in your shell; never commit them:

```bash
export ANTHROPIC_API_KEY='your-key'
# Optional; this is the current default:
export ANTHROPIC_MODEL='claude-sonnet-5'
```

## Use

```bash
money-mirror import ~/Downloads/statement.csv
money-mirror anomalies
money-mirror reflect
```

`reflect` prints everything it plans to transmit and asks for confirmation. Use `--yes` only in trusted automation.

Teach it what a transaction meant:

```bash
money-mirror label f546f420 expected --note "Planned camera purchase"
money-mirror reflect
```

Inspect local state:

```bash
money-mirror status
```

### CSV variations

Expected columns are automatically matched from common names such as `Date`, `Description`, and `Amount`. Override them when needed:

```bash
money-mirror import statement.csv \
  --date-column Posted \
  --description-column Memo \
  --amount-column Debit \
  --expenses-positive
```

Slash dates are deliberately not guessed:

```bash
money-mirror import statement.csv --date-format mdy
# or: --date-format dmy
```

## Try the synthetic demo

```bash
export MONEY_MIRROR_HOME="$(mktemp -d)"
money-mirror import demo/statement.csv
money-mirror anomalies
money-mirror reflect
```

The demo identifies an unusually large market visit and a new camera-shop purchase. No real financial data is included.

## Detection rules

The current version analyzes transactions from the latest import that fall within its newest 45 days:

- **New merchant:** first observed expense of at least 50 currency units.
- **Amount:** at least three earlier visits, 1.5× the median, and 20 units above it.
- **Timing:** at least three earlier visits and a gap over 1.75× the usual cadence.
- Income and merchants labelled `ignore` are excluded.

These rules are intentionally boring, testable, and visible. Claude explains selected results; it does not perform the detection.

### Interrupted write recovery

Money Mirror never deletes an old write lock automatically because doing so could overwrite an active import. If a command was forcibly terminated and later commands time out, first verify that no Money Mirror process is running, then remove `~/.money-mirror/.write-lock/` (or the equivalent under `MONEY_MIRROR_HOME`) and retry.

## Privacy and limitations

- Raw transactions stay under `~/.money-mirror/` unless `MONEY_MIRROR_HOME` overrides it.
- Money Mirror refuses to use a data directory inside a Git worktree.
- Local files are created with directory mode `0700` and file mode `0600`; writes are atomic and serialized.
- The Anthropic preview can still contain sensitive merchant, date, and amount data. Review it.
- Do not put bank CSVs, local state, or API keys in Git. The repository ignores CSV and environment files by default.
- The MVP assumes one currency and signed amounts; it does not reconcile balances or detect every irregularity.
- Labels are qualitative memory, not model fine-tuning.

## Development

```bash
npm test
npm run lint
npm run test:coverage
npm run security:check
```

Coverage thresholds are enforced at 80% for lines, functions, and branches. CI runs the same checks.

## License

MIT
