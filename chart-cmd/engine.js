// chart-cmd/engine.js — run the existing S/R engine (src/sr/levels.js + events.js)
// for one ticker and pick the nearest support below and resistance above.
// Reuses the engine unchanged. Levels are informational: the sr-replay report
// shows no edge vs the random control, so nothing here is a signal.

import { buildContext, levelsAt, LANES } from "../src/sr/levels.js";
import { runLane } from "../src/sr/events.js";
import { dayOf } from "../src/sr/bars.js";

const ALL_LANES = ["L0", "L1", "L2", "L4"];
export const MIN_SCORE = 10; // display filter only; the score itself carries no proven edge

// Engine events for the lane's latest session (same warm-up as src/sr/shadow.js).
function sessionEvents(ctx, lane) {
  const bars = ctx.frames[LANES[lane].decision];
  if (bars.length < 25) return [];
  const session = dayOf(bars[bars.length - 1].t);
  let start;
  if (LANES[lane].decision === "daily") start = bars.length - 10;
  else {
    const days = ctx.sessions[LANES[lane].decision];
    start = Math.max(1, bars.findIndex((b) => dayOf(b.t) === days[Math.max(0, days.length - 2)]));
  }
  return runLane(ctx, lane, start, bars.length - 1).filter((e) => dayOf(e.t) === session);
}

// Plain-English status from an engine event's transition + expected direction.
export function describeEvent(ev) {
  if (!ev) return { key: "none", title: "Between Levels" };
  const k = `${ev.transition}|${ev.direction}`;
  return {
    "held|down": { key: "resistance-held", title: "Resistance Held", text: "price closed back below the red zone" },
    "held|up": { key: "support-held", title: "Support Held", text: "price closed back above the green zone" },
    "break-confirmed|up": { key: "resistance-broke", title: "Resistance Broke", text: "price closed above the zone and the break was confirmed" },
    "break-confirmed|down": { key: "support-broke", title: "Support Broke", text: "price closed below the zone and the break was confirmed" },
    "break-failed|down": { key: "resistance-failed", title: "Resistance Break Failed", text: "price pushed above, then closed back below" },
    "break-failed|up": { key: "support-failed", title: "Support Break Failed", text: "price dipped below, then closed back above" },
  }[k];
}

// opts: { lane: "L0".."L4" | null (nearest across lanes), nowT, spot }
export function analyze(symbol, engineBars, { lane = null, nowT, spot }) {
  const ctx = buildContext(symbol, engineBars);
  const lanes = lane ? [lane] : ALL_LANES;
  const zones = [];
  for (const L of lanes) {
    let lv = [];
    try { lv = levelsAt(ctx, L, nowT, spot); } catch { lv = []; } // too little history for this lane
    for (const z of lv) zones.push({ ...z, lane: L });
  }
  // Nearest zone fully below / fully above spot. Zones the engine scores under
  // MIN_SCORE (stale or untested) are skipped unless nothing else is in range.
  const pick = (cands, cmp) => (cands.filter((z) => z.score >= MIN_SCORE).sort(cmp)[0] ?? cands.sort(cmp)[0] ?? null);
  const support = pick(zones.filter((z) => z.hi < spot), (a, b) => b.hi - a.hi);
  const resistance = pick(zones.filter((z) => z.lo > spot), (a, b) => a.lo - b.lo);

  // Latest held / broke / failed on either displayed zone in the latest session.
  const picked = [support, resistance].filter(Boolean);
  const events = [];
  for (const L of new Set(picked.map((z) => z.lane))) {
    const keys = new Set(picked.filter((z) => z.lane === L).map((z) => z.key));
    for (const ev of sessionEvents(ctx, L)) if (keys.has(ev.level.key)) events.push(ev);
  }
  events.sort((a, b) => (a.closeT < b.closeT ? -1 : a.closeT > b.closeT ? 1 : 0));
  const last = events[events.length - 1] ?? null;
  return {
    support, resistance, zonesConsidered: zones.length,
    event: last && { transition: last.transition, direction: last.direction, t: last.t, closeT: last.closeT, lane: last.lane, levelKey: last.level.key },
    status: describeEvent(last),
  };
}
