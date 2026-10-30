# chart-webhook: /chart without the gateway (DRY RUN ONLY)

**Status: not deployed and not live in Discord.** It has only been run as a local
dry run. No host account exists, the Discord app's Interactions Endpoint URL is
unchanged, and nothing has been posted.

## What this is
This is the same `/chart` command (same S/R engine, chart, card, wording, rate limit
and guards), answered over plain HTTPS. Discord sends each `/chart` as a signed POST.
This code checks the signature, ACKs right away, builds the chart, and sends it back
through Discord's interaction webhook. It needs no websocket, no always-on process
and no Mac.

Files:
- `handler-http.mjs`: raw request → Discord response. Ed25519 check via `node:crypto`
  (no npm dependency), PING→PONG, /chart → defer (type 5), followup. It reuses
  `chart-cmd/handler.js` through an adapter interaction. The handler takes optional
  `parse`/`build` hooks, and this bot passes its interval/lookback versions. The
  defaults are the old functions, so the Mac listener is unaffected. All Discord
  network calls go through one function, `sendToDiscord()`, which tests stub out.
- `tradier.mjs`: read-only Tradier client from `TRADIER_TOKEN` (wraps
  `src/sr/tradier-ro.js`; the bar loading is `chart-cmd/data.js`). If Tradier fails,
  it is treated as unavailable for 60 s. During that time SPY/QQQ use recorded
  `sr.db` bars if the file exists, and every other ticker gets "No live data".
- `worker.mjs`: `export default { fetch }` (Web Request → Response) plus a local Node
  http adapter (`node worker.mjs --serve`, dry run only: Discord calls are printed, not sent).
- `api/interactions.mjs`: Vercel route that re-exports the fetch handler.
- `command.mjs`: this bot's `/chart` definition (`WEBHOOK_CHART_COMMAND`: ticker, dte,
  interval, lookback) and option parser. `chart-cmd/command.js` is unchanged, so the
  Mac gateway listener keeps its two options.
- `frames.mjs`: single-frame levels for interval + lookback (pure, no I/O).
- `build.mjs`: chart + card per request. With no interval/lookback it calls
  `chart-cmd/handler.js` `buildChart`, unchanged.
- `test.mjs`, `dryrun.mjs`, `run-dryrun-vm.sh`: tests and the signed fake-interaction
  dry run. `run-dryrun-vm.sh` adds live read-only Tradier through the VM surrogate,
  the same pattern as `../run-sr.sh`.

## Options: ticker, dte, interval, lookback
| option | values | default |
|---|---|---|
| `ticker` (required) | 1–5 letters, e.g. SPY, SOFI | — |
| `dte` | 0DTE, 2DTE, 5DTE, 15DTE … | nearest levels across lanes |
| `interval` | `5m`, `15m`, `1h`, `4h`, `daily` | none (old behaviour) |
| `lookback` | `1week`, `1month`, `3months` | none (old behaviour) |

All four are plain string options (like `dte`), so a mistyped value gets a plain
ephemeral reply. Aliases: `5min`, `15min`, `60m`, `1hr`, `4hr`, `day`; `1w`, `1mo`, `3mo`.

**No interval and no lookback:** exactly the old card, with nearest levels across
lanes (or the dte lane). Same code path as before (`buildChart`).

**With interval and/or lookback:** levels come from ONE frame over ONE window:
- Frame bars: 5m / 15m / daily as `chart-cmd/data.js` loads them (completed bars
  only). 1h and 4h are grouped from regular-session 15m bars anchored at 09:30 ET,
  the same way `src/sr/bars.js` `to1h` builds 1h (a test checks that `toNh(15m, 60)`
  equals `to1h`). 4h = 09:30–13:30 and 13:30–16:00 (the last slot is short, like 1h's
  15:30 slot). A 4h bar still in progress is not used.
- Window: bars whose day is after today − 7 / 30 / 91 calendar days.
- Levels: swing highs/lows (3 bars each side, confirmed 3 bars later), plus the
  window's high and low. Zone half-width is 0.25×ATR(14) intraday and 0.15×ATR(14)
  daily, with a $0.10 floor (the engine's numbers). Overlapping zones merge. Support is
  the nearest zone fully below price and resistance the nearest fully above. Zones
  where price turned at least twice are preferred, then the window high/low, then any
  zone. This is informational only; there is no proven edge.
- "What happened" checks the shown zones in the latest session (daily: the last
  daily bar). Held means price entered the zone and closed back out on the side it
  came from. Broke means one close on the other side, and the card says it was not
  confirmed. The text names the zone, e.g. "price closed above $15.41–$15.66".
- Only one default fills in when an option is missing. interval only → lookback
  5m: 1week, 15m/1h/4h: 1month, daily: 3months. lookback only → interval 1week: 15m,
  1month: 1h, 3months: daily. The card says which value was filled in.

**dte + interval rule: interval wins for the frame; dte only sets the trade-horizon
label.** `/chart SOFI dte:0DTE interval:15m` uses 15m levels over 1 month (not the
0DTE lane), and the card title ends `· 15m · 1 month · 0DTE horizon`. The card's
last line says "Trade horizon 0DTE: label only, the interval sets the frame." dte
alone (no interval/lookback) still picks the lane as before.

**3months on an intraday interval falls back to daily bars, and the card says so.**
Intraday bars (5m/15m, and 1h/4h built from 15m) only reach back 44 days: Tradier
caps a timesales window at 45 days and refuses starts before a rolling floor.
1week (7 d) and 1month (30 d) fit, but 3months (91 d) does not. So `interval:15m
lookback:3months` uses daily bars over 3 months, and no intraday bars are invented.
The title reads `daily · 3 months (15m → daily fallback)`, the frame line reads
"you asked for 15m, but 15m bars only go back 44 days, so 3 months uses daily bars",
and the PNG is named `chart-SOFI-15m-3months-fallback-daily.png`.

**Every frame card shows what was actually used.** The title gives frame · lookback,
plus fallback and horizon when they apply. A last line reads "Levels from **15m**
bars, last **1 month** (Sep 29–Oct 28, 22 sessions)". The dates and session count
come from the bars actually in the window. Footer: "Paper mode · Not financial advice".

**Why there is no 1day lookback.** One session holds 78 5m bars or 26 15m bars, and
far fewer 1h/4h bars. That gives a handful of swing points, and none of them has been
tested twice. S/R depends on price returning to a level, and one day has no returns
to count, so its "levels" are just that day's noise and the chart would look more
certain than it is. `lookback:1day` (also `1d`, `today`) returns a plain ephemeral reply:
"1day is too little data for support/resistance: one session gives a handful of
swing points and no repeat tests, so the levels would be noise. Use lookback 1week,
1month or 3months." No chart is built. `interval:1day` is not an interval; the reply
points to `interval:daily`. For the same reason, `4h` and `daily` over `1week` (about
10 and 5 bars) are refused. Any window with fewer than 20 bars after loading
(the engine's own floor) gets "Too little data for …" instead of a chart.

Rejections that need no data (bad interval, bad lookback, 1day, 4h/daily over 1week,
wrong channel, bad ticker/dte) are ephemeral replies sent before the rate limit, so
they don't use up the user's 1-per-minute slot. Unchanged: #support-resistance only,
1/user/min, price ≥ $5 / 20-day ADV ≥ 1,000,000 / ≥ 250 daily bars, support green /
resistance red, title + price + what happened.

The webhook command definition is `WEBHOOK_CHART_COMMAND` in `command.mjs`. It is
**not registered**. The registered guild `/chart` still has only ticker + dte, until
the user approves re-registration. If the 4-option command is registered and the Mac
gateway listener is used as a fallback, the listener ignores interval/lookback and
answers with the old default card.

## Host choice: Vercel Functions (Node runtime, Hobby/free)
Why the gateway / Mac approach is not enough: Discord gateway websockets never
connect from the agent VM, and the Mac listener only works while the Mac is awake
and online with the window open. With an Interactions Endpoint, Discord calls us,
so nothing has to stay connected.

Why not Cloudflare Workers, though it was the first pick:
- The free plan allows 10 ms CPU per request. One chart runs the S/R engine over
  about 10 years of daily bars plus 44 days of 5m/15m bars, then rasterises a
  1500×750 PNG. That costs hundreds of ms of CPU (about 0.3–0.5 s locally), so it
  needs the paid plan.
- The chart renderer is `@resvg/resvg-js`, a native Node addon, and Workers can't
  load it. Moving to resvg-wasm would mean changing `chart.js`.
- `chart-cmd/data.js` imports `node:sqlite`, which Workers doesn't have.

Why Vercel:
- It runs real Node 22+, so the native resvg addon, `node:sqlite` and
  `node:crypto` Ed25519 all work unchanged.
- `waitUntil` keeps the function alive after the 3-second ACK so the chart can
  finish. `worker.mjs` uses it automatically if `@vercel/functions` is installed.
- The Hobby duration limit is far above the measured chart times (0.9–3.1 s).
- Free-tier invocations are far above lab-server traffic.
- Cold start: module load measured 26 ms locally and PING answers in 3 ms. The
  defer ACK is written by the server about 2–35 ms after the request arrives, well
  inside 3 s. A real cold start adds the platform's boot time, usually under 1 s.

Known limits:
- The 1/user/min limiter lives in memory per warm instance. Two cold instances
  could each allow one request. That is fine at this traffic; a KV store would
  make it strict.
- On the host, the request log goes to function logs (stdout JSON), not the vault.
- `sr.db` won't be on the host unless it is shipped, so there SPY/QQQ also depend
  on live Tradier.
- After the public defer, plain-text outcomes (unknown ticker, thin name, no data,
  error) are sent as an ephemeral followup and the "thinking…" placeholder is
  deleted. Only the person who ran the command sees them.
- `DISCORD_BOT_TOKEN` is optional. Discord's interaction webhook endpoints don't
  require auth. If the secret is set it is sent as `Bot …`; if not, no header.

## Fallback: the Mac gateway listener
`chart-cmd/listener.js` (`./start-chart-mac.sh`) is unchanged. Use it if the host is
down or not approved yet. It needs the Mac awake, online and the window open.
Don't run both at once: once the Interactions Endpoint URL is set, Discord sends
interactions to the URL and the gateway listener stops receiving them.

## Deploy checklist (NOT executed; each step needs the user's yes)
1. Create a Vercel account (Hobby). **Not done.**
2. Deploy root = `options-flow-bot/`, because the code imports `../chart-cmd` and
   `../src`. Add `@resvg/resvg-js` and `@vercel/functions` to that root
   `package.json`, and make sure `chart-cmd/fonts/*.ttf` is included in the
   function bundle. Route: `chart-webhook/api/interactions.mjs`. Node 22.x or newer.
   **Not done.**
3. Set secrets on the host, by name only: `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`
   (optional), `TRADIER_TOKEN`. **Not done.**
4. Discord Developer Portal → app 1485163232032460851 → Interactions Endpoint URL →
   the deployed `/api/interactions` URL. Discord PINGs it once to validate. Do NOT
   do this step now: it changes where all interactions go. **Not done.**
5. Re-register the guild `/chart` with `WEBHOOK_CHART_COMMAND` (adds interval and
   lookback). `chart-cmd/register.js` registers the 2-option `CHART_COMMAND`, so this
   needs a small change or a one-off call, and the user's approval. **Not done.**
6. Test in #support-resistance: `/chart SPY`, `/chart SOFI`, then
   `/chart SOFI interval:15m lookback:1month` and `/chart SOFI interval:15m
   lookback:3months` (fallback card). **Not done.**

What will not happen until the user approves: no account creation, no deploy,
no secret upload, no endpoint change, no Discord message or webhook call, and no
command re-registration (/chart is already registered guild-only).

## Dry-run results (Oct 28, 2026, ~10:04 PT, during market hours)
Tests (`node test.mjs`): **40 passed, 0 failed** offline, and **40 passed, 0 failed**
with live read-only Tradier (`./run-dryrun-vm.sh --test`). Existing `chart-cmd/test.js`:
**51 passed, 0 failed**.

Live Tradier dry run (`./run-dryrun-vm.sh`), PNGs in `chart-webhook/out/`:

| /chart | PNG | Price | Support | Resistance |
|---|---|---|---|---|
| SPY | `out/webhook-chart-SPY.png` (67,249 B) | $771.80 | $763.75–$766.30 | $778.28–$780.46 |
| SOFI | `out/webhook-chart-SOFI.png` (64,789 B) | $16.90 | $14.79–$15.71 | $17.81–$18.08 |
| QQQ 0DTE | `out/webhook-chart-QQQ-0DTE.png` (64,673 B) | $723.25 | $711.71–$715.47 | none in range |

All three cards read "Between Levels" (no held/broke/failed test in the latest session).
Offline run (no Tradier): SPY came from recorded sr.db at $769.95, written to
`out/offline/webhook-chart-SPY.png` (73,271 B). SOFI correctly returned
"No live data for SOFI right now…".

Rejections, live: ZZZZZ → "I couldn't find ZZZZZ…". AACG → "too thin… price under
$5; 20-day average volume 23,795 shares". SPY1 and `dte: soon` → parse errors.
Wrong channel → "/chart works in <#1564371929224450048> only.". A tampered body → 401.
All of these were ephemeral and none produced a chart.

## Interval + lookback dry run (Oct 28, 2026, ~13:25 ET / 10:25 PT, market open)
Tests: `node test.mjs` **108 passed, 0 failed** offline. `./run-dryrun-vm.sh --test`
gives **110 passed, 0 failed** with live read-only Tradier (2 live-only checks). The
40 earlier checks are all still there. `chart-cmd/test.js`: **51 passed, 0 failed**.

`./run-dryrun-vm.sh --frames`, live read-only Tradier, stubbed Discord. PNGs are in
`out/`, and the full cards are in `out/frames-results.json`:

| /chart | frame · window actually used | Price | Support | Resistance | Status | PNG |
|---|---|---|---|---|---|---|
| SOFI interval:15m lookback:1month | 15m · Sep 29–Oct 28 (22 sessions, 561 bars) | $16.95 | $16.54–$16.94 | $17.15–$17.35 | Support Held | `out/webhook-chart-SOFI-15m-1month.png` |
| SOFI interval:daily lookback:3months | daily · Jul 30–Oct 27 (63 bars) | $16.95 | $15.41–$15.66 | $17.52–$17.77 | Resistance Broke (Oct 27 close, $15.41–$15.66) | `out/webhook-chart-SOFI-daily-3months.png` |
| SOFI interval:5m lookback:1week | 5m · Oct 22–Oct 28 (5 sessions, 358 bars) | $16.95 | $16.45–$16.85 | $17.15–$17.35 | Support Held | `out/webhook-chart-SOFI-5m-1week.png` |
| SPY interval:4h lookback:1month | 4h (grouped 15m) · Sep 29–Oct 27 (21 sessions, 42 bars) | $770.99 | $757.45–$761.65 | $772.02–$775.67 | Between Levels | `out/webhook-chart-SPY-4h-1month.png` |
| SOFI interval:15m lookback:3months | **daily** · Jul 30–Oct 27 (15m → daily fallback, on card) | $16.95 | $15.41–$15.66 | $17.52–$17.77 | Resistance Broke | `out/webhook-chart-SOFI-15m-3months-fallback-daily.png` |
| SPY dte:5DTE interval:1h lookback:3months | **daily** · Jul 30–Oct 27 (1h → daily fallback, 5DTE horizon label) | $770.99 | $758.05–$762.42 | $772.97–$777.34 | Between Levels | `out/webhook-chart-SPY-1h-3months-fallback-daily-5DTE.png` |
| SOFI dte:0DTE interval:15m | 15m · 1 month (default lookback), 0DTE label only | $16.95 | $16.54–$16.94 | $17.15–$17.35 | Support Held | `out/webhook-chart-SOFI-15m-1month-0DTE.png` |

SPY 4h ends Oct 27 because the run was at 13:25 ET and today's first 4h bar closes
at 13:30, so it is not used yet. SPY/SOFI daily also end Oct 27: today's daily bar
counts only after 16:15 ET.

Rejections, all ephemeral, with no defer and no chart: `interval:2m` → "\"2m\" isn't an
interval. Use 5m, 15m, 1h, 4h or daily." `lookback:6months` → "\"6months\" isn't a
lookback. Use 1week, 1month or 3months." Interval in the wrong channel → "/chart works in
<#1564371929224450048> only." `lookback:1day` → the 1day reply above. `interval:4h
lookback:1week` → "4h over 1 week is too little data…".

The default dry run (`./run-dryrun-vm.sh`) is unchanged: SPY $771.05 S $763.77–$766.30 /
R $778.28–$780.46, SOFI $16.95 S $14.77–$15.69 / R $17.81–$18.08, QQQ 0DTE $722.03 S
$711.71–$715.47 / R none. The rate limit, bad ticker/dte, ZZZZZ, AACG, wrong channel
and tampered body all behave as before.
