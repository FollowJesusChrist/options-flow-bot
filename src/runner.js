// runner.js — one live scan pass: Tradier chains → detector → context → vault.
//
// Usage: node src/runner.js
// Env: TRADIER_TOKEN (required for live data), TRADIER_BASE (sandbox default,
// or https://api.tradier.com/v1 for production), WATCHLIST (comma-separated,
// optional), TRADING_DATA_DIR (optional vault override), SNIPER_POST_ONLY
// ("1" default: only tier-S posts, the rest is quiet-logged; "0": all non-D post).
//
// Paper mode is structural: this runner only LOGS signals and context.
// It never places an order — there is no order code path in this project.

import { loadConfig, redact, sniperPostOnly } from "./config.js";
import { TradierClient } from "./data/tradier.js";
import { scan, etParts } from "./signals/unusual.js";
import { captureContext } from "./signals/context.js";
import {
  openTradingDb, logSignalWithContext, writeExports, trackerStats, vaultDir,
  recordContractDaily, historyFor,
} from "./tracker.js";
import { postSignal, postingAllowed } from "./discord/post.js";

const DEFAULT_WATCHLIST = ["SPY", "QQQ", "TSLA", "NVDA", "AAPL", "AMD", "META", "AMZN", "MSFT", "GOOGL"];

export async function runScan({ config, client, db, watchlist, catalystFor = () => "", log = console.log, now = new Date(), postFn = postSignal }) {
  const quoteFn = async (symbols) => {
    const arr = await client.quotes(symbols);
    return Object.fromEntries(arr.map((q) => [q.symbol, q]));
  };
  const historyFn = async (symbol) => client.history(symbol);

  let logged = 0;
  let posted = 0;
  let postSkipped = 0;
  const canPost = postingAllowed();
  const sniperOnly = sniperPostOnly();
  const scanDate = etParts(now).date;
  const tierCounts = { S: 0, A: 0, B: 0, C: 0 };
  for (const symbol of watchlist) {
    const exps = await client.expirations(symbol);
    if (!exps.length) continue;
    let chainAll = [];
    for (const exp of exps.slice(0, 4)) {
      chainAll = chainAll.concat(await client.chain(symbol, exp));
    }
    // Record today's volume/OI first so historyFor sees today's OI for oiRising.
    recordContractDaily(db, chainAll, scanDate);
    const history = {};
    const advMap = {};
    for (const c of chainAll) {
      if (!(Number(c.volume) > 0) || history[c.symbol]) continue;
      history[c.symbol] = historyFor(db, c.symbol, { date: scanDate });
      if (history[c.symbol].adv) advMap[c.symbol] = history[c.symbol].adv;
    }
    const { signals } = scan(chainAll, { advMap, history, now });
    for (const s of signals.slice(0, 5)) {
      if (s.tier in tierCounts) tierCounts[s.tier]++;
      const underlying = s.underlying || symbol;
      const context = await captureContext({
        underlying,
        quoteFn,
        historyFn,
        catalyst: catalystFor(underlying),
      });
      const refId = `${s.symbol}@${new Date().toISOString().slice(0, 10)}`;
      // Dedup: only signals whose refId is NOT already in the vault are new.
      // (logSignalWithContext returns the row id even for duplicates, so the
      // pre-check is what makes "new signals only" true.)
      const alreadyKnown = db.prepare("SELECT 1 FROM signals WHERE ref_id = ?").get(refId);
      const id = logSignalWithContext(
        db,
        { ...s, refId, underlying },
        { rationale: s.factors?.join(" · ") || "", context, source: "live" }
      );
      if (id) logged++;
      if (!alreadyKnown && canPost && (!sniperOnly || s.tier === "S")) {
        const r = await postFn({ ...s, refId, underlying });
        if (r.posted) posted++;
        else { postSkipped++; log(`Post skipped for ${refId}: ${r.reason}`); }
      }
    }
  }
  writeExports(db, vaultDir());
  log(sniperOnly
    ? `scan done: ${tierCounts.S} sniper, ${tierCounts.A} A, ${tierCounts.B} B, ${tierCounts.C} C quiet-logged`
    : `scan done: ${tierCounts.S} S, ${tierCounts.A} A, ${tierCounts.B} B, ${tierCounts.C} C (SNIPER_POST_ONLY=0, all eligible to post)`);
  return { logged, posted, postSkipped, tierCounts, stats: trackerStats(db) };
}

async function main() {
  const config = loadConfig();
  const client = new TradierClient({ base: config.tradierBase, token: config.tradierToken });
  if (!client.hasToken) {
    console.log("LIVE SCAN NOT STARTED — no Tradier token configured.");
    console.log(`TRADIER_TOKEN: ${redact(config.tradierToken)} · base: ${config.tradierBase}`);
    console.log("Add the token (secure entry only, never in chat) and re-run. Everything else is ready:");
    console.log(`vault: ${vaultDir()} · paper mode: ALWAYS (logging only, no orders exist in this codebase)`);
    process.exit(0);
  }
  const watchlist = (process.env.WATCHLIST || DEFAULT_WATCHLIST.join(","))
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const db = openTradingDb();
  const { logged, posted, postSkipped, stats } = await runScan({ config, client, db, watchlist });
  console.log(`Scan complete: ${logged} new signals logged with context. Posted to #options-flow: ${posted} (skipped: ${postSkipped}, posting allowed: ${postingAllowed()}). Vault totals: ${stats.signals} signals, ${stats.closedTrades} closed paper trades (${stats.closedTrades}/30 validation gate).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
