// chart-cmd/data.js — bars for one ticker, on demand. Read-only.
//
// SPY/QQQ: recorded bars from trading-data/db/sr.db (opened READ-ONLY, only if
// the file exists) merged with a fresh Tradier pull. Other tickers: Tradier only —
// daily back to 2016, intraday 5m/15m regular session for the last 44 days
// (Tradier caps a window at 45 days and refuses starts before a rolling floor),
// plus the last few days of extended-hours bars for the chart and premarket levels.
// Tradier calls go through src/sr/tradier-ro.js (GET /markets/* only).

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { srDbPath, loadBars } from "../src/sr/store.js";
import { fromTimesales, fromDaily, closeTimeOf, etNow, dayOf } from "../src/sr/bars.js";

const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => isoDay(new Date(Date.parse(day + "T12:00:00Z") + n * 86400000));
const byT = (a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0);

// Liquidity floor for on-demand names (thin names give meaningless levels).
export const MIN_PRICE = 5;
export const MIN_ADV_SHARES = 1_000_000; // 20-day average, computed from history (quote average_volume is unreliable)
export const MIN_DAILY_BARS = 250;

function merge(...lists) {
  const m = new Map();
  for (const l of lists) for (const b of l) m.set(b.t, b);
  return [...m.values()].sort(byT);
}

function recorded(symbol, path = srDbPath()) {
  if (!existsSync(path)) return null;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const out = {
      daily: loadBars(db, symbol, "daily"),
      m5: loadBars(db, symbol, "5min"),
      m15: loadBars(db, symbol, "15min"),
      all5: loadBars(db, symbol, "5min", { sessions: ["overnight", "pre", "regular", "post"] }),
      all15: loadBars(db, symbol, "15min", { sessions: ["overnight", "pre", "regular", "post"] }),
    };
    return out.daily.length ? out : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function timesales(client, symbol, interval, start, end, sessionFilter) {
  try {
    return fromTimesales(await client.timesales(symbol, { interval, start: `${start} 00:00`, end: `${end} 23:59`, sessionFilter }));
  } catch (e) {
    const m = /on or after (\d{4}-\d{2}-\d{2})/.exec(e.message); // rolling intraday floor: clamp once
    if (m && m[1] > start) return fromTimesales(await client.timesales(symbol, { interval, start: `${m[1]} 00:00`, end: `${end} 23:59`, sessionFilter }));
    throw e;
  }
}

// Quote + liquidity check. Returns { ok, quote } or { ok: false, reason } (plain text).
// Without a Tradier token (offline dry run) there is no quote; recorded bars decide.
export async function checkTicker(client, symbol) {
  if (!client?.hasToken) return { ok: true, quote: null, offline: true };
  const q = (await client.quotes([symbol]))[0];
  if (!q || q.symbol !== symbol) return { ok: false, reason: `I couldn't find ${symbol}. Check the ticker and try again.` };
  if (!["stock", "etf"].includes(q.type)) return { ok: false, reason: `${symbol} isn't a stock or ETF, so /chart can't draw it.` };
  return { ok: true, quote: q };
}

export function liquidity(daily, quote) {
  const last = Number(quote?.last) || daily[daily.length - 1]?.close || 0;
  const recent = daily.slice(-20);
  const adv = recent.length ? recent.reduce((s, b) => s + (b.volume || 0), 0) / recent.length : 0;
  const why = [];
  if (daily.length < MIN_DAILY_BARS) why.push(`only ${daily.length} days of history (need ${MIN_DAILY_BARS})`);
  if (last < MIN_PRICE) why.push(`price under $${MIN_PRICE}`);
  if (adv < MIN_ADV_SHARES) why.push(`20-day average volume ${Math.round(adv).toLocaleString("en-US")} shares (need ${MIN_ADV_SHARES.toLocaleString("en-US")})`);
  return { ok: why.length === 0, adv, last, why };
}

// All bars for one symbol. Engine inputs keep COMPLETED bars only (bar close <= now);
// the chart series keeps the live partial bar.
export async function loadSymbolBars(client, symbol, { now = new Date(), dbPath } = {}) {
  const et = etNow(now);
  const nowT = `${et.date}T${et.hm}:00`;
  const rec = recorded(symbol, dbPath);
  let daily = rec?.daily ?? [], m5 = rec?.m5 ?? [], m15 = rec?.m15 ?? [], all5 = rec?.all5 ?? [], all15 = rec?.all15 ?? [];
  const sources = rec ? ["sr.db (recorded)"] : [];

  if (client?.hasToken) {
    const dStart = daily.length ? addDays(daily[daily.length - 1].t, -5) : "2016-01-01";
    const iStart = addDays(et.date, -44);
    const xStart = addDays(et.date, -6);
    const [d, r5, r15, x5, x15] = await Promise.all([
      client.daily(symbol, { start: dStart }).then(fromDaily),
      timesales(client, symbol, "5min", iStart, et.date, "open"),
      timesales(client, symbol, "15min", iStart, et.date, "open"),
      timesales(client, symbol, "5min", xStart, et.date, "all"),
      timesales(client, symbol, "15min", xStart, et.date, "all"),
    ]);
    daily = merge(daily, d);
    m5 = merge(m5, r5, x5.filter((b) => b.session === "regular"));
    m15 = merge(m15, r15, x15.filter((b) => b.session === "regular"));
    all5 = merge(all5, r5, x5);
    all15 = merge(all15, r15, x15);
    sources.push("Tradier (read-only)");
  }
  if (!daily.length) return { ok: false, reason: `No live data for ${symbol} right now (Tradier unavailable, and ${symbol} has no recorded bars).` };

  const done = (bars, interval) => bars.filter((b) => closeTimeOf(b, interval) <= nowT);
  // Today's daily bar is live until the close; use it only after 16:15 ET (same rule as the recorder).
  const dailyDone = daily.filter((b) => b.t < et.date || (b.t === et.date && et.mins >= 16 * 60 + 15));
  return {
    ok: true,
    nowT,
    today: et.date,
    sources,
    engine: {
      daily: dailyDone,
      m5: done(m5, "5min"),
      m15: done(m15, "15min"),
      pre5: done(all5, "5min").filter((b) => b.session === "pre"),
    },
    chart: { daily, m15, all5, all15, lastDay: dayOf((all15[all15.length - 1] ?? daily[daily.length - 1]).t) },
  };
}
