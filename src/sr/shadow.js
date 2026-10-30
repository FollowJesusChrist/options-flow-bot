// sr/shadow.js — one live SHADOW pass (spec §11 steps 3–4). Vault only, never Discord.
//
// Usage: node src/sr/shadow.js   (via ./run-sr.sh shadow)
//   1. record SPY/QQQ bars (recorder)
//   2. run the level engine + state machine over today's decision bars
//   3. join flow signals (trading.db, read-only) and score contract fit from the
//      LIVE chain (delta/IV recomputed from the live mid; Tradier Greeks lag ~1h)
//   4. alert score → tier → what delivery it WOULD get, run the anti-spam rules
//      against a shadow ledger, and record the posting-gate verdict
//   5. write level calls to sr.db (source='shadow') + exports/sr-shadow-<date>.md
//      and exports/sr-digest-<date>.md (hourly C roll-up, file only)
//   6. re-grade earlier shadow calls whose horizon has completed
// This module does not import the Discord sender. No cron/loop is created here.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openSrDb, saveCall } from "./store.js";
import { recordOnce, SR_SYMBOLS } from "./recorder.js";
import { LANES, levelsAt, atrOf } from "./levels.js";
import { runLane } from "./events.js";
import { loadCtx, loadFlow, joinFlow } from "./replay.js";
import { horizonEnd, gradeGeometry, realGeometry, mirrorGeometry } from "./grade.js";
import { scoreAlert, applyAntiSpam, recordLedger } from "./alert.js";
import { quietGate, loudGate } from "./post.js";
import { fitScore, impliedVol, yearsTo } from "./fit.js";
import { TradierRO } from "./tradier-ro.js";
import { etNow, dayOf, hv } from "./bars.js";
import { vixTag } from "../signals/context.js";
import { vaultDir } from "../tracker.js";

const mid = (o) => (Number(o.bid) > 0 && Number(o.ask) > 0 ? (Number(o.bid) + Number(o.ask)) / 2 : Number(o.last));

// Next opposing level edge beyond spot in the call's direction (excluding the event level).
function opposingLevel(levels, ev) {
  if (ev.direction === "up") {
    const above = levels.filter((l) => l.key !== ev.level.key && l.lo > ev.spot).sort((a, b) => a.lo - b.lo);
    return above[0] ? above[0].lo : null;
  }
  const below = levels.filter((l) => l.key !== ev.level.key && l.hi < ev.spot).sort((a, b) => b.hi - a.hi);
  return below[0] ? below[0].hi : null;
}

async function liveFit(client, ctx, ev, levels, contractSym, expiration, spot) {
  const chain = await client.chain(ctx.symbol, expiration);
  const c = chain.find((o) => o.symbol === contractSym);
  if (!c) return null;
  // ATM IV recomputed from the live mid (both sides, nearest strike)
  const T = yearsTo(expiration);
  const atmK = chain.reduce((best, o) => (Math.abs(o.strike - spot) < Math.abs(best - spot) ? o.strike : best), chain[0].strike);
  const ivs = chain.filter((o) => o.strike === atmK).map((o) => impliedVol(o.option_type, spot, o.strike, T, mid(o))).filter(Number.isFinite);
  const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : NaN;
  const closes = ctx.frames.daily.map((b) => b.close);
  return fitScore({
    contract: c, spot, opposing: opposingLevel(levels, ev),
    dailyAtr: atrOf(ctx, "daily", `${dayOf(ev.t)}T09:30:00`), hv20: hv(closes, 20), atmIv,
  });
}

// Re-grade shadow calls still pending.
function regrade(db, ctxs, lastSessionComplete) {
  const rows = db.prepare("SELECT * FROM level_calls WHERE source = 'shadow'").all();
  let updated = 0;
  for (const r of rows) {
    const g = r.grade ? JSON.parse(r.grade) : null;
    if (g && g.status !== "pending") continue;
    const ctx = ctxs[r.symbol];
    const bars = ctx.frames[LANES[r.lane].decision];
    const i = bars.findIndex((b) => b.t === r.t);
    if (i < 0) continue;
    const ev = { direction: r.direction, spot: r.spot, atr: atrOf(ctx, LANES[r.lane].decision, bars[i].closeT), level: { lo: r.zone_lo, hi: r.zone_hi } };
    const end = horizonEnd(bars, i, r.lane, { lastSessionComplete });
    const grade = gradeGeometry(bars, i, end, realGeometry(ev));
    const mirror = gradeGeometry(bars, i, end, mirrorGeometry(ev));
    db.prepare("UPDATE level_calls SET grade = ?, control_grade = ? WHERE id = ?").run(JSON.stringify(grade), JSON.stringify({ mirror }), r.id);
    updated++;
  }
  return updated;
}

export async function shadowOnce({ now = new Date(), log = console.log } = {}) {
  const client = new TradierRO();
  const db = openSrDb();
  const runId = `shadow-${now.toISOString()}`;
  const et = etNow(now);
  const nowT = `${et.date}T${et.hm}:00`;

  await recordOnce({ client, db, now, log });
  const ctxs = Object.fromEntries(SR_SYMBOLS.map((s) => [s, loadCtx(db, s)]));
  const flow = loadFlow(SR_SYMBOLS);
  const quotes = Object.fromEntries((await client.quotes([...SR_SYMBOLS, "VIX"])).map((q) => [q.symbol, q]));
  const vix = Number(quotes.VIX?.last);
  const lastSessionComplete = et.mins >= 16 * 60;

  const calls = [];
  const snapshot = {};
  const pending = [];
  for (const sym of SR_SYMBOLS) {
    const ctx = ctxs[sym];
    for (const lane of ["L0", "L1", "L2", "L4"]) {
      const bars = ctx.frames[LANES[lane].decision];
      if (!bars.length) continue;
      const session = dayOf(bars[bars.length - 1].t);
      // warm states up from the previous session (daily: 10 bars), keep only this session's events
      let start;
      if (LANES[lane].decision === "daily") start = bars.length - 10;
      else {
        const days = ctx.sessions[LANES[lane].decision];
        start = bars.findIndex((b) => dayOf(b.t) === days[days.length - 2]);
      }
      let lastLevels = [];
      const events = runLane(ctx, lane, start, bars.length - 1, { onBar: (i, lv) => { if (i === bars.length - 1) lastLevels = lv; } })
        .filter((e) => dayOf(e.t) === session);
      snapshot[`${sym} ${lane}`] = lastLevels.sort((a, b) => b.score - a.score).slice(0, 5);
      for (const ev of events) pending.push({ sym, lane, ev, ctx, session });
    }
  }
  // Anti-spam is order-dependent: replay the whole session chronologically each
  // pass against a fresh shadow ledger, so repeated passes are idempotent.
  for (const s of new Set(pending.map((p) => p.session))) db.prepare("DELETE FROM alert_ledger WHERE session = ?").run(`shadow:${s}`);
  pending.sort((a, b) => (a.ev.closeT < b.ev.closeT ? -1 : a.ev.closeT > b.ev.closeT ? 1 : 0));
  for (const { sym, lane, ev, ctx, session } of pending) {
    const flowSig = joinFlow(flow, ev);
    let fit = null;
    if (flowSig && !LANES[lane].watchOnly) {
      try {
        const occ = flowSig.ref_id.split("@")[0];
        fit = await liveFit(client, ctx, ev, levelsAt(ctx, lane, ev.closeT, ev.spot), occ, flowSig.expiration, Number(quotes[sym]?.last));
      } catch (e) { log(`fit failed for ${flowSig.ref_id}: ${e.message}`); }
    }
    const a = scoreAlert({
      lane, watchOnly: LANES[lane].watchOnly, levelScore: ev.level.score, setup: ev.setup, direction: ev.direction,
      flow: flowSig, fit, tags: ev.tags, eventRisk: ev.level.eventRisk,
    });
    const call = {
      id: `shadow|${sym}|${lane}|${ev.level.key}|${ev.transition}|${ev.direction}|${ev.t}`,
      source: "shadow", runId, symbol: sym, lane, watchOnly: LANES[lane].watchOnly,
      levelKey: ev.level.key, levelLabel: ev.level.label, levelPrice: ev.level.mid, zone: [ev.level.lo, ev.level.hi],
      sources: ev.level.sources, levelScore: ev.level.score, setup: ev.setup, transition: ev.transition,
      direction: ev.direction, alertScore: a.alertScore, tier: a.tier, caps: [...a.caps, ...ev.tags], labels: a.labels,
      flowRefId: flowSig?.ref_id ?? null, contract: fit ? { ...fit.contract, fitScore: fit.score, fitParts: fit.parts } : null,
      spot: ev.spot, t: ev.t, vixTag: vixTag(vix), delivery: a.delivery,
    };
    const spam = applyAntiSpam(db, call, { session: `shadow:${session}`, nowT: ev.closeT });
    if (spam.delivery !== call.delivery) call.caps.push(`anti-spam: ${spam.reason}`);
    call.delivery = spam.delivery;
    if (call.delivery === "loud" || call.delivery === "quiet") recordLedger(db, call, { session: `shadow:${session}` });
    const gate = call.delivery === "loud" ? loudGate(db, process.env, lane, call.tier)
      : call.delivery === "quiet" || call.delivery === "digest" ? quietGate(process.env) : { open: false, why: [`delivery=${call.delivery}`] };
    call.deliveryBlocked = `shadow mode (never posts)${gate.open ? "" : "; gate shut: " + gate.why.join("; ")}`;
    saveCall(db, call);
    calls.push(call);
  }
  const regraded = regrade(db, ctxs, lastSessionComplete);
  return { runId, nowT, calls, snapshot, quotes, vix, regraded, ctxs, db };
}

function fmtCall(c) {
  return `| ${c.t.slice(11, 16) || c.t} | ${c.symbol} | ${c.lane}${c.watchOnly ? " (watch)" : ""} | ${c.levelLabel} ${c.zone[0].toFixed(2)}–${c.zone[1].toFixed(2)} | ${c.levelScore} | ${c.transition} ${c.direction === "up" ? "▲" : "▼"} | ${c.alertScore} | ${c.tier} | ${c.delivery} | ${c.flowRefId ?? "—"} | ${c.caps.join("; ")} |`;
}

function writeExports(res) {
  const { nowT, calls, snapshot, quotes, vix, regraded, db } = res;
  const day = nowT.slice(0, 10);
  const dir = join(vaultDir(), "exports");
  mkdirSync(dir, { recursive: true });
  const wouldPost = calls.filter((c) => c.delivery === "loud" || c.delivery === "quiet");
  const L = [];
  L.push(`# S/R shadow log — ${day}`);
  L.push("");
  L.push(`> SHADOW MODE: vault only, nothing posted. Paper mode, 0/30 validation gate. Not trade calls.`);
  L.push(`> Pass at ${nowT} ET · SPY ${quotes.SPY?.last} · QQQ ${quotes.QQQ?.last} · VIX ${vix} (${vixTag(vix)}) · run \`${res.runId}\``);
  L.push("");
  L.push(`**Transitions today:** ${calls.length} (${calls.filter((c) => !c.watchOnly).length} alertable-lane, ${calls.filter((c) => c.watchOnly).length} watch-only). ` +
    `**Would-post (B+ after anti-spam):** ${wouldPost.length} (spec budget: ≤ 10/day; ~0–4 expected). ` +
    `By delivery: ${["loud", "quiet", "digest", "log", "watch-log"].map((d) => `${d} ${calls.filter((c) => c.delivery === d).length}`).join(" · ")}. ` +
    `Flow-joined: ${calls.filter((c) => c.flowRefId).length}. Earlier shadow calls re-graded this pass: ${regraded}.`);
  L.push("");
  L.push("| time | sym | lane | level / zone | level | transition | alert | tier | delivery | flow | caps / tags |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of calls.filter((c) => !c.watchOnly)) L.push(fmtCall(c));
  L.push("");
  L.push(`<details><summary>Watch-only L0/L1 transitions (${calls.filter((c) => c.watchOnly).length}) — logged and graded, never alerted</summary>`);
  L.push("");
  L.push("| time | sym | lane | level / zone | level | transition | alert | tier | delivery | flow | caps / tags |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of calls.filter((c) => c.watchOnly)) L.push(fmtCall(c));
  L.push("</details>");
  L.push("");
  L.push("## Levels in force at the last bar (top 5 per lane by score)");
  L.push("");
  for (const [k, lv] of Object.entries(snapshot)) {
    L.push(`**${k}:** ` + (lv.length ? lv.map((l) => `${l.label} ${l.lo.toFixed(2)}–${l.hi.toFixed(2)} (${l.score}${l.eventRisk.length ? ", event risk" : ""})`).join(" · ") : "none"));
    L.push("");
  }
  const graded = db.prepare("SELECT grade FROM level_calls WHERE source='shadow' AND grade IS NOT NULL").all().map((r) => JSON.parse(r.grade));
  L.push(`## Shadow grading to date`);
  L.push("");
  L.push(`Shadow calls on file: ${db.prepare("SELECT COUNT(*) n FROM level_calls WHERE source='shadow'").get().n}. Graded: ${graded.filter((g) => g.status !== "pending").length}, respected ${graded.filter((g) => g.status === "respected").length}, pending ${graded.filter((g) => g.status === "pending").length}.`);
  writeFileSync(join(dir, `sr-shadow-${day}.md`), L.join("\n") + "\n");

  const D = [`# S/R hourly digest (C tier) — ${day}`, "", "> File only. The Discord digest is wired but OFF until Maple verifies the shadow results.", ""];
  const cs = calls.filter((c) => c.delivery === "digest");
  const hours = [...new Set(cs.map((c) => (c.t.length > 10 ? c.t.slice(11, 13) : "daily")))];
  for (const h of hours) {
    D.push(`## ${h === "daily" ? "daily close" : `${h}:00 ET`}`);
    for (const c of cs.filter((c) => (c.t.length > 10 ? c.t.slice(11, 13) : "daily") === h)) {
      D.push(`- ${c.symbol} ${c.lane} ${c.levelLabel} ${c.zone[0].toFixed(2)}–${c.zone[1].toFixed(2)} ${c.transition} (level ${c.levelScore}, ${c.caps[0] ?? ""})`);
    }
    D.push("");
  }
  if (!cs.length) D.push("No C-tier calls this session.");
  writeFileSync(join(dir, `sr-digest-${day}.md`), D.join("\n") + "\n");
  return { journal: join(dir, `sr-shadow-${day}.md`), digest: join(dir, `sr-digest-${day}.md`), wouldPost: wouldPost.length };
}

async function main() {
  const client = new TradierRO();
  if (!client.hasToken) {
    console.log("Shadow not started — no Tradier token in env (use ./run-sr.sh shadow).");
    process.exit(0);
  }
  const res = await shadowOnce();
  const out = writeExports(res);
  const by = (d) => res.calls.filter((c) => c.delivery === d).length;
  console.log(`Shadow pass ${res.nowT} ET: ${res.calls.length} transitions · loud ${by("loud")} · quiet ${by("quiet")} · digest ${by("digest")} · log ${by("log")} · watch ${by("watch-log")} · would-post ${out.wouldPost} · posted 0 (shadow).`);
  console.log(`Journal: ${out.journal}\nDigest:  ${out.digest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.stack); process.exit(1); });
}
