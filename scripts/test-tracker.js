// test-tracker.js — offline verification for the trading-data vault (tracker + context).
// Uses a temp vault dir and fake quote/history functions. No network, no real DB touched.

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureContext, summarizeContext, sectorEtfFor, vixTag } from "../src/signals/context.js";
import {
  openTradingDb, logSignalWithContext, openPaperTradeWithContext,
  closePaperTradeWithContext, recordOutcome, trackerStats,
  renderJournal, renderSignalsCsv, renderPaperTradesCsv, writeExports,
} from "../src/tracker.js";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok — ${name}`); }
  else { fail++; console.log(`  FAIL — ${name}`); }
}

// Fake market: SPY +0.8%, QQQ +1.1%, VIX 16.4, XLK +0.9%, TSLA -2.0% near day low, below 50d.
const QUOTES = {
  SPY: { symbol: "SPY", last: 600, prevclose: 595.24, high: 601, low: 594, volume: 40_000_000, average_volume: 45_000_000 },
  QQQ: { symbol: "QQQ", last: 520, prevclose: 514.35, high: 521, low: 513, volume: 30_000_000, average_volume: 32_000_000 },
  VIX: { symbol: "VIX", last: 16.4, prevclose: 16.9 },
  XLK: { symbol: "XLK", last: 240, prevclose: 237.87, high: 241, low: 237, volume: 8_000_000, average_volume: 9_000_000 },
  XLY: { symbol: "XLY", last: 210, prevclose: 208, high: 211, low: 207, volume: 5_000_000, average_volume: 6_000_000 },
  TSLA: { symbol: "TSLA", last: 355, prevclose: 362.24, high: 366, low: 352, volume: 88_000_000, average_volume: 60_000_000 },
};
const quoteFn = async (syms) => Object.fromEntries(syms.map((s) => [s, QUOTES[s]]).filter(([, q]) => q));
const historyFn = async () => Array.from({ length: 60 }, (_, i) => ({ close: 370 - i * 0.1 })); // 50d MA ≈ 367.5 → TSLA below it

console.log("context capture:");
check("sector ETF for TSLA is XLY", sectorEtfFor("TSLA") === "XLY");
check("sector ETF default is SPY", sectorEtfFor("ZZZZ") === "SPY");
check("vix tag normal at 16.4", vixTag(16.4) === "normal");
check("vix tag fear at 34", vixTag(34) === "fear");

const ctx = await captureContext({ underlying: "TSLA", quoteFn, historyFn, catalyst: "Q3 earnings after close Wed" });
check("SPY change ≈ +0.8%", Math.abs(ctx.spyChangePct - 0.8) < 0.05);
check("VIX captured at 16.4", ctx.vix === 16.4);
check("TSLA day change ≈ -2.0%", Math.abs(ctx.underlyingChangePct + 2.0) < 0.05);
check("TSLA below 50-day MA (negative vs50d)", ctx.underlyingVs50dPct < 0);
check("catalyst stored", ctx.catalyst.includes("earnings"));
check("summary line mentions VIX", summarizeContext(ctx).includes("VIX 16.4"));

const emptyCtx = await captureContext({ underlying: "TSLA", quoteFn: async () => { throw new Error("feed down"); } });
check("context never throws on feed failure", emptyCtx && emptyCtx.spyChangePct === null);

console.log("tracker vault:");
const dir = mkdtempSync(join(tmpdir(), "vault-test-"));
const db = openTradingDb(dir);
check("db created under vault/db", existsSync(join(dir, "db", "trading.db")));

const sigId = logSignalWithContext(db, {
  refId: "TSLA261023P00370000@2026-10-20", underlying: "TSLA", expiration: "2026-10-23",
  strike: 370, optionType: "put", tier: "A", score: 82, premium: 412000,
  volume: 18204, openInterest: 6930, delta: -0.44, dte: 3,
}, { rationale: "V/OI 2.6x · premium $412K · sweep across 4 exchanges", context: ctx, source: "synthetic-test" });
check("signal logged with id", Number.isInteger(sigId));

const tradeId = openPaperTradeWithContext(db, sigId, 3.10, 2, { notes: "paper entry at signal", context: ctx });
check("paper trade opened", Number.isInteger(tradeId));
const pnl = closePaperTradeWithContext(db, tradeId, 4.60, { notes: "target hit", context: ctx });
check("P&L math: (4.60-3.10)*2*100 = 300", pnl === 300);
recordOutcome(db, sigId, "Thesis worked: earnings-week IV + market fade; puts paid on the break of $360.");

const st = trackerStats(db);
check("stats: 1 signal / 1 closed / 100% win / $300", st.signals === 1 && st.closedTrades === 1 && st.winRate === 100 && st.totalPnl === 300);
check("validation gate not passed at 1/30", st.ready === false);

writeExports(db, dir);
const journal = readFileSync(join(dir, "exports", "journal.md"), "utf8");
check("journal has the signal header", journal.includes("TSLA $370 PUT"));
check("journal carries the environment block", journal.includes("VIX 16.4 (normal)") && journal.includes("Catalyst: Q3 earnings"));
check("journal carries the outcome/lesson", journal.includes("Thesis worked"));
check("journal shows paper P&L", journal.includes("P&L $300"));
const scsv = renderSignalsCsv(db);
check("signals.csv has flattened context columns", scsv.includes("spy_change_pct") && scsv.includes("Q3 earnings"));
const pcsv = renderPaperTradesCsv(db);
check("paper-trades.csv has the closed trade", pcsv.includes("TSLA") && pcsv.includes("300"));

console.log(`\ntracker checks: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
