// sr-levels-poller/parse.js — message parser for `levels <TICKER> [DTE]` and the
// `chart <TICKER> [DTE]` alias. One parser, both words, case-insensitive.
// Pure, no I/O. Ticker + DTE validation and the DTE → lane mapping come from
// chart-cmd/command.js (reused, not duplicated).
//
// Returns:
//   null                         → not a command, ignore silently
//   { ok: true, ticker, dte, lane, view, word }
//   { ok: false, error, word, rawTicker } → looks like a command but the ticker/DTE is bad

import { parseChartOptions } from "../chart-cmd/command.js";

const CMD = /^\s*(levels|chart)\s+(\S+)(?:\s+(\S+))?\s*$/i;
// Second word only counts as a DTE attempt if it looks like one (digits, optional D/DTE).
// "levels are holding" or "chart looks ugly" are chat, not commands → ignored.
const DTE_LIKE = /^\d{1,3}\s*(dte|d)?$/i;

export function parseLevelsMessage(content) {
  const m = CMD.exec(String(content ?? ""));
  if (!m) return null;
  const word = m[1].toLowerCase();
  const [, , rawTicker, rawDte] = m;
  if (rawDte != null && !DTE_LIKE.test(rawDte)) return null;
  // A 2-word message whose second word is clearly prose (long word, not ticker-ish) is chat.
  if (!/^\$?[A-Za-z0-9.\-]{1,8}$/.test(rawTicker)) return null;
  const r = parseChartOptions({ ticker: rawTicker, dte: rawDte ?? null });
  return r.ok ? { ...r, word } : { ok: false, error: r.error, word, rawTicker };
}
