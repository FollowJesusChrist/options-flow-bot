// tracker.js — the dedicated trading-data vault.
//
// ONE job: store options-flow signals + paper trades with the market context
// attached, in a place that holds TRADING DATA ONLY — nothing else lives here.
//
// Layout (default ~/workspace/trading-data, override with TRADING_DATA_DIR):
//   db/trading.db        SQLite — signals, paper_trades, context_snapshots, dismissals,
//                        contract_daily (per-contract volume/OI history for V/ADV + repeats)
//   exports/journal.md   human-readable journal (regenerated on every write)
//   exports/signals.csv  flat export for spreadsheet analysis
//   exports/paper-trades.csv
//
// Every signal and every paper-trade entry/exit can carry a context snapshot
// (see signals/context.js): SPY/QQQ/VIX, sector move, underlying state, and a
// catalyst note — the "why" behind the move, captured at the moment it happened.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { summarizeContext } from "./signals/context.js";
import { etParts } from "./signals/unusual.js";

export function vaultDir(env = process.env) {
  return env.TRADING_DATA_DIR || join(homedir(), "workspace", "trading-data");
}

export function openTradingDb(dir = vaultDir()) {
  const dbDir = join(dir, "db");
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dir, "exports"), { recursive: true });
  const db = new DatabaseSync(join(dbDir, "trading.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_id TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'live',
      underlying TEXT NOT NULL,
      expiration TEXT NOT NULL,
      strike REAL NOT NULL,
      option_type TEXT NOT NULL,
      tier TEXT NOT NULL,
      score INTEGER NOT NULL,
      premium REAL NOT NULL,
      volume INTEGER NOT NULL,
      open_interest INTEGER NOT NULL,
      delta REAL,
      dte INTEGER NOT NULL,
      rationale TEXT,
      entry_context_id INTEGER REFERENCES context_snapshots(id),
      outcome_notes TEXT,
      outcome_checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL,
      session TEXT,
      spy_change_pct REAL,
      qqq_change_pct REAL,
      vix REAL,
      vix_tag TEXT,
      sector_etf TEXT,
      sector_change_pct REAL,
      underlying_price REAL,
      underlying_change_pct REAL,
      underlying_range_pos_pct REAL,
      underlying_vs_50d_pct REAL,
      underlying_volume INTEGER,
      underlying_avg_volume INTEGER,
      catalyst TEXT
    );
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL REFERENCES signals(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      entry_price REAL NOT NULL,
      contracts INTEGER NOT NULL DEFAULT 1,
      entry_context_id INTEGER REFERENCES context_snapshots(id),
      exit_price REAL,
      exited_at TEXT,
      exit_context_id INTEGER REFERENCES context_snapshots(id),
      pnl REAL,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL REFERENCES signals(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS contract_daily (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      volume INTEGER NOT NULL,
      oi INTEGER NOT NULL,
      PRIMARY KEY (symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_tsignals_underlying ON signals(underlying);
    CREATE INDEX IF NOT EXISTS idx_tsignals_created ON signals(created_at);
  `);
  return db;
}

// ---------- Per-contract daily history ----------

// Upsert each contract's cumulative volume + OI for the scan day (ET date).
// Later scans the same day overwrite, so the last scan of the day wins.
export function recordContractDaily(db, chain, date = etParts().date) {
  const stmt = db.prepare(`
    INSERT INTO contract_daily (symbol, date, volume, oi) VALUES (?, ?, ?, ?)
    ON CONFLICT(symbol, date) DO UPDATE SET volume = excluded.volume, oi = excluded.oi
  `);
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const c of chain) {
      if (!c?.symbol) continue;
      stmt.run(c.symbol, date, Math.round(Number(c.volume ?? 0)) || 0, Math.round(Number(c.open_interest ?? 0)) || 0);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

// The n weekdays strictly before `date` (YYYY-MM-DD). Exchange holidays are
// not modeled, so a holiday week counts one fewer possible appearance.
function priorWeekdays(date, n) {
  const out = [];
  let d = new Date(date + "T12:00:00Z");
  while (out.length < n) {
    d = new Date(d.getTime() - 86400000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// History for one OCC symbol as of `date` (today excluded from every stat):
//   appearances: distinct dates in the last 5 trading days with volume > 0
//   oiRising:    today's recorded OI > most recent prior recorded OI
//   adv/advDays: mean daily volume over up to 20 prior recorded days;
//                adv is null until advDays >= 5
export function historyFor(db, symbol, { date = etParts().date } = {}) {
  const prior = db.prepare(
    "SELECT date, volume, oi FROM contract_daily WHERE symbol = ? AND date < ? ORDER BY date DESC LIMIT 20"
  ).all(symbol, date);
  const today = db.prepare("SELECT oi FROM contract_daily WHERE symbol = ? AND date = ?").get(symbol, date);
  const window = new Set(priorWeekdays(date, 5));
  const appearances = new Set(prior.filter((r) => window.has(r.date) && r.volume > 0).map((r) => r.date)).size;
  const oiRising = Boolean(today && prior.length && today.oi > prior[0].oi);
  const advDays = prior.length;
  const adv = advDays >= 5 ? prior.reduce((a, r) => a + r.volume, 0) / advDays : null;
  return { appearances, oiRising, adv, advDays };
}

export function saveContext(db, c) {
  if (!c) return null;
  const r = db.prepare(`
    INSERT INTO context_snapshots
      (captured_at, session, spy_change_pct, qqq_change_pct, vix, vix_tag, sector_etf,
       sector_change_pct, underlying_price, underlying_change_pct, underlying_range_pos_pct,
       underlying_vs_50d_pct, underlying_volume, underlying_avg_volume, catalyst)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.capturedAt, c.session, c.spyChangePct, c.qqqChangePct, c.vix, c.vixTag, c.sectorEtf,
    c.sectorChangePct, c.underlyingPrice, c.underlyingChangePct, c.underlyingRangePosPct,
    c.underlyingVs50dPct, c.underlyingVolume, c.underlyingAvgVolume, c.catalyst || ""
  );
  return Number(r.lastInsertRowid);
}

export function getContext(db, id) {
  if (!id) return null;
  const row = db.prepare("SELECT * FROM context_snapshots WHERE id = ?").get(id);
  if (!row) return null;
  return {
    capturedAt: row.captured_at, session: row.session,
    spyChangePct: row.spy_change_pct, qqqChangePct: row.qqq_change_pct,
    vix: row.vix, vixTag: row.vix_tag, sectorEtf: row.sector_etf,
    sectorChangePct: row.sector_change_pct, underlyingPrice: row.underlying_price,
    underlyingChangePct: row.underlying_change_pct,
    underlyingRangePosPct: row.underlying_range_pos_pct,
    underlyingVs50dPct: row.underlying_vs_50d_pct,
    underlyingVolume: row.underlying_volume, underlyingAvgVolume: row.underlying_avg_volume,
    catalyst: row.catalyst || "",
  };
}

// Log a signal; optionally with its entry-moment context snapshot attached.
export function logSignalWithContext(db, s, { rationale = "", context = null, source = "live" } = {}) {
  const ctxId = context ? saveContext(db, context) : null;
  db.prepare(`
    INSERT OR IGNORE INTO signals
      (ref_id, source, underlying, expiration, strike, option_type, tier, score, premium,
       volume, open_interest, delta, dte, rationale, entry_context_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.refId, source, s.underlying, s.expiration, s.strike, s.optionType,
    s.tier, s.score, s.premium, s.volume, s.openInterest,
    Number.isFinite(s.delta) ? s.delta : null, s.dte, rationale, ctxId
  );
  return db.prepare("SELECT id FROM signals WHERE ref_id = ?").get(s.refId)?.id ?? null;
}

export function openPaperTradeWithContext(db, signalDbId, entryPrice, contracts = 1, { notes = "", context = null } = {}) {
  const ctxId = context ? saveContext(db, context) : null;
  const r = db.prepare(`
    INSERT INTO paper_trades (signal_id, entry_price, contracts, notes, entry_context_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(signalDbId, entryPrice, contracts, notes, ctxId);
  return Number(r.lastInsertRowid);
}

export function closePaperTradeWithContext(db, tradeId, exitPrice, { notes = "", context = null } = {}) {
  const t = db.prepare("SELECT entry_price, contracts FROM paper_trades WHERE id = ?").get(tradeId);
  if (!t) throw new Error(`paper trade ${tradeId} not found`);
  const ctxId = context ? saveContext(db, context) : null;
  const pnl = Math.round((exitPrice - t.entry_price) * t.contracts * 100 * 100) / 100; // to the cent
  db.prepare(`
    UPDATE paper_trades SET exit_price = ?, exited_at = datetime('now'), pnl = ?, notes = ?, exit_context_id = ?
    WHERE id = ?
  `).run(exitPrice, pnl, notes, ctxId, tradeId);
  return pnl;
}

export function logDismissal(db, signalDbId, reason = "") {
  db.prepare("INSERT INTO dismissals (signal_id, reason) VALUES (?, ?)").run(signalDbId, reason);
}

export function recordOutcome(db, signalDbId, notes) {
  db.prepare("UPDATE signals SET outcome_notes = ?, outcome_checked_at = datetime('now') WHERE id = ?")
    .run(notes, signalDbId);
}

export function trackerStats(db) {
  const sig = db.prepare("SELECT COUNT(*) AS n FROM signals").get();
  const closed = db.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins, SUM(pnl) AS total
     FROM paper_trades WHERE exit_price IS NOT NULL`
  ).get();
  const open = db.prepare("SELECT COUNT(*) AS n FROM paper_trades WHERE exit_price IS NULL").get();
  const n = closed.n ?? 0;
  return {
    signals: sig.n ?? 0,
    openTrades: open.n ?? 0,
    closedTrades: n,
    wins: closed.wins ?? 0,
    winRate: n ? ((closed.wins ?? 0) / n) * 100 : 0,
    totalPnl: closed.total ?? 0,
    ready: n >= 30, // 30-signal validation gate
  };
}

// ---------- Exports: the readable layer ----------

const money = (v) => (Number.isFinite(v) ? `$${Math.round(v).toLocaleString("en-US")}` : "n/a");
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "n/a");

function contextBlock(c) {
  if (!c) return "_No context captured._";
  const lines = [
    `- Market: ${summarizeContext(c)}`,
    `- Session: ${c.session || "n/a"} · captured ${c.capturedAt}`,
  ];
  if (Number.isFinite(c.underlyingRangePosPct)) {
    lines.push(`- Underlying position in day range: ${c.underlyingRangePosPct.toFixed(0)}% (0 = day low, 100 = day high)`);
  }
  if (Number.isFinite(c.underlyingVolume) && Number.isFinite(c.underlyingAvgVolume) && c.underlyingAvgVolume > 0) {
    lines.push(`- Underlying volume vs average: ${(c.underlyingVolume / c.underlyingAvgVolume).toFixed(1)}x`);
  }
  lines.push(`- Catalyst: ${c.catalyst ? c.catalyst : "none logged"}`);
  return lines.join("\n");
}

export function renderJournal(db) {
  const signals = db.prepare("SELECT * FROM signals ORDER BY created_at DESC, id DESC").all();
  const out = [
    "# Trading Data Journal",
    "",
    "Options-flow signals + paper trades, each with the market context captured at the moment it happened — what the flow did, and the environment it did it in.",
    "",
  ];
  if (!signals.length) out.push("_No signals logged yet._", "");
  for (const s of signals) {
    const dir = s.option_type === "put" ? "PUT" : "CALL";
    out.push(`## ${s.created_at} — ${s.underlying} $${s.strike} ${dir} · exp ${s.expiration} · Tier ${s.tier} (score ${s.score})${s.source !== "live" ? ` · [${s.source}]` : ""}`);
    out.push("");
    out.push(`**The flow:** premium ${money(s.premium)} · volume ${Number(s.volume).toLocaleString("en-US")} vs open interest ${Number(s.open_interest).toLocaleString("en-US")} · DTE ${s.dte}${Number.isFinite(s.delta) ? ` · delta ${s.delta}` : ""}`);
    if (s.rationale) out.push(`**Why it flagged:** ${s.rationale}`);
    out.push("");
    out.push("**The environment (at signal time):**");
    out.push(contextBlock(getContext(db, s.entry_context_id)));
    const trades = db.prepare("SELECT * FROM paper_trades WHERE signal_id = ? ORDER BY id").all(s.id);
    for (const t of trades) {
      out.push("");
      out.push(`**Paper trade #${t.id}:** entered $${t.entry_price} × ${t.contracts} contract(s) at ${t.created_at}`);
      if (t.entry_context_id) {
        out.push("Entry environment:");
        out.push(contextBlock(getContext(db, t.entry_context_id)));
      }
      if (t.exit_price != null) {
        out.push(`Exited $${t.exit_price} at ${t.exited_at} — **P&L ${money(t.pnl)}**`);
        if (t.exit_context_id) {
          out.push("Exit environment:");
          out.push(contextBlock(getContext(db, t.exit_context_id)));
        }
      } else {
        out.push("Still open.");
      }
      if (t.notes) out.push(`Notes: ${t.notes}`);
    }
    out.push("");
    out.push(`**Outcome / lesson:** ${s.outcome_notes ? `${s.outcome_notes} (reviewed ${s.outcome_checked_at})` : "_pending review_"}`);
    out.push("");
    out.push("---");
    out.push("");
  }
  const st = trackerStats(db);
  out.push(`_Totals: ${st.signals} signals · ${st.closedTrades} closed paper trades · win rate ${st.winRate.toFixed(0)}% · total paper P&L ${money(st.totalPnl)} · validation gate (30 closed): ${st.ready ? "PASSED" : `${st.closedTrades}/30`}_`);
  return out.join("\n");
}

const csvEsc = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function renderSignalsCsv(db) {
  const rows = db.prepare(`
    SELECT s.*, c.spy_change_pct, c.qqq_change_pct, c.vix, c.vix_tag, c.sector_etf,
           c.sector_change_pct, c.underlying_change_pct, c.underlying_vs_50d_pct, c.catalyst
    FROM signals s LEFT JOIN context_snapshots c ON c.id = s.entry_context_id
    ORDER BY s.id
  `).all();
  const cols = ["id", "created_at", "source", "underlying", "expiration", "strike", "option_type", "tier", "score",
    "premium", "volume", "open_interest", "delta", "dte", "rationale",
    "spy_change_pct", "qqq_change_pct", "vix", "vix_tag", "sector_etf", "sector_change_pct",
    "underlying_change_pct", "underlying_vs_50d_pct", "catalyst", "outcome_notes"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvEsc(r[c])).join(","))].join("\n") + "\n";
}

export function renderPaperTradesCsv(db) {
  const rows = db.prepare(`
    SELECT p.*, s.underlying, s.expiration, s.strike, s.option_type, s.tier
    FROM paper_trades p JOIN signals s ON s.id = p.signal_id ORDER BY p.id
  `).all();
  const cols = ["id", "created_at", "underlying", "expiration", "strike", "option_type", "tier",
    "entry_price", "contracts", "exit_price", "exited_at", "pnl", "notes"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvEsc(r[c])).join(","))].join("\n") + "\n";
}

// Regenerate all readable exports in the vault. Call after every write.
export function writeExports(db, dir = vaultDir()) {
  const expDir = join(dir, "exports");
  mkdirSync(expDir, { recursive: true });
  writeFileSync(join(expDir, "journal.md"), renderJournal(db));
  writeFileSync(join(expDir, "signals.csv"), renderSignalsCsv(db));
  writeFileSync(join(expDir, "paper-trades.csv"), renderPaperTradesCsv(db));
}
