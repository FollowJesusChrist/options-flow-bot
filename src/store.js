// store.js — SQLite persistence: signals, paper trades, dismissals, outcomes.
// Uses node:sqlite (built-in, no native deps). DB file: data/bot.db (gitignored).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function openDb(dbPath = join(process.cwd(), "data", "bot.db")) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_id TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
      rationale TEXT
    );
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL REFERENCES signals(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      entry_price REAL NOT NULL,
      contracts INTEGER NOT NULL DEFAULT 1,
      exit_price REAL,
      exited_at TEXT,
      pnl REAL,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL REFERENCES signals(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_signals_underlying ON signals(underlying);
    CREATE INDEX IF NOT EXISTS idx_signals_tier ON signals(tier);
  `);
  return db;
}

export function logSignal(db, s, rationale = "") {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO signals
      (ref_id, underlying, expiration, strike, option_type, tier, score, premium, volume, open_interest, delta, dte, rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    s.refId, s.underlying, s.expiration, s.strike, s.optionType,
    s.tier, s.score, s.premium, s.volume, s.openInterest,
    Number.isFinite(s.delta) ? s.delta : null, s.dte, rationale
  );
  return db.prepare("SELECT id FROM signals WHERE ref_id = ?").get(s.refId)?.id ?? null;
}

export function openPaperTrade(db, signalDbId, entryPrice, contracts = 1, notes = "") {
  const stmt = db.prepare(`
    INSERT INTO paper_trades (signal_id, entry_price, contracts, notes) VALUES (?, ?, ?, ?)
  `);
  const r = stmt.run(signalDbId, entryPrice, contracts, notes);
  return Number(r.lastInsertRowid);
}

export function closePaperTrade(db, tradeId, exitPrice, notes = "") {
  const t = db.prepare("SELECT entry_price, contracts FROM paper_trades WHERE id = ?").get(tradeId);
  if (!t) throw new Error(`paper trade ${tradeId} not found`);
  const pnl = (exitPrice - t.entry_price) * t.contracts * 100;
  db.prepare(`UPDATE paper_trades SET exit_price = ?, exited_at = datetime('now'), pnl = ?, notes = ? WHERE id = ?`)
    .run(exitPrice, pnl, notes, tradeId);
  return pnl;
}

export function logDismissal(db, signalDbId, reason = "") {
  db.prepare("INSERT INTO dismissals (signal_id, reason) VALUES (?, ?)").run(signalDbId, reason);
}

// Accuracy stats for /stats: win rate + avg P&L on closed paper trades.
export function accuracyStats(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins, AVG(pnl) AS avg_pnl, SUM(pnl) AS total_pnl
       FROM paper_trades WHERE exit_price IS NOT NULL`
    )
    .get();
  const n = row.n ?? 0;
  return {
    closed: n,
    wins: row.wins ?? 0,
    winRate: n ? ((row.wins ?? 0) / n) * 100 : 0,
    avgPnl: row.avg_pnl ?? 0,
    totalPnl: row.total_pnl ?? 0,
    ready: n >= 30, // 30-signal validation gate
  };
}
