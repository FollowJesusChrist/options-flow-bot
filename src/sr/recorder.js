// sr/recorder.js — save SPY/QQQ 5m, 15m and daily bars to the vault on every scan,
// so the ~45-day / Aug-28 Tradier intraday floor stops binding.
//
// Usage: node src/sr/recorder.js [--backfill]   (incremental; backfills on first run)
// Read-only Tradier. Writes only to trading-data/db/sr.db.

import { TradierRO } from "./tradier-ro.js";
import { openSrDb, upsertBars, barCounts } from "./store.js";
import { etNow, fromTimesales, fromDaily, closeTimeOf } from "./bars.js";

export const SR_SYMBOLS = ["SPY", "QQQ"]; // SPY and QQQ only (task scope)
// Tradier: 5m/15m windows must be <= 45 calendar days, and one response is
// capped at ~8,000 bars (keeps the NEWEST), so all-session 5m needs smaller windows.
const WINDOW_DAYS = { "5min": 20, "15min": 44 };

const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => isoDay(new Date(Date.parse(day + "T12:00:00Z") + n * 86400000));

function lastStored(db, symbol, interval) {
  return db.prepare("SELECT MAX(t) AS t FROM bars WHERE symbol = ? AND interval = ?").get(symbol, interval)?.t ?? null;
}

// Fetch intraday bars from `fromDay` to today in <=45-day windows. If Tradier
// rejects the start ("must be on or after X"), clamp to X and retry once.
// Measured Oct 26: regular-session ('open') 5m reaches back to the Aug-28 floor,
// but extended-hours ('all') 5m only keeps ~8,000 bars (~Sep 9). Both are
// fetched and merged; the upsert keys on (symbol, interval, t).
async function fetchIntraday(client, symbol, interval, fromDay, today, sessionFilter) {
  const out = [];
  let start = fromDay;
  let floorNote = null;
  while (start <= today) {
    const end = [addDays(start, WINDOW_DAYS[interval]), today].sort()[0];
    let rows;
    try {
      rows = await client.timesales(symbol, { interval, start: `${start} 00:00`, end: `${end} 23:59`, sessionFilter });
    } catch (e) {
      const m = /on or after (\d{4}-\d{2}-\d{2})/.exec(e.message);
      if (m && m[1] > start) {
        floorNote = `Tradier intraday floor: ${m[1]}`;
        start = m[1];
        continue;
      }
      throw e;
    }
    out.push(...fromTimesales(rows));
    start = addDays(end, 1);
  }
  return { bars: out, floorNote };
}

export async function recordOnce({ client = new TradierRO(), db = openSrDb(), now = new Date(), log = console.log, backfill = false } = {}) {
  const et = etNow(now);
  const nowStamp = `${et.date}T${et.hm}:00`;
  const summary = { at: now.toISOString(), et: nowStamp, saved: {}, notes: [] };

  for (const symbol of SR_SYMBOLS) {
    for (const interval of ["5min", "15min"]) {
      const last = lastStored(db, symbol, interval);
      const fromDay = last && !backfill ? last.slice(0, 10) : addDays(et.date, -75); // first run: ask for more than exists; floor clamps it
      let saved = 0;
      for (const sessionFilter of ["open", "all"]) {
        const { bars, floorNote } = await fetchIntraday(client, symbol, interval, fromDay, et.date, sessionFilter);
        if (floorNote && !summary.notes.includes(floorNote)) summary.notes.push(floorNote);
        // Only completed bars (bar close <= now). The live partial bar is not stored.
        const done = bars.filter((b) => closeTimeOf(b, interval) <= nowStamp);
        saved += upsertBars(db, symbol, interval, done);
      }
      summary.saved[`${symbol} ${interval}`] = saved;
    }
    const lastD = lastStored(db, symbol, "daily");
    const days = fromDaily(await client.daily(symbol, { start: lastD ? addDays(lastD, -3) : "2016-01-01" }));
    // Today's daily bar is live until the close; store it only after 16:15 ET.
    const doneDays = days.filter((d) => d.t < et.date || (d.t === et.date && et.mins >= 16 * 60 + 15));
    summary.saved[`${symbol} daily`] = upsertBars(db, symbol, "daily", doneDays);
  }
  db.prepare("INSERT INTO recorder_runs (ran_at, summary) VALUES (?, ?)").run(now.toISOString(), JSON.stringify(summary));
  log(`Recorder ${nowStamp} ET: ${Object.entries(summary.saved).map(([k, v]) => `${k}=${v}`).join(" · ")}${summary.notes.length ? " · " + summary.notes.join("; ") : ""}`);
  return summary;
}

async function main() {
  const client = new TradierRO();
  if (!client.hasToken) {
    console.log("Recorder not started — no Tradier token in env (use run-sr.sh, which fetches a surrogate).");
    process.exit(0);
  }
  const db = openSrDb();
  await recordOnce({ client, db, backfill: process.argv.includes("--backfill") });
  for (const r of barCounts(db)) console.log(`  ${r.symbol} ${r.interval} ${r.session}: ${r.n} bars ${r.first} → ${r.last}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
