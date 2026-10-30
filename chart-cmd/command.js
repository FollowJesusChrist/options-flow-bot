// chart-cmd/command.js — the /chart slash command: definition + option parsing.
// One command only (/chart). Pure, no I/O.
//
// Set these in your environment (see ../../.env.example):
//   CHART_GUILD_ID    your Discord server ID (command is registered there)
//   CHART_CHANNEL_ID  the channel /chart answers in

export const LAB_GUILD_ID = (process.env.CHART_GUILD_ID || "").trim();
export const SR_CHANNEL_ID = (process.env.CHART_CHANNEL_ID || "").trim();

export const CHART_COMMAND = {
  name: "chart",
  type: 1, // CHAT_INPUT
  description: "Support/resistance chart for a stock ticker (paper mode, informational only)",
  options: [
    { type: 3, name: "ticker", description: "Stock ticker, e.g. SPY, QQQ, NVDA", required: true, min_length: 1, max_length: 6 },
    { type: 3, name: "dte", description: "Timeframe, e.g. 0DTE, 2DTE, 5DTE, 15DTE (default: nearest levels)", required: false, max_length: 8 },
  ],
};

// DTE → S/R engine lane (src/sr/levels.js LANES). L3 (8–14 DTE) is not built in
// the engine, so 8–14 DTE uses L4 (daily swing levels), the nearest built lane.
export function dteToLane(n) {
  if (n === 0) return { lane: "L0", view: "0DTE" };
  if (n <= 2) return { lane: "L1", view: `${n}DTE` };
  if (n <= 7) return { lane: "L2", view: `${n}DTE` };
  return { lane: "L4", view: `${n}DTE` };
}

// Returns { ok: true, ticker, dte, lane, view } or { ok: false, error } (plain text).
export function parseChartOptions({ ticker, dte }) {
  const t = String(ticker ?? "").trim().toUpperCase().replace(/^\$/, "");
  if (!/^[A-Z]{1,5}$/.test(t)) {
    return { ok: false, error: `"${String(ticker ?? "").slice(0, 12)}" isn't a ticker. Use 1–5 letters, like SPY or NVDA.` };
  }
  if (dte == null || String(dte).trim() === "") return { ok: true, ticker: t, dte: null, lane: null, view: "Nearest levels" };
  const m = /^(\d{1,3})\s*(DTE|D)?$/i.exec(String(dte).trim());
  if (!m) return { ok: false, error: `"${String(dte).slice(0, 12)}" isn't a timeframe. Use something like 0DTE, 2DTE, 5DTE or 15DTE.` };
  const n = Number(m[1]);
  return { ok: true, ticker: t, dte: n, ...dteToLane(n) };
}
