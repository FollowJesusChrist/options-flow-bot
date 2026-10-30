# Options Flow Bot — Monday Go-Live Wiring Plan (DRAFT, NOT EXECUTED)

Prepared 2026-10-23 evening. Status: **nothing here has been created or launched.** This is the exact spec for "say the word and it wires tonight."

## What exists today (verified Oct 23)

- `~/workspace/options-flow-bot/run-live-scan.sh` — one scan pass, Tradier production, logs signals + context to the vault. Verified working: 45 signals, 3:32 PM Oct 23.
- `src/discord/embeds.js` + `components.js` — alert embed + Track / Paper Trade / Dismiss buttons (visual only until a gateway exists).
- Own channel `#options-flow` (<your-channel-id>) in the FollowJesusChrist lab server — test alert posted Oct 23, rendered fine.
- Paper mode is structural: no order code anywhere. Paper validation gate: **0 of 30.**

## What "wired" means — three pieces

### 1. Scan schedule (cron, market hours only)
- Cadence: every 30 min, Mon–Fri, 6:30 AM–1:00 PM PT (= market open 6:30–1:00). ~14 scans/day.
- Runs `run-live-scan.sh` from `~/workspace/options-flow-bot/`.
- New signals since the last scan get posted; repeat signals do NOT re-post (dedup on the vault's refId `SYMBOL@DATE`).

### 2. Watchdog (cron, every 30 min — mirrors kalba-watchdog)
- Check: a scan ran within the last market-hours window (vault has a fresh `writeExports` timestamp or a live scan process exists). Outside market hours: no-op.
- If stale: relaunch the scan once; if it fails twice, message Jesus in the main chat, plain and brief.
- HARD LIMIT: never touch `~/workspace/kalba-lab/` or the live Kalba config. Never print tokens; the scan script fetches its own surrogate.

### 3. Auto-post pipe (code, then wiring)
- Missing piece today: runner → Discord. Needs a small `src/discord/post.js` that takes a graded signal and POSTs it via REST (bot token) to channel <your-channel-id> using `buildSignalEmbed` + `signalButtons`.
- The test alert Oct 23 was posted manually — this replaces the manual step.
- Buttons stay visual-only until a gateway connection exists somewhere (same VM wall as every bot here) — the main agent told Jesus this already.

## Kill switch
- `/kill` slash command design already exists in `src/discord/commands.js` (halts scanning, keeps bot online). Until the gateway exists: the watchdog cron can be disabled in one step, and the scan cron too.

## On his word, the exact sequence
1. Write `src/discord/post.js` (~40 lines, REST post of embed + buttons).
2. Wire runner's `runScan` to call it for new signals only.
3. `cron.add` — scan schedule (market-hours, owner goal:options-trading-bot).
4. `cron.add` — watchdog (interval@30m, same owner).
5. Test-fire one scan Monday pre-open (6:00 AM PT) to confirm a clean post in #options-flow, then it rides on its own.

## What NOT to do without a fresh yes
- No trades, ever (no order code exists — this stays true by design).
- No posting outside #options-flow. No posting outside market hours.
- No buttons wired to actions until the gateway question is solved with Von.
