// sr/events.js — per-level state machine on the lane's decision frame (spec §5).
//
// States: idle(side) → testing → held | provisional break → confirmed | failed.
// Only three transitions produce calls: held, break-confirmed, break-failed.
// Everything is evaluated at a decision-bar CLOSE using levels knowable at that
// bar's OPEN — the replay and the live shadow run the exact same code.

import { LANES, levelsAt, sideOf, atrOf } from "./levels.js";
import { dayOf, minsOf } from "./bars.js";

const opp = (s) => (s === "above" ? "below" : "above");

function decisionAsOf(bar, lane) {
  return LANES[lane].decision === "daily" ? `${bar.t}T09:30:00` : bar.t;
}

function qualityTags(bar, lane, isFirstOfSession) {
  const tags = [];
  if (LANES[lane].decision !== "daily") {
    const m = minsOf(bar.t);
    if (m === 570) tags.push("first-5-min");
    if (m >= 690 && m < 840) tags.push("lunch-lull");
  }
  if (isFirstOfSession && LANES[lane].decision !== "daily") tags.push("session-open-bar");
  return tags;
}

// Step one decision bar for one level. Mutates `st`, returns an event or null.
export function step(st, bar, lo, hi, relVol, isFirstOfSession, lane) {
  const W = hi - lo;
  const pos = sideOf(bar.close, lo, hi);

  if (st.phase === "init") {
    if (pos !== "inside") { st.side = pos; st.phase = "idle"; }
    return null;
  }
  // Gap open through the zone: the level was skipped, not tested (§5/§9).
  if (isFirstOfSession && LANES[lane].decision !== "daily" && st.phase !== "provisional") {
    const openPos = sideOf(bar.open, lo, hi);
    if (openPos !== "inside" && openPos !== st.side) {
      st.side = openPos; st.phase = "idle"; st.skipped = true;
      return null;
    }
  }

  if (st.phase === "idle" || st.phase === "testing") {
    const touched = st.side === "above" ? bar.low <= hi : bar.high >= lo;
    if (st.phase === "idle" && !touched) return null;
    if (pos === st.side) {
      st.phase = "idle";
      return { transition: "held", setup: "defend", direction: st.side === "above" ? "up" : "down" };
    }
    if (pos === "inside") { st.phase = "testing"; return null; }
    // closed beyond the far edge
    if (relVol >= 1.5) {
      st.phase = "provisional";
      st.prov = { from: st.side, to: pos, k: 0, ft: false };
      return null;
    }
    // close beyond on light volume: not a break (spec). If it runs a full zone
    // width past the far edge, the level was eroded silently — flip, no call.
    const far = pos === "below" ? lo - bar.close : bar.close - hi;
    if (far >= W) { st.side = pos; st.phase = "idle"; }
    else st.phase = "testing";
    return null;
  }

  if (st.phase === "provisional") {
    const p = st.prov;
    p.k++;
    const backInside = pos === "inside" || pos === p.from;
    if (backInside && p.k <= 3) {
      st.phase = "idle"; st.side = p.from; st.prov = null;
      return { transition: "break-failed", setup: "fail", direction: p.from === "above" ? "up" : "down" };
    }
    if (p.to === "below" && bar.low <= lo - W) p.ft = true;
    if (p.to === "above" && bar.high >= hi + W) p.ft = true;
    const retest = (p.to === "below" ? bar.high >= lo : bar.low <= hi) && pos === p.to;
    if ((retest && p.k <= 6) || (p.ft && p.k >= 3 && !backInside)) {
      st.phase = "idle"; st.side = p.to; st.prov = null; st.broken = true;
      return { transition: "break-confirmed", setup: "break", direction: p.to === "above" ? "up" : "down" };
    }
    if (backInside) { st.phase = "testing"; st.side = p.to; st.prov = null; return null; } // late reclaim attempt from new side
    if (p.k > 6) { st.phase = "idle"; st.side = p.to; st.prov = null; }
    return null;
  }
  return null;
}

// Run the state machine for one symbol+lane over decision bars [startIdx..endIdx].
// `onBar(i, levels)` lets the caller observe levels (shadow uses the last one).
export function runLane(ctx, lane, startIdx, endIdx, { onBar } = {}) {
  const bars = ctx.frames[LANES[lane].decision];
  const relVolFn = ctx.relVol[LANES[lane].decision];
  const states = new Map();
  const events = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const bar = bars[i];
    const asOf = decisionAsOf(bar, lane);
    const levels = levelsAt(ctx, lane, asOf, bar.open);
    if (onBar) onBar(i, levels);
    const isFirst = i === 0 || dayOf(bars[i - 1].t) !== dayOf(bar.t);
    const rv = relVolFn ? relVolFn(i) : NaN;
    const live = new Set();
    for (const lv of levels) {
      live.add(lv.key);
      let st = states.get(lv.key);
      if (!st) {
        // initialise from the previous close; inside-the-zone starts in 'init'
        const prev = bars[i - 1];
        const s = prev ? sideOf(prev.close, lv.lo, lv.hi) : "inside";
        st = s === "inside" ? { phase: "init" } : { phase: "idle", side: s };
        states.set(lv.key, st);
      }
      const ev = step(st, bar, lv.lo, lv.hi, rv, isFirst, lane);
      if (!ev) continue;
      events.push({
        ...ev,
        symbol: ctx.symbol, lane, i, t: bar.t, closeT: bar.closeT, spot: bar.close,
        level: lv, relVol: Number.isFinite(rv) ? +rv.toFixed(2) : null,
        atr: atrOf(ctx, LANES[lane].decision, bar.closeT),
        tags: qualityTags(bar, lane, isFirst),
      });
    }
    for (const k of states.keys()) if (!live.has(k)) states.delete(k);
  }
  return events;
}
