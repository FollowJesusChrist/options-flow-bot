// chart-cmd/handler.js — /chart interaction handler. No discord.js import: it only
// calls the interaction's reply/deferReply/editReply, so the dry-run can drive it
// with a fake interaction and nothing reaches Discord.
//
// Flow: channel check → format check → rate limit (1/user/min) → deferReply (ACK,
// well inside the 3-second window) → quote + liquidity → bars → S/R engine →
// chart PNG + card → editReply. Every request is logged to the vault.
// Read-only Tradier. Paper mode. No orders, no order code.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { vaultDir } from "../src/tracker.js";
import { parseChartOptions, SR_CHANNEL_ID } from "./command.js";
import { checkTicker, liquidity, loadSymbolBars } from "./data.js";
import { analyze } from "./engine.js";
import { chartSeries, buildSvg, renderPng } from "./chart.js";
import { buildCard } from "./card.js";

const EPHEMERAL = 64; // MessageFlags.Ephemeral

export function chartLogPath(env = process.env) {
  return join(vaultDir(env), "logs", "slash-chart.jsonl");
}

export function logRequest(entry, path = chartLogPath()) {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error(`chart log write failed: ${e.message}`);
  }
}

export class RateLimiter {
  constructor(ms = 60_000) { this.ms = ms; this.last = new Map(); }
  // Returns 0 if allowed (and records it), else seconds to wait.
  take(userId, now = Date.now()) {
    const t = this.last.get(userId);
    if (t != null && now - t < this.ms) return Math.ceil((this.ms - (now - t)) / 1000);
    this.last.set(userId, now);
    if (this.last.size > 5000) for (const [k, v] of this.last) if (now - v >= this.ms) this.last.delete(k);
    return 0;
  }
}

// Build the chart + card for one parsed request. Returns { ok, png, embed, ... } or { ok: false, reason }.
export async function buildChart(tradier, req, { now = new Date(), dbPath } = {}) {
  const chk = await checkTicker(tradier, req.ticker);
  if (!chk.ok) return chk;
  const data = await loadSymbolBars(tradier, req.ticker, { now, dbPath });
  if (!data.ok) return data;
  const liq = liquidity(data.engine.daily, chk.quote);
  if (!liq.ok) return { ok: false, reason: `${req.ticker} is too thin for S/R levels: ${liq.why.join("; ")}.` };
  const tail = data.chart.all15[data.chart.all15.length - 1] ?? data.chart.daily[data.chart.daily.length - 1];
  const last = Number(chk.quote?.last) > 0 ? Number(chk.quote.last) : tail.close;
  const a = analyze(req.ticker, data.engine, { lane: req.lane, nowT: data.nowT, spot: last });
  if (!a.support && !a.resistance) return { ok: false, reason: `No support/resistance levels in range for ${req.ticker} right now.` };
  const series = chartSeries(data.chart, req.lane);
  if (series.bars.length < 2) return { ok: false, reason: `Not enough recent bars to draw ${req.ticker}.` };
  const attachmentName = `chart-${req.ticker}.png`;
  const title = `${req.ticker} — ${req.view} — ${series.span}`;
  const png = renderPng(buildSvg({ symbol: req.ticker, title, series, support: a.support, resistance: a.resistance, last }));
  const embed = buildCard(a, { symbol: req.ticker, view: req.view, last, today: data.today, attachmentName });
  return { ok: true, png, embed, attachmentName, analysis: a, last, sources: data.sources };
}

const zoneLog = (z) => (z ? { lo: +z.lo.toFixed(2), hi: +z.hi.toFixed(2), label: z.label, lane: z.lane, score: z.score } : null);

// deps: { tradier, limiter, channelId (tests only; default #support-resistance), now(), log(entry), dbPath,
//         parse, build } — parse/build default to this bot's own; the webhook bot
//         (chart-webhook/) passes its interval/lookback versions.
export function createChartHandler({ tradier, limiter = new RateLimiter(), channelId = SR_CHANNEL_ID, now = () => new Date(), log = logRequest, dbPath, parse = parseChartOptions, build = buildChart } = {}) {
  return async function handleChart(interaction) {
    if (interaction.commandName !== "chart") return;
    const started = Date.now();
    const entry = {
      at: now().toISOString(), user: interaction.user?.id, userName: interaction.user?.username,
      guild: interaction.guildId, channel: interaction.channelId,
      ticker: interaction.options.getString("ticker"), dte: interaction.options.getString("dte"),
    };
    for (const k of ["interval", "lookback"]) { const v = interaction.options.getString(k); if (v != null) entry[k] = v; }
    const done = (outcome, extra = {}) => log({ ...entry, outcome, ms: Date.now() - started, ...extra });
    try {
      if (interaction.channelId !== channelId) {
        await interaction.reply({ content: `/chart works in <#${channelId}> only.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
        return done("wrong-channel");
      }
      const req = parse({ ticker: entry.ticker, dte: entry.dte, interval: entry.interval, lookback: entry.lookback });
      if (!req.ok) {
        await interaction.reply({ content: req.error, flags: EPHEMERAL, allowedMentions: { parse: [] } });
        return done("invalid", { reason: req.error });
      }
      const wait = limiter.take(entry.user ?? "unknown", now().getTime());
      if (wait) {
        await interaction.reply({ content: `One /chart per minute. Try again in ${wait}s.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
        return done("rate-limited", { waitS: wait });
      }
      await interaction.deferReply(); // ACK within 3 s; the chart follows via editReply
      const res = await build(tradier, req, { now: now(), dbPath });
      if (!res.ok) {
        await interaction.editReply({ content: res.reason, allowedMentions: { parse: [] } });
        return done("rejected", { reason: res.reason });
      }
      await interaction.editReply({
        embeds: [res.embed],
        files: [{ attachment: res.png, name: res.attachmentName }],
        allowedMentions: { parse: [] },
      });
      return done("ok", {
        lane: req.lane, last: res.last, support: zoneLog(res.analysis.support), resistance: zoneLog(res.analysis.resistance),
        status: res.analysis.status.key, sources: res.sources, ...res.logExtra,
      });
    } catch (e) {
      const msg = `Couldn't build a chart for ${String(entry.ticker ?? "").slice(0, 8).toUpperCase()} right now. Try again in a minute.`;
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg, embeds: [], files: [] });
        else await interaction.reply({ content: msg, flags: EPHEMERAL });
      } catch { /* interaction expired */ }
      return done("error", { error: String(e.message).replace(/Bearer\s+\S+/g, "Bearer [redacted]").slice(0, 300) });
    }
  };
}
