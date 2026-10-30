// sr-levels-poller/poller.js — `levels <TICKER> [DTE]` lookup in #support-resistance
// over plain REST polling (no gateway listener; the VM can't hold a websocket).
//
// Every 30 s: GET the channel's new messages → for each human message that parses
// as `levels`/`chart` → rate limit (1/user/min) → chart-cmd's buildChart (same
// engine, data, chart and card code as /chart) → REST reply to that message with
// the PNG + card. Seen message IDs persist in the vault so each request is answered
// once across restarts. Every request + reply is logged to
// trading-data/logs/sr-levels-poller.jsonl.
//
// Paper mode. On-demand only: this never posts on its own and never opens the
// automatic S/R posting gates (src/sr/post.js stays shut). Read-only Tradier,
// no orders, no order code. Discord token from DISCORD_BOT_TOKEN env only; it is
// never printed or logged.
//
// Run via run-poller.sh (nohup from an exec shell) — not systemd, not PM2.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { vaultDir } from "../src/tracker.js";
import { buildChart, RateLimiter } from "../chart-cmd/handler.js";
import { SR_CHANNEL_ID_DEFAULT } from "../chart-cmd/command.js";
import { parseLevelsMessage } from "./parse.js";

export const POLL_MS = 30_000;
export const MAX_AGE_MS = 45 * 60_000; // older requests (e.g. after a long outage) are skipped, not answered late
const SEEN_CAP = 5000;

export const paths = (env = process.env) => ({
  log: join(vaultDir(env), "logs", "sr-levels-poller.jsonl"),
  heartbeat: join(vaultDir(env), "logs", "sr-levels-poller.heartbeat"),
  seen: join(vaultDir(env), "state", "sr-levels-poller-seen.json"),
});

// Discord snowflake → epoch ms.
export const snowflakeMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
const cmpId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const redact = (s) => String(s).replace(/(Bearer|Bot)\s+\S+/g, "$1 [redacted]").replace(/hsurr:\S+/g, "hsurr:[redacted]");

export function jsonlLogger(path) {
  return (entry) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.error(`log write failed: ${e.message}`);
    }
  };
}

// Seen-ID vault file: { cursor, seen: [ids...] }. Written atomically (tmp + rename).
export class SeenStore {
  constructor(path) {
    this.path = path;
    let s = {};
    try { s = JSON.parse(readFileSync(path, "utf8")); } catch { /* first run */ }
    this.cursor = s.cursor ?? null;
    this.ids = new Set(s.seen ?? []);
  }
  has(id) { return this.ids.has(id); }
  add(id) {
    this.ids.add(id);
    if (!this.cursor || cmpId(id, this.cursor) > 0) this.cursor = id;
  }
  save() {
    const seen = [...this.ids].sort(cmpId).slice(-SEEN_CAP);
    this.ids = new Set(seen);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ cursor: this.cursor, seen }));
    renameSync(tmp, this.path);
  }
}

// deps: { discord (me/messages/reply), tradier (TradierProvider: get/invalidate),
//         channelId, botUserId, seen (SeenStore), log(entry), limiter, now(), maxAgeMs, dbPath, warn(msg) }
export function createPoller({
  discord, tradier, channelId = SR_CHANNEL_ID_DEFAULT, botUserId, seen, log,
  limiter = new RateLimiter(60_000), now = () => new Date(), maxAgeMs = MAX_AGE_MS, dbPath, warn = console.warn,
}) {
  let emptyContentWarnedAt = 0;

  async function fetchNew() {
    const out = [];
    let after = seen.cursor ?? undefined;
    for (let page = 0; page < 5; page++) {
      const batch = await discord.messages(channelId, { after, limit: after ? 100 : 50 });
      out.push(...batch);
      if (!after || batch.length < 100) break;
      after = batch.map((m) => m.id).sort(cmpId).at(-1);
    }
    const uniq = new Map(out.map((m) => [m.id, m]));
    return [...uniq.values()].sort((a, b) => cmpId(a.id, b.id));
  }

  async function reply(msg, body) {
    const r = await discord.reply(channelId, msg.id, body);
    return r?.id ?? null;
  }

  async function build(req) {
    const opts = { now: now(), dbPath };
    try {
      return await buildChart(tradier.get(), req, opts);
    } catch (e) {
      if (!/Tradier 40[13]/.test(e.message)) throw e;
      tradier.invalidate(); // surrogate expired → fetch a fresh one and retry once
      return buildChart(tradier.get(), req, opts);
    }
  }

  // Returns { outcome, ... } for the dry run / tests. Logs every request + reply.
  async function handleMessage(msg) {
    if (seen.has(msg.id)) return { outcome: "already-seen" };
    const author = msg.author ?? {};
    if (author.id === botUserId || author.bot) { seen.add(msg.id); return { outcome: "ignored-bot" }; }
    const req = parseLevelsMessage(msg.content);
    if (!req) { seen.add(msg.id); return { outcome: "ignored-no-match" }; }

    const started = Date.now();
    const msgMs = snowflakeMs(msg.id);
    const entry = {
      at: now().toISOString(), messageId: msg.id, messageAt: new Date(msgMs).toISOString(),
      user: author.id, userName: author.username, channel: channelId,
      text: String(msg.content).slice(0, 40),
      ticker: req.ok ? req.ticker : String(req.rawTicker).slice(0, 12), dte: req.ok ? req.dte : null,
    };
    const done = (outcome, replyMessageId = null, extra = {}) => {
      const e = { ...entry, outcome, replyMessageId, ms: Date.now() - started, ...extra };
      log(e);
      return e;
    };

    // Mark seen BEFORE replying: a crash mid-reply skips the request rather than double-answering it.
    seen.add(msg.id);
    seen.save();

    if (now().getTime() - msgMs > maxAgeMs) return done("stale-skipped");
    try {
      if (!req.ok) return done("invalid", await reply(msg, { content: req.error }), { reason: req.error });
      const wait = limiter.take(author.id ?? "unknown", msgMs); // message time, so a batch of polled messages is judged fairly
      if (wait) {
        const content = `One levels lookup per minute. Try again in ${wait}s.`;
        return done("rate-limited", await reply(msg, { content }), { waitS: wait });
      }
      const res = await build(req);
      if (!res.ok) {
        const reason = String(res.reason).replace("so /chart can't", "so the levels lookup can't");
        return done("rejected", await reply(msg, { content: reason }), { reason });
      }
      const id = await reply(msg, { embed: res.embed, png: res.png, filename: res.attachmentName });
      const z = (x) => (x ? { lo: +x.lo.toFixed(2), hi: +x.hi.toFixed(2), label: x.label, lane: x.lane } : null);
      const e = done("ok", id, {
        lane: req.lane, last: res.last, support: z(res.analysis.support), resistance: z(res.analysis.resistance),
        status: res.analysis.status.key, sources: res.sources,
      });
      return { ...e, card: res.embed, png: res.png }; // for the dry run; not written to the log
    } catch (e) {
      const error = redact(e.message).slice(0, 300);
      let replyId = null;
      try {
        replyId = await reply(msg, { content: `Couldn't build levels for ${entry.ticker} right now. Try again in a minute.` });
      } catch { /* Discord unreachable; logged below */ }
      return done("error", replyId, { error });
    }
  }

  async function pollOnce() {
    const msgs = await fetchNew();
    const results = [];
    for (const m of msgs) {
      const r = await handleMessage(m);
      results.push({ id: m.id, ...r });
    }
    // Message Content intent check: human messages with no content/attachments/embeds
    // mean the bot can't read text, so nothing would ever match.
    const blank = msgs.filter((m) => !m.author?.bot && !m.content && !m.attachments?.length && !m.embeds?.length && !m.sticker_items?.length);
    if (blank.length && Date.now() - emptyContentWarnedAt > 3_600_000) {
      emptyContentWarnedAt = Date.now();
      warn(`${blank.length} message(s) came back with empty content: enable the MESSAGE CONTENT intent for this bot in the Discord Developer Portal.`);
    }
    seen.save();
    return results;
  }

  return { pollOnce, handleMessage };
}

// ── live loop ────────────────────────────────────────────────────────────────
async function main() {
  const ts = () => new Date().toISOString();
  const token = (process.env.DISCORD_BOT_TOKEN || "").trim();
  if (!token) { console.error(`${ts()} DISCORD_BOT_TOKEN not set; start via run-poller.sh`); process.exit(2); }
  const { DiscordRest } = await import("./discord-rest.js");
  const { TradierProvider } = await import("./tradier-token.js");
  const p = paths();
  const channelId = (process.env.SR_LEVELS_CHANNEL_ID || "").trim() || SR_CHANNEL_ID_DEFAULT;
  const discord = new DiscordRest({ token });
  const me = await discord.me();
  const tradier = new TradierProvider();
  tradier.get(); // fail fast if the Tradier surrogate can't be fetched
  const seen = new SeenStore(p.seen);
  const poller = createPoller({
    discord, tradier, channelId, botUserId: me.id, seen, log: jsonlLogger(p.log),
    warn: (m) => console.warn(`${ts()} WARN ${m}`),
  });
  console.log(`${ts()} sr-levels-poller up as ${me.username} (${me.id}); channel ${channelId}; every ${POLL_MS / 1000}s; pid ${process.pid}`);

  let stop = false;
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stop = true; console.log(`${ts()} ${sig}, stopping`); process.exit(0); });
  let polls = 0, requests = 0, fails = 0;
  while (!stop) {
    try {
      const r = await poller.pollOnce();
      polls++; fails = 0;
      for (const x of r) {
        if (x.messageId) {
          requests++;
          console.log(`${ts()} ${x.outcome} ${x.ticker}${x.dte != null ? ` ${x.dte}DTE` : ""} msg ${x.messageId} → reply ${x.replyMessageId ?? "-"}${x.error ? ` (${x.error})` : ""}`);
        }
      }
      writeFileSync(p.heartbeat, `${ts()} polls=${polls} requests=${requests}\n`);
      if (polls % 20 === 1) console.log(`${ts()} alive: polls=${polls} requests=${requests}`);
    } catch (e) {
      fails++;
      console.error(`${ts()} poll failed (${fails} in a row): ${redact(e.message).slice(0, 300)}`);
      if (e.status === 401) { console.error(`${ts()} Discord token rejected; exiting`); process.exit(3); }
    }
    await new Promise((r) => setTimeout(r, fails ? Math.min(POLL_MS * 2 ** Math.min(fails, 3), 240_000) : POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`fatal: ${redact(e.message)}`); process.exit(1); });
