// demo-tracker.js — builds a realistic SAMPLE journal from synthetic data in a
// TEMP vault, then copies the rendered journal to trading-data/exports/SAMPLE-journal.md.
// The real vault DB is never touched by the demo. Sample ≠ real trades.

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureContext } from "../src/signals/context.js";
import {
  openTradingDb, logSignalWithContext, openPaperTradeWithContext,
  closePaperTradeWithContext, recordOutcome, renderJournal, vaultDir,
} from "../src/tracker.js";

const QUOTES = {
  SPY: { symbol: "SPY", last: 598.1, prevclose: 600.5, high: 602, low: 596, volume: 52_000_000, average_volume: 45_000_000 },
  QQQ: { symbol: "QQQ", last: 516.2, prevclose: 519.8, high: 520, low: 514, volume: 35_000_000, average_volume: 32_000_000 },
  VIX: { symbol: "VIX", last: 18.9, prevclose: 17.8 },
  XLY: { symbol: "XLY", last: 208.4, prevclose: 210.1, high: 211, low: 207.5, volume: 6_400_000, average_volume: 6_000_000 },
  TSLA: { symbol: "TSLA", last: 354.7, prevclose: 362.1, high: 369.2, low: 349.3, volume: 61_600_000, average_volume: 58_000_000 },
};
const quoteFn = async (syms) => Object.fromEntries(syms.map((s) => [s, QUOTES[s]]).filter(([, q]) => q));
const historyFn = async () => Array.from({ length: 60 }, (_, i) => ({ close: 372 - i * 0.12 }));

const dir = mkdtempSync(join(tmpdir(), "vault-demo-"));
const db = openTradingDb(dir);

const ctx = await captureContext({
  underlying: "TSLA", quoteFn, historyFn,
  catalyst: "Q3 earnings after close tomorrow (Wed) — IV elevated into the print; deliveries already reported soft (-2.1% YoY)",
  now: new Date("2026-10-20T17:42:00Z"),
});
const sigId = logSignalWithContext(db, {
  refId: "SAMPLE-TSLA-PUT", underlying: "TSLA", expiration: "2026-10-23",
  strike: 370, optionType: "put", tier: "A", score: 84, premium: 41400000,
  volume: 22100, openInterest: 8100, delta: -0.41, dte: 3,
}, {
  rationale: "Whale put flow $41.4M vs $22.6M call premium at the same $360 line — flow is positioned for a break, not a bounce",
  context: ctx, source: "synthetic-demo",
});
const tradeId = openPaperTradeWithContext(db, sigId, 3.00, 3, { notes: "Paper only — validation gate tracking", context: ctx });
closePaperTradeWithContext(db, tradeId, 3.33, { notes: "Scaled lesson from Oct 16: exit discipline over max P&L", context: ctx });
recordOutcome(db, sigId, "SAMPLE ONLY — format demonstration, not a real trade. Real outcomes get written here at review time: what the thesis was, what the environment did, what the lesson is.");

const journal = renderJournal(db);
const outDir = join(vaultDir(), "exports");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "SAMPLE-journal.md"),
  "> **SAMPLE — synthetic data, format demonstration only. No real trades.**\n\n" + journal);
console.log("Sample journal written to trading-data/exports/SAMPLE-journal.md");
