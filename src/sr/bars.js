// sr/bars.js — bar utilities: ET clock, sessions, ATR, 1h aggregation,
// time-of-day relative volume. Pure functions, no I/O.

export const INTERVAL_MIN = { "5min": 5, "15min": 15, "60min": 60 };

// ET wall clock for a Date: { date: 'YYYY-MM-DD', hm: 'HH:MM', mins }
export function etNow(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now).map((x) => [x.type, x.value])
  );
  const hour = p.hour === "24" ? "00" : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${hour}:${p.minute}`, mins: Number(hour) * 60 + Number(p.minute) };
}

export const dayOf = (t) => t.slice(0, 10);
export const hmOf = (t) => t.slice(11, 16);
export const minsOf = (t) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));

// Session tag for an intraday bar's open time (ET).
export function sessionOf(t) {
  const m = minsOf(t);
  if (m < 240) return "overnight";
  if (m < 570) return "pre";
  if (m < 960) return "regular";
  if (m < 1200) return "post";
  return "overnight";
}

// Normalise Tradier timesales rows to bars.
export function fromTimesales(rows) {
  return rows.map((r) => ({
    t: r.time, ts: r.timestamp, session: sessionOf(r.time),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, vwap: r.vwap,
  }));
}

export function fromDaily(rows) {
  return rows.map((r) => ({
    t: r.date, ts: null, session: "day",
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, vwap: null,
  }));
}

// Wilder-ish ATR(n) as a simple mean of the last n true ranges, using bars[0..i].
export function atrAt(bars, i, n = 14) {
  if (i < 1) return bars[0] ? bars[0].high - bars[0].low : NaN;
  const from = Math.max(1, i - n + 1);
  let s = 0;
  let k = 0;
  for (let j = from; j <= i; j++) {
    const b = bars[j];
    const pc = bars[j - 1].close;
    s += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    k++;
  }
  return s / k;
}

// Aggregate regular-session 15m bars into 1h bars anchored at 09:30 ET
// (09:30, 10:30, ..., 15:30 — the last is a half hour).
export function to1h(bars15) {
  const out = [];
  let cur = null;
  for (const b of bars15) {
    const m = minsOf(b.t);
    const slot = Math.floor((m - 570) / 60);
    const key = `${dayOf(b.t)}#${slot}`;
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur);
      const sm = 570 + slot * 60;
      const t = `${dayOf(b.t)}T${String(Math.floor(sm / 60)).padStart(2, "0")}:${String(sm % 60).padStart(2, "0")}:00`;
      cur = { key, t, session: "regular", open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, lastT: b.t, pv: (b.vwap ?? b.close) * b.volume };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.lastT = b.t;
      cur.pv += (b.vwap ?? b.close) * b.volume;
    }
  }
  if (cur) out.push(cur);
  return out.map(({ key, pv, ...b }) => ({ ...b, vwap: b.volume ? pv / b.volume : b.close }));
}

// Close time of a bar (ET wall clock) — when its values become knowable.
export function closeTimeOf(bar, interval) {
  if (interval === "daily") return `${bar.t}T16:00:00`;
  if (interval === "60min") {
    // 1h bar closes at its SLOT end (capped at 16:00), not at its last stored
    // 15m bar — so a partial live hour is never treated as complete.
    const end = Math.min(minsOf(bar.t) + 60, 960);
    return addMinutes(bar.t, end - minsOf(bar.t));
  }
  return addMinutes(bar.t, INTERVAL_MIN[interval]);
}

export function addMinutes(t, mins) {
  const m = minsOf(t) + mins;
  return `${dayOf(t)}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
}

// Unique session dates in bar order.
export function sessionDates(bars) {
  const out = [];
  for (const b of bars) {
    const d = dayOf(b.t);
    if (out[out.length - 1] !== d) out.push(d);
  }
  return out;
}

// Relative volume of bars[i] vs the same time-of-day slot over the prior
// `lookback` sessions (only sessions before bars[i]'s session — no hindsight).
// Intraday only. Returns NaN if fewer than 5 prior samples.
export function makeTodRelVol(bars, lookback = 20) {
  const bySlot = new Map(); // hm -> [{day, vol}]
  for (const b of bars) {
    const k = hmOf(b.t);
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push({ day: dayOf(b.t), vol: b.volume });
  }
  return (i) => {
    const b = bars[i];
    const arr = bySlot.get(hmOf(b.t)) || [];
    const day = dayOf(b.t);
    const prior = arr.filter((x) => x.day < day).slice(-lookback);
    if (prior.length < 5) return NaN;
    const avg = prior.reduce((s, x) => s + x.vol, 0) / prior.length;
    return avg > 0 ? b.volume / avg : NaN;
  };
}

// Daily relative volume vs prior 20 sessions.
export function makeDailyRelVol(bars, lookback = 20) {
  return (i) => {
    if (i < 5) return NaN;
    const prior = bars.slice(Math.max(0, i - lookback), i);
    const avg = prior.reduce((s, x) => s + x.volume, 0) / prior.length;
    return avg > 0 ? bars[i].volume / avg : NaN;
  };
}

export function sma(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

// Historical volatility (annualised, close-to-close) over the last n daily closes.
export function hv(closes, n = 20) {
  const c = closes.slice(-(n + 1));
  if (c.length < n + 1) return NaN;
  const r = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const m = sma(r);
  const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252);
}
