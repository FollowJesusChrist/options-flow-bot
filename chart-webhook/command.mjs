// chart-webhook/command.mjs — the webhook bot's /chart definition + option parsing.
// Extends chart-cmd/command.js (unchanged, still used by the Mac gateway listener)
// with two optional options: interval and lookback. Pure, no I/O.
//
// Rules (also on the card and in README.md):
//   - No interval and no lookback → exactly the old behaviour (nearest levels across
//     lanes, or the dte lane), via chart-cmd/command.js parseChartOptions.
//   - interval wins for the frame; dte only sets the trade-horizon label.
//   - interval without lookback → that interval's default lookback (DEFAULT_LOOKBACK).
//   - lookback without interval → the frame picked for that lookback (FRAME_FOR_LOOKBACK).
//   - Intraday frames (5m/15m/1h/4h) reach back INTRADAY_MAX_DAYS only, so 3months
//     intraday falls back to daily bars, and the card says so.
//   - 1day lookback is refused ("too little data"), as are 4h/daily over 1week.

import { CHART_COMMAND, parseChartOptions } from "../chart-cmd/command.js";

export const INTRADAY_MAX_DAYS = 44; // chart-cmd/data.js pulls 44 days (Tradier: 45-day window, rolling floor)
export const MIN_FRAME_BARS = 20; // same floor the engine uses (levelsAt: di < 20 → no levels)

export const INTERVALS = {
  "5m": { label: "5m", intraday: true, aliases: ["5m", "5min"] },
  "15m": { label: "15m", intraday: true, aliases: ["15m", "15min"] },
  "1h": { label: "1h", intraday: true, aliases: ["1h", "1hr", "60m", "60min"] },
  "4h": { label: "4h", intraday: true, aliases: ["4h", "4hr", "240m"] },
  daily: { label: "daily", intraday: false, aliases: ["daily", "day"] },
};
// Calendar days. Windows count bars whose day is after (today − days).
export const LOOKBACKS = {
  "1week": { label: "1 week", days: 7, aliases: ["1week", "1w", "week", "1wk"] },
  "1month": { label: "1 month", days: 30, aliases: ["1month", "1mo", "month"] },
  "3months": { label: "3 months", days: 91, aliases: ["3months", "3month", "3mo"] },
};
export const DEFAULT_LOOKBACK = { "5m": "1week", "15m": "1month", "1h": "1month", "4h": "1month", daily: "3months" };
export const FRAME_FOR_LOOKBACK = { "1week": "15m", "1month": "1h", "3months": "daily" };
// Bars per session in each frame (regular session): too few in 1 week → refuse.
const THIN = { "4h|1week": "about 10 four-hour bars", "daily|1week": "5 daily bars" };
const ONE_DAY = ["1day", "1d", "day", "today", "1session"];

export const WEBHOOK_CHART_COMMAND = {
  ...CHART_COMMAND,
  options: [
    ...CHART_COMMAND.options,
    { type: 3, name: "interval", description: "Bar size for the levels: 5m, 15m, 1h, 4h or daily (default: nearest levels)", required: false, max_length: 8 },
    { type: 3, name: "lookback", description: "How far back to find levels: 1week, 1month or 3months", required: false, max_length: 8 },
  ],
};

const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");
const find = (table, v) => Object.keys(table).find((k) => table[k].aliases.includes(v)) ?? null;
const show = (v) => String(v).slice(0, 12);

export const TOO_LITTLE_1DAY = "1day is too little data for support/resistance: one session gives a handful of swing points and no repeat tests, so the levels would be noise. Use lookback 1week, 1month or 3months.";

// Returns parseChartOptions' shape plus, when interval/lookback is used:
//   { mode: "frame", frame, lookback, requestedInterval, intervalSource, lookbackSource, fallback, horizon }
// or { ok: false, error } (plain text, sent ephemeral).
export function parseWebhookChartOptions({ ticker, dte, interval, lookback }) {
  const base = parseChartOptions({ ticker, dte });
  if (!base.ok) return base;
  const iv = norm(interval), lb = norm(lookback);
  if (!iv && !lb) return { ...base, mode: "default" };

  let frame = null;
  if (iv) {
    frame = find(INTERVALS, iv);
    if (!frame && ["1day", "1d"].includes(iv)) return { ok: false, error: `"${show(interval)}" isn't an interval here. For daily bars use interval daily.` };
    if (!frame) return { ok: false, error: `"${show(interval)}" isn't an interval. Use 5m, 15m, 1h, 4h or daily.` };
  }
  let lk = null;
  if (lb) {
    if (ONE_DAY.includes(lb)) return { ok: false, error: TOO_LITTLE_1DAY };
    lk = find(LOOKBACKS, lb);
    if (!lk) return { ok: false, error: `"${show(lookback)}" isn't a lookback. Use 1week, 1month or 3months.` };
  }
  const intervalSource = frame ? "given" : `picked for ${LOOKBACKS[lk].label}`;
  const lookbackSource = lk ? "given" : `default for ${frame}`;
  frame ??= FRAME_FOR_LOOKBACK[lk];
  lk ??= DEFAULT_LOOKBACK[frame];

  const requestedInterval = frame;
  let fallback = null;
  if (INTERVALS[frame].intraday && LOOKBACKS[lk].days > INTRADAY_MAX_DAYS) {
    fallback = { from: frame, to: "daily", why: `${frame} bars only go back ${INTRADAY_MAX_DAYS} days, so ${LOOKBACKS[lk].label} uses daily bars` };
    frame = "daily";
  }
  if (THIN[`${frame}|${lk}`]) {
    return { ok: false, error: `${frame} over 1 week is too little data for support/resistance (${THIN[`${frame}|${lk}`]}). Use a smaller interval for 1week, or lookback 1month or 3months.` };
  }
  const horizon = base.dte == null ? null : base.view; // dte → label only once interval sets the frame
  const view = `${INTERVALS[frame].label} · ${LOOKBACKS[lk].label}${fallback ? ` (${fallback.from} → daily fallback)` : ""}${horizon ? ` · ${horizon} horizon` : ""}`;
  return {
    ...base, lane: null, view, mode: "frame",
    frame, lookback: lk, requestedInterval, intervalSource, lookbackSource, fallback, horizon,
  };
}
