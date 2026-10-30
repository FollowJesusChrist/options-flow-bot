// sr/store.js — support/resistance vault storage.
//
// Its own SQLite file in the trading-data vault (db/sr.db). It does not write
// to trading.db; it only READS trading.db's `signals` table for the flow join.
// No shared state with other bots.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { vaultDir } from "../tracker.js";

export function srDbPath(dir = vaultDir()) {
  return join(dir, "db", "sr.db");
}

export function openSrDb(path = srDbPath()) {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bars (
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,          -- '5min' | '15min' | 'daily'
      t TEXT NOT NULL,                 -- bar open, ET wall clock 'YYYY-MM-DDTHH:MM:SS' (daily: 'YYYY-MM-DD')
      ts INTEGER,                      -- epoch seconds (intraday only)
      session TEXT NOT NULL,           -- overnight | pre | regular | post | day
      open REAL, high REAL, low REAL, close REAL,
      volume INTEGER, vwap REAL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (symbol, interval, t)
    );
    CREATE TABLE IF NOT EXISTS recorder_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS level_calls (
      id TEXT PRIMARY KEY,             -- deterministic: source|lane|symbol|levelKey|setup|dir|t
      source TEXT NOT NULL,            -- 'replay' | 'shadow'
      run_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      lane TEXT NOT NULL,
      watch_only INTEGER NOT NULL,
      level_key TEXT NOT NULL,
      level_price REAL NOT NULL,
      zone_lo REAL NOT NULL, zone_hi REAL NOT NULL,
      sources TEXT NOT NULL,           -- JSON
      level_score REAL NOT NULL,
      setup TEXT NOT NULL,             -- defend | break | fail
      transition TEXT NOT NULL,        -- held | break-confirmed | break-failed
      direction TEXT NOT NULL,         -- up | down (expected move)
      alert_score REAL,
      tier TEXT,
      caps TEXT,                       -- JSON array of cap/label reasons
      flow_ref_id TEXT,
      contract TEXT,                   -- JSON (fit inputs) if a flow contract is referenced
      spot REAL NOT NULL,
      t TEXT NOT NULL,                 -- decision bar (ET) the call became knowable at its close
      vix_tag TEXT,
      delivery TEXT,                   -- what WOULD happen: loud | quiet | digest | log | watch-log
      delivery_blocked TEXT,           -- why it did not post (gates)
      grade TEXT,                      -- JSON grade result (respected, barsHeld, mfe, mae, ...)
      control_grade TEXT,              -- JSON grade for the mirrored random control
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_calls_run ON level_calls(run_id);
    CREATE TABLE IF NOT EXISTS alert_ledger (
      session TEXT NOT NULL,
      symbol TEXT NOT NULL,
      lane TEXT NOT NULL,
      level_key TEXT NOT NULL,
      direction TEXT NOT NULL,
      transition TEXT NOT NULL,
      delivery TEXT NOT NULL,
      t TEXT NOT NULL,
      call_id TEXT NOT NULL,
      PRIMARY KEY (session, symbol, lane, level_key, direction, transition)
    );
  `);
  return db;
}

export function upsertBars(db, symbol, interval, bars) {
  const stmt = db.prepare(`
    INSERT INTO bars (symbol, interval, t, ts, session, open, high, low, close, volume, vwap, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, interval, t) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
      volume=excluded.volume, vwap=excluded.vwap, ts=excluded.ts, session=excluded.session,
      recorded_at=excluded.recorded_at
  `);
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    for (const b of bars) {
      stmt.run(symbol, interval, b.t, b.ts ?? null, b.session, b.open, b.high, b.low, b.close,
        Math.round(b.volume ?? 0), b.vwap ?? null, now);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return bars.length;
}

// Bars oldest→newest. sessions: array of allowed session tags (default regular/day).
export function loadBars(db, symbol, interval, { sessions = null } = {}) {
  const rows = db.prepare(
    "SELECT t, ts, session, open, high, low, close, volume, vwap FROM bars WHERE symbol = ? AND interval = ? ORDER BY t"
  ).all(symbol, interval);
  const allow = sessions ?? (interval === "daily" ? ["day"] : ["regular"]);
  return rows.filter((r) => allow.includes(r.session));
}

export function barCounts(db) {
  return db.prepare(`
    SELECT symbol, interval, session, COUNT(*) AS n, MIN(t) AS first, MAX(t) AS last
    FROM bars GROUP BY symbol, interval, session ORDER BY symbol, interval, session
  `).all();
}

export function saveCall(db, c) {
  db.prepare(`
    INSERT OR REPLACE INTO level_calls
      (id, source, run_id, symbol, lane, watch_only, level_key, level_price, zone_lo, zone_hi, sources,
       level_score, setup, transition, direction, alert_score, tier, caps, flow_ref_id, contract, spot, t,
       vix_tag, delivery, delivery_blocked, grade, control_grade)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.id, c.source, c.runId, c.symbol, c.lane, c.watchOnly ? 1 : 0, c.levelKey, c.levelPrice,
    c.zone[0], c.zone[1], JSON.stringify(c.sources), c.levelScore, c.setup, c.transition, c.direction,
    c.alertScore ?? null, c.tier ?? null, JSON.stringify(c.caps ?? []), c.flowRefId ?? null,
    c.contract ? JSON.stringify(c.contract) : null, c.spot, c.t, c.vixTag ?? null,
    c.delivery ?? null, c.deliveryBlocked ?? null,
    c.grade ? JSON.stringify(c.grade) : null, c.controlGrade ? JSON.stringify(c.controlGrade) : null
  );
}
