# `levels` lookup in #support-resistance (REST polling, runs on the VM)

Type `levels SPY` (or `levels NVDA 15DTE`, or `chart SPY`) in #support-resistance.
Within about a minute the bot replies to your message with a support/resistance chart
and a short card. This is the message version of `/chart`. It needs no gateway
listener: the bot polls the channel over REST every 30 s. The `/chart` slash command
is separate and still waits for a Mac or VPS listener.

- **Paper mode.** The reply is informational, not a trade call. It has no sizing and no buy/sell framing. The footer says "Paper mode · Not financial advice", and every card includes the line "Levels are informational, not a proven edge."
- **On demand only.** The bot posts only as a reply to a `levels`/`chart` message. It doesn't touch the automatic S/R post gates in `src/sr/post.js`: quiet B/C stays off, loud S/A stays off, and the gate stands at 0/30 graded.
- **Read-only Tradier.** All Tradier access goes through `src/sr/tradier-ro.js` (GET `/markets/*` only). There is no order code.
- **Reuses chart-cmd.** It calls `buildChart` from `chart-cmd/handler.js`, which runs the same engine, data, chart and card code, plus the same ticker, DTE and thin-name rules. There is no second levels engine.

## Syntax

| Message | Result |
|---|---|
| `levels SPY` / `chart SPY` | Nearest support and resistance across timeframes |
| `levels SPY 0DTE` | Today (L0) |
| `levels SPY 2DTE` | 1–2 DTE: last 3 sessions (L1) |
| `levels SPY 5DTE` | 3–7 DTE: last 5 sessions, 15m (L2) |
| `levels NVDA 15DTE` | 8+ DTE: daily view (L4) |

The words are case-insensitive and a `$` before the ticker is allowed. The bot ignores everything else: chat, `levels are holding up`, its own messages and any other bot's messages. A bad ticker (`levels SPY1`, `levels ZZZZZ`) or a thin name (price < $5, 20-day average volume < 1M shares, or < 250 days of history) gets a plain one-line reply. Each user gets 1 lookup per minute; a second one inside the minute gets a plain "try again in Ns" reply. A typo doesn't use up the minute.

## Files

| File | Role |
|---|---|
| `poller.js` | Loop: GET new messages → parse → rate limit → `buildChart` → REST reply. Also handles seen IDs, logging and the heartbeat |
| `parse.js` | `levels`/`chart` parser (reuses `chart-cmd/command.js` validation and DTE mapping) |
| `discord-rest.js` | Minimal REST client: `/users/@me`, channel messages, reply with `message_reference` + PNG. Handles 429 |
| `tradier-token.js` | Read-only Tradier client. It re-fetches the vault surrogate every 10 min and after a 401 |
| `run-poller.sh` | Launcher (`nohup`), plus `stop` / `status` |
| `watchdog.sh` | Health check + relaunch, for the agent cron |
| `dryrun.js` | Fake channel and fake Discord, real Tradier. Sends nothing |
| `test.js` | 49 offline checks |

Vault files (under `trading-data/`):

- `logs/sr-levels-poller.jsonl`: one line per request, with message ID, user, ticker, DTE, outcome, reply message ID and timestamps. It never contains a token. Dry-run lines carry `"dryRun": true`.
- `logs/sr-levels-poller.out.log`: process stdout and stderr.
- `logs/sr-levels-poller.heartbeat`: rewritten after every successful poll.
- `logs/sr-levels-poller.watchdog.log`: one line per watchdog run.
- `state/sr-levels-poller-seen.json`: seen message IDs plus a cursor, so each request is answered once, even across restarts.
- `state/sr-levels-poller.pid`

A request is marked seen *before* the bot replies. If the process crashes mid-reply, that request gets no answer, but it is never answered twice. Requests older than 45 minutes when first seen (for example after a long outage) are skipped and logged as `stale-skipped`.

## Discord bot requirements (one time, Developer Portal)

1. **Message Content Intent: ON** (Bot tab → Privileged Gateway Intents). Without it, REST returns empty `content` for other users' messages and nothing ever matches. The poller logs a `WARN … MESSAGE CONTENT intent` line when that happens.
2. Permissions in #support-resistance: **View Channel, Read Message History, Send Messages, Embed Links, Attach Files**.

## Launch (Maple, from an exec shell, not systemd, PM2 or setsid)

```bash
# one time: this poller's own token file (mode 600, git-ignored), never another bot's .env
cd ~/workspace/options-flow-bot/sr-levels-poller
install -m 600 /dev/null .discord-token && read -rs T && printf %s "$T" > .discord-token; unset T

# start (no-op if already running)
~/workspace/options-flow-bot/sr-levels-poller/run-poller.sh
```

Expected output: `started pid N`, then `sr-levels-poller up as <bot> (<id>); channel <your-channel-id>; every 30s`.
`run-poller.sh status` shows whether it's running and the last heartbeat. `run-poller.sh stop` stops it.

## Tests

```bash
node test.js     # 49 offline checks
node dryrun.js   # fake channel messages, live read-only Tradier, PNGs → ./out, nothing sent
```
