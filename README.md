# Options Flow Bot

An alert-first options flow scanner. It watches option chains on a schedule,
runs every contract through a multi-stage filter stack, and posts the signals
that survive to Discord. It never places trades — there is no order code in
this project, by design. The bot finds; the human decides.

## Signal pipeline

**Stage 1 — Triple filter.** Every contract must pass all three:

| Filter | What it catches |
|---|---|
| Volume / Open Interest ≥ 3 | Unusual activity vs. existing positioning |
| Volume / ADV (20-day) | Abnormal volume vs. the contract's own history |
| Premium traded | Real money moving — filters out illiquid noise |

**Stage 2 — Sniper tiers.** Survivors get graded. The top tier (S) requires
*everything*: rising open interest, repeat appearances across 2+ days,
|delta| 0.20–0.60, 7+ days to expiration, and real premium
($500K+ on index ETFs, $100K+ elsewhere). Spread legs and lottery tickets
(|delta| < 0.15) are filtered out, not scored.

**Stage 3 — Paper gate.** Signals log to a local store with full market
context. 30+ paper-tracked signals before any real sizing is even discussed.

## What's in here

- **`src/`** — scanner, signal grading, Discord embeds with
  Track / Paper Trade / Dismiss buttons
- **`chart-cmd/`** — `/chart` Discord slash command (gateway version):
  type `/chart SPY` and get a support/resistance chart back
- **`chart-webhook/`** — `/chart` as an HTTP-interactions endpoint
  (serverless-ready, Ed25519-verified)
- **`sr-levels-poller/`** — support/resistance level engine with
  record / replay / shadow modes and grading vs. a random control
- **`scripts/`** — pipeline smoke tests and dry-run harnesses
  (118 tests, all passing)

## Current state

Paper mode, alert-only. The sniper tier builds per-contract history for a
few trading days before its top tier unlocks — the README is honest about
where the system stands, and the code enforces it.

## Setup

```bash
cp .env.example .env   # fill in your keys — .env is never committed
npm install
./run-live-scan.sh     # one scan pass (paper mode)
./run-sr.sh replay     # offline S/R engine grading
```

You need a [Tradier](https://tradier.com) API token (free tier works for
development; the sandbox endpoint serves delayed data) and a Discord bot
token from the [developer portal](https://discord.com/developers/applications).

## Stack

Node.js · Tradier API · discord.js · SQLite · resvg (server-side chart
rendering, no native canvas deps)

---

Built by Jesus Mondragon. I build with AI coding agents — I direct, they
write, I verify against the live system.
