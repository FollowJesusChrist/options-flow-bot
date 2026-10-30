# Support/Resistance bot: build notes (staged, lab only)

Built Oct 26, 2026 from `analysis/support-resistance-design.md` per `claude-task-sr-build.md`.
Paper mode. The 0/30 validation gate stands. Read-only Tradier. No order code. No cron or loop.
**Nothing posts to Discord.**

## Run (one pass per invocation)

```
./run-sr.sh record [--backfill]   # SPY/QQQ 5m, 15m, daily → trading-data/db/sr.db
./run-sr.sh replay                # offline grading vs random control → analysis/sr-replay-<date>.{md,json}
./run-sr.sh shadow                # record + live level calls → sr.db + trading-data/exports/sr-shadow-<date>.md
node scripts/test-sr.js           # 48 checks (look-ahead, state machine, grading, caps, gates)
node scripts/sr-fit-dryrun.js     # step-4 path on the live chain with a SYNTHETIC flow stub; writes nothing
```

## Files

| File | Role |
|---|---|
| `src/sr/tradier-ro.js` | GET-only Tradier wrapper. Refuses any path outside `/markets/`. |
| `src/sr/store.js` | `sr.db` schema: bars, recorder_runs, level_calls, alert_ledger. Only reads trading.db. |
| `src/sr/recorder.js` | Bar recorder. Completed bars only; today's daily bar is stored after 16:15 ET. |
| `src/sr/bars.js` | ET clock, sessions, ATR, 1h bars built from 15m, time-of-day relative volume, HV20. |
| `src/sr/calendar.js` | Manual macro calendar (FOMC, NFP). **CPI dates not filled in.** |
| `src/sr/levels.js` | Level sources, zones, merging, 0–100 strength score (spec §2–3). |
| `src/sr/events.js` | Per-level state machine (spec §5): held / break-confirmed / break-failed. |
| `src/sr/grade.js` | Horizon grading, mirror control, random-time control, sign test. |
| `src/sr/fit.js` | Contract fit (spec §4). IV, delta and theta are recomputed by Black-Scholes from the live mid. |
| `src/sr/alert.js` | Alert score 40/35/25, caps, tier → delivery, anti-spam ledger. |
| `src/sr/post.js` | Discord sender: wired, **all gates shut**. |
| `src/sr/replay.js` | Offline harness (step 2). |
| `src/sr/shadow.js` | Live shadow pass (steps 3–4). Does not import the sender's network path. |
| `run-sr.sh` | Entry point, same surrogate-credential pattern as `run-live-scan.sh`. |

## Data limits found (Oct 26)

- Tradier refuses intraday `start` before **2026-08-28**, whatever the window size.
- Regular-session 5m/15m data reaches that floor (41 sessions). Extended-hours 5m returns only about 8,000 bars (back to about Sep 9). The recorder fetches both and merges them.
- From now on the recorder is the only way to extend this history.

## Posting gates (none are open)

- Quiet B posts and the C digest need `SR_POST_QUIET=1` **and** `SR_SHADOW_VERIFIED=1` (Maple's dry-run sign-off) **and** `SR_CHANNEL_ID` (the `#support-resistance` channel, which is created separately via the browser seat).
- Loud S/A posts need all of the above plus `SR_POST_LOUD=1`. They also need ≥ 30 graded calls in that lane and tier that beat the mirror control (sign-test p < 0.05), computed from sr.db. No env switch bypasses that check.
- Flow dedup: if a flow alert exists for the move, the S/R post must reply in its thread. The flow bot does not store Discord message ids, so those calls are **held**.
- Token comes from env only (`SR_DISCORD_BOT_TOKEN` / `DISCORD_BOT_TOKEN`). It is never read from another bot's folder.

## Interpretations (where the spec left room)

- **Side-inferred coherence at half weight**: the flow term is 0.35 × flow × 0.5. As a result the max alert is 0.4·90 + 17.5 + 25 = **78.5**, so **S (≥ 90) cannot be reached** until a real aggressor-side source exists.
- **Anti-spam**: one post per level per direction per session, whatever the transition. This follows the task wording, which is stricter than the spec. The 8/day cap counts loud + quiet together.
- VWAPs, volume-profile POC and round numbers are **confluence-only**. They add to a zone but never anchor one, because they move or are weak.
- Monthly H/L zones use the weekly ATR. Opex is a label, not a penalty (§9 treats opex pinning separately).
- **Grading**: every setup uses one rule: a ≥ 1 zone-width move in the call's direction before a decision-frame close through the invalidation edge. A break's invalidation edge is its reclaim.
- **Random-time control** is an extra diagnostic. The spec baseline is the mirror control.
- L3 (8–14 DTE) is not built (§9 "start narrow").

## Not built yet

- §8 "option breakeven hit" and paper P&L grading. These need option mids snapshotted every scan (new storage).
- §5 "VIX rising sharply on an upside break" modifier. There is no intraday VIX series.
- CPI dates in the calendar.
- Flow-bot Discord message ids, needed for thread replies.
