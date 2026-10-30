// sr/replay.js — offline level engine replay + grading vs the random control (spec §11 step 2).
//
// Usage: node src/sr/replay.js [--sessions 30] [--l4-extended 500]
// No Discord. No orders. Reads bars from sr.db (run the recorder first), reads
// trading.db signals READ-ONLY for the flow join, writes level calls to sr.db
// (source='replay') and a report to analysis/sr-replay-<date>.md.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openSrDb, loadBars, saveCall } from "./store.js";
import { buildContext, LANES } from "./levels.js";
import { runLane } from "./events.js";
import { horizonEnd, gradeGeometry, realGeometry, mirrorGeometry, randTimeGeometry, rng, signTestP } from "./grade.js";
import { scoreAlert } from "./alert.js";
import { atrAt, dayOf, etNow } from "./bars.js";
import { vixTag } from "../signals/context.js";
import { vaultDir } from "../tracker.js";
import { TradierRO } from "./tradier-ro.js";
import { SR_SYMBOLS } from "./recorder.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};

export function loadCtx(db, symbol) {
  return buildContext(symbol, {
    daily: loadBars(db, symbol, "daily"),
    m5: loadBars(db, symbol, "5min"),
    m15: loadBars(db, symbol, "15min"),
    pre5: loadBars(db, symbol, "5min", { sessions: ["pre"] }),
  });
}

// Flow signals from trading.db (read-only). created_at is UTC 'YYYY-MM-DD HH:MM:SS'.
export function loadFlow(symbols) {
  try {
    const t = new DatabaseSync(join(vaultDir(), "db", "trading.db"), { readOnly: true });
    const rows = t.prepare(`SELECT ref_id, created_at, underlying, option_type, strike, expiration, score, tier, dte
      FROM signals WHERE source = 'live' AND underlying IN (${symbols.map(() => "?").join(",")})`).all(...symbols);
    t.close();
    return rows.map((r) => {
      const d = new Date(r.created_at.replace(" ", "T") + "Z");
      const et = etNow(d);
      return { ...r, etT: `${et.date}T${et.hm}:00` };
    });
  } catch {
    return [];
  }
}

// L2: flow within the last 60 min before the call close; L4: same session.
export function joinFlow(flow, ev) {
  const cands = flow.filter((f) => {
    if (f.underlying !== ev.symbol) return false;
    if (f.dte < LANES[ev.lane].dte[0] || f.dte > LANES[ev.lane].dte[1]) return false;
    if (ev.lane === "L4") return dayOf(f.etT) === dayOf(ev.closeT) && f.etT <= ev.closeT;
    const mins = (Date.parse(ev.closeT + "Z") - Date.parse(f.etT + "Z")) / 60000;
    return mins >= 0 && mins <= 60 && dayOf(f.etT) === dayOf(ev.closeT);
  });
  return cands.sort((a, b) => b.score - a.score)[0] ?? null;
}

const pct = (a, n) => (n ? `${((100 * a) / n).toFixed(0)}%` : "—");

function summarize(rows) {
  const g = rows.filter((r) => r.grade.status !== "pending");
  const n = g.length;
  const hit = g.filter((r) => r.grade.status === "respected").length;
  const mir = g.filter((r) => r.mirror.status === "respected").length;
  const rt = g.filter((r) => r.randtime && r.randtime.status === "respected").length;
  const rtN = g.filter((r) => r.randtime && r.randtime.status !== "pending").length;
  const b = g.filter((r) => r.grade.status === "respected" && r.mirror.status !== "respected").length;
  const c = g.filter((r) => r.grade.status !== "respected" && r.mirror.status === "respected").length;
  const med = (xs) => (xs.length ? xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)] : NaN);
  return {
    calls: rows.length, graded: n, pending: rows.length - n,
    hit, mir, rt, rtN,
    hitRate: n ? hit / n : NaN, mirRate: n ? mir / n : NaN, rtRate: rtN ? rt / rtN : NaN,
    edgeVsMirror: n ? (hit - mir) / n : NaN,
    pSign: signTestP(b, c),
    medBarsHeld: med(g.map((r) => r.grade.barsHeld)),
    medMfe: med(g.map((r) => r.grade.mfeAtr)), medMae: med(g.map((r) => r.grade.maeAtr)),
  };
}

function row(label, s) {
  const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
  return `| ${label} | ${s.calls} | ${s.graded} | ${pct(s.hit, s.graded)} | ${pct(s.mir, s.graded)} | ${pct(s.rt, s.rtN)} | ${Number.isFinite(s.edgeVsMirror) ? (s.edgeVsMirror >= 0 ? "+" : "") + (100 * s.edgeVsMirror).toFixed(0) + " pts" : "—"} | ${s.graded ? s.pSign.toFixed(2) : "—"} | ${f(s.medBarsHeld)} | ${f(s.medMfe)} / ${f(s.medMae)} |`;
}
const HEAD = "| slice | calls | graded | respected | mirror control | random-time | edge vs mirror | sign-test p | med bars held | med MFE / MAE (ATR) |\n|---|---|---|---|---|---|---|---|---|---|";

export async function replay({ sessions = 30, l4Extended = 500, log = console.log } = {}) {
  const db = openSrDb();
  const runId = `replay-${new Date().toISOString()}`;
  const flow = loadFlow(SR_SYMBOLS);
  const ctxs = Object.fromEntries(SR_SYMBOLS.map((s) => [s, loadCtx(db, s)]));

  // VIX regime tags by prior daily close (not stored by the recorder — SPY/QQQ only).
  let vix = new Map();
  try {
    const c = new TradierRO();
    if (c.hasToken) for (const d of await c.daily("VIX", { start: "2024-01-01" })) vix.set(d.date, d.close);
  } catch { vix = new Map(); }
  const vixDays = [...vix.keys()].sort();
  const vixFor = (day) => { const k = vixDays.filter((d) => d < day).pop(); return vixTag(k ? vix.get(k) : NaN); };

  const runs = [
    ...["L0", "L1", "L2", "L4"].map((lane) => ({ lane, label: lane, sessions })),
    { lane: "L4", label: "L4-extended", sessions: l4Extended },
  ];
  const out = {};
  const R = rng(20261026);
  const t0 = Date.now();
  for (const run of runs) {
    const rows = [];
    for (const sym of SR_SYMBOLS) {
      const ctx = ctxs[sym];
      const bars = ctx.frames[LANES[run.lane].decision];
      let start;
      if (LANES[run.lane].decision === "daily") start = Math.max(260, bars.length - run.sessions);
      else {
        const days = ctx.sessions[LANES[run.lane].decision];
        const firstDay = days[Math.max(11, days.length - run.sessions)];
        start = bars.findIndex((b) => dayOf(b.t) === firstDay);
      }
      const events = runLane(ctx, run.lane, start, bars.length - 1);
      const ends = new Map();
      const hEnd = (i) => { if (!ends.has(i)) ends.set(i, horizonEnd(bars, i, run.lane)); return ends.get(i); };
      const eligible = [];
      for (let r = start; r < bars.length; r++) if (hEnd(r) !== Infinity) eligible.push(r);
      for (const ev of events) {
        const end = hEnd(ev.i);
        const grade = gradeGeometry(bars, ev.i, end, realGeometry(ev));
        const mirror = gradeGeometry(bars, ev.i, end, mirrorGeometry(ev));
        let randtime = null;
        if (eligible.length > 1) {
          let r = ev.i;
          while (r === ev.i) r = eligible[Math.floor(R() * eligible.length)];
          randtime = gradeGeometry(bars, r, hEnd(r), randTimeGeometry(ev, bars, r, atrAt(bars, r, 14)));
        }
        rows.push({ ...ev, grade, mirror, randtime, flowSig: joinFlow(flow, ev), vixTag: vixFor(dayOf(ev.t)) });
      }
    }
    // cross-index confirmation for breaks (SPY vs QQQ, same lane, same bar ±1)
    for (const r of rows) {
      if (r.setup !== "break") continue;
      const other = rows.filter((o) => o.symbol !== r.symbol && o.setup === "break" && o.direction === r.direction);
      const bars = ctxs[r.symbol].frames[LANES[r.lane].decision];
      const near = other.some((o) => Math.abs(Date.parse(o.t + "Z") - Date.parse(r.t + "Z")) <= 2 * (Date.parse(bars[1].t + "Z") - Date.parse(bars[0].t + "Z") || 86400000));
      r.crossIndex = near ? "agree" : "disagree";
    }
    // alert scoring (no historical chains → no fit offline; flow join where it exists)
    for (const r of rows) {
      const a = scoreAlert({
        lane: r.lane, watchOnly: LANES[r.lane].watchOnly, levelScore: r.level.score, setup: r.setup, direction: r.direction,
        flow: r.flowSig, fit: null, tags: r.tags, eventRisk: r.level.eventRisk, crossIndex: r.crossIndex,
      });
      Object.assign(r, a);
    }
    // dedupe like the poster would: first call per session/symbol/level/direction
    const seen = new Set();
    const dedup = rows.sort((a, b) => (a.t < b.t ? -1 : 1)).filter((r) => {
      const k = `${dayOf(r.t)}|${r.symbol}|${r.level.key}|${r.direction}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    out[run.label] = { lane: run.lane, rows, dedup };
    log(`${run.label}: ${rows.length} transitions (${dedup.length} after per-session dedupe) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // persist (latest replay only)
  db.exec("DELETE FROM level_calls WHERE source = 'replay'");
  db.exec("BEGIN");
  for (const [label, { dedup }] of Object.entries(out)) {
    for (const r of dedup) {
      saveCall(db, {
        id: `replay|${label}|${r.symbol}|${r.level.key}|${r.transition}|${r.direction}|${r.t}`,
        source: "replay", runId, symbol: r.symbol, lane: r.lane, watchOnly: LANES[r.lane].watchOnly,
        levelKey: r.level.key, levelPrice: r.level.mid, zone: [r.level.lo, r.level.hi], sources: r.level.sources,
        levelScore: r.level.score, setup: r.setup, transition: r.transition, direction: r.direction,
        alertScore: r.alertScore, tier: r.tier, caps: [...r.caps, ...r.tags, ...(r.crossIndex ? [`cross-index ${r.crossIndex}`] : [])],
        flowRefId: r.flowSig?.ref_id ?? null, contract: null, spot: r.spot, t: r.t, vixTag: r.vixTag,
        delivery: r.delivery, deliveryBlocked: "replay: never posts",
        grade: { ...r.grade, label }, controlGrade: { mirror: r.mirror, randtime: r.randtime },
      });
    }
  }
  db.exec("COMMIT");
  return { out, runId, flowCount: flow.length, ctxs };
}

function report({ out, runId, flowCount, ctxs }, sessions) {
  const L = [];
  const d0 = ctxs.SPY.sessions["15min"];
  L.push(`# S/R level engine — offline replay vs random control`);
  L.push("");
  L.push(`> Paper mode. 0/30 validation gate stands. Nothing here is a trade call. Run \`${runId}\`.`);
  L.push(`> Data: SPY + QQQ from \`trading-data/db/sr.db\` (recorder). Intraday floor at Tradier: 2026-08-28. Sessions in store: ${d0[0]} → ${d0[d0.length - 1]} (${d0.length}).`);
  L.push(`> Replay window: last ${sessions} sessions for L0/L1/L2/L4 (first 11 sessions are warm-up for the 10-session lookback and time-of-day volume). L4-extended: last 500 daily bars (supplementary, not the ~30-session ask).`);
  L.push("");
  L.push("## How to read this");
  L.push("");
  L.push("- **Respected**: price moved ≥ 1 zone width in the call's direction before a decision-frame close through the invalidation edge, within the lane horizon (L0 same session, L1 2 sessions, L2 5 sessions, L4 15 daily bars). If the target and invalidation land on the same bar, it counts as not respected.");
  L.push("- **Mirror control** (spec §8 baseline): a random control level at the same distance on the opposite side of spot, graded with the mirrored rule. **Edge = real − mirror.** In a trending tape the mirror also picks up drift, so per-direction rows are shown.");
  L.push("- **Random-time**: an extra diagnostic, not part of the spec. It uses the same direction and the same ATR-scaled geometry at a random decision bar, which separates the level's timing from drift.");
  L.push("- **Sign-test p**: exact binomial on discordant (real vs mirror) pairs. Small samples give big p. Nothing here is significant unless p is small *and* graded ≥ 30.");
  L.push("- Calls are deduped the way the poster would: the first transition per session/symbol/level/direction. Pending = horizon not complete yet.");
  L.push("");
  for (const [label, { lane, rows, dedup }] of Object.entries(out)) {
    L.push(`## ${label} ${LANES[lane].watchOnly ? "(watch-only lane)" : "(alertable lane)"} — decision frame ${LANES[lane].decision}`);
    L.push("");
    L.push(`Raw transitions: ${rows.length}. After dedupe: ${dedup.length}.`);
    L.push("");
    L.push(HEAD);
    L.push(row("**all**", summarize(dedup)));
    L.push(row("level ≥ 70 (strong)", summarize(dedup.filter((r) => r.level.score >= 70))));
    L.push(row("level 55–69 (moderate)", summarize(dedup.filter((r) => r.level.score >= 55 && r.level.score < 70))));
    L.push(row("level < 55 (weak)", summarize(dedup.filter((r) => r.level.score < 55))));
    for (const s of ["defend", "break", "fail"]) L.push(row(`setup: ${s}`, summarize(dedup.filter((r) => r.setup === s))));
    for (const d of ["up", "down"]) L.push(row(`direction: ${d}`, summarize(dedup.filter((r) => r.direction === d))));
    for (const sym of SR_SYMBOLS) L.push(row(sym, summarize(dedup.filter((r) => r.symbol === sym))));
    const tags = [...new Set(dedup.map((r) => r.vixTag))];
    for (const v of tags) L.push(row(`VIX ${v}`, summarize(dedup.filter((r) => r.vixTag === v))));
    L.push("");
    const tiers = ["S", "A", "B", "C", "D"].map((t) => `${t}: ${dedup.filter((r) => r.tier === t && r.grade.status !== "pending").length}`).join(" · ");
    L.push(`Graded calls per alert tier (gate needs 30 per tier per lane): ${tiers}. Flow-joined calls: ${dedup.filter((r) => r.flowSig).length}.`);
    L.push("");
    const worst = dedup.filter((r) => r.level.score >= 55 && r.grade.status === "failed").sort((a, b) => b.level.score - a.level.score).slice(0, 8);
    if (worst.length) {
      L.push("Where levels ≥ 55 failed (highest-scored first):");
      L.push("");
      L.push("| t (ET) | sym | level | zone | score | setup→dir | bars held | MAE (ATR) | sources |");
      L.push("|---|---|---|---|---|---|---|---|---|");
      for (const r of worst) L.push(`| ${r.t} | ${r.symbol} | ${r.level.label} | ${r.level.lo.toFixed(2)}–${r.level.hi.toFixed(2)} | ${r.level.score} | ${r.setup}→${r.direction} | ${r.grade.barsHeld} | ${r.grade.maeAtr} | ${r.level.sources.map((s) => s.label).join(", ")} |`);
      L.push("");
    }
  }
  L.push(`## Flow join`);
  L.push("");
  L.push(`trading.db has ${flowCount} SPY/QQQ live flow signals. Each was logged after the close (Oct 23) or on the weekend (Oct 25), so **no flow signal falls inside a replayed session window**. The replay is level-only, which means every call is capped at C (digest) or D (log), per the "no flow → nothing above C" rule. Level-only vs level+flow cannot be compared yet.`);
  L.push("");
  return L.join("\n");
}

async function main() {
  const sessions = arg("--sessions", 30);
  const res = await replay({ sessions, l4Extended: arg("--l4-extended", 500) });
  const md = report(res, sessions);
  const day = etNow().date;
  const path = join(ROOT, "analysis", `sr-replay-${day}.md`);
  writeFileSync(path, md);
  const summary = Object.fromEntries(Object.entries(res.out).map(([k, v]) => [k, {
    all: summarize(v.dedup),
    strong: summarize(v.dedup.filter((r) => r.level.score >= 70)),
    moderate: summarize(v.dedup.filter((r) => r.level.score >= 55 && r.level.score < 70)),
    weak: summarize(v.dedup.filter((r) => r.level.score < 55)),
    up: summarize(v.dedup.filter((r) => r.direction === "up")),
    down: summarize(v.dedup.filter((r) => r.direction === "down")),
    defend: summarize(v.dedup.filter((r) => r.setup === "defend")),
    break: summarize(v.dedup.filter((r) => r.setup === "break")),
    fail: summarize(v.dedup.filter((r) => r.setup === "fail")),
  }]));
  writeFileSync(join(ROOT, "analysis", `sr-replay-${day}.json`), JSON.stringify(summary, null, 1));
  console.log(`Report: ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.stack); process.exit(1); });
}
