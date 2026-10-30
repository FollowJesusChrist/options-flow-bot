// sr/grade.js — grading at the lane horizon (spec §8) + baselines.
//
// One test for every call: did price move >= 1 zone width in the expected
// direction (from the call close) BEFORE a decision-frame close through the
// invalidation edge, within the horizon?
//   up calls   (defend support / upside break / failed downside break): invalid = close < zone low
//   down calls (mirror):                                                invalid = close > zone high
// Same-bar target+invalidation counts as NOT respected (intrabar order unknown).
//
// Baselines:
//   mirror  — spec §8: a random control level at the same distance from spot on
//             the opposite side, graded with the mirrored rule. Under a driftless
//             walk it has the same odds as the real call, so real − mirror is the edge.
//             Caveat: in a trending tape it also measures drift (reported per direction).
//   randtime — extra diagnostic (not in spec): same direction and same geometry
//             in ATR units, at a random decision bar. Isolates level+timing from drift.

import { LANES } from "./levels.js";
import { dayOf } from "./bars.js";

// Last decision-bar index inside the call's horizon, or Infinity if the horizon
// is not complete in the data yet (→ 'pending'). `lastSessionComplete` is true
// when the newest stored session has closed (replay after 16:00 ET).
export function horizonEnd(bars, i, lane, { lastSessionComplete = true } = {}) {
  const h = LANES[lane].horizon;
  if (h.type === "bars") return i + h.n;
  const extra = h.type === "session" ? 0 : h.n;
  let sess = 0;
  for (let j = i + 1; j < bars.length; j++) {
    if (dayOf(bars[j].t) !== dayOf(bars[j - 1].t)) sess++;
    if (sess > extra) return j - 1;
  }
  return sess === extra && lastSessionComplete ? bars.length - 1 : Infinity;
}

// geometry: { dir: 'up'|'down', spot, invalid (price), target (price), atr }
export function gradeGeometry(bars, i, end, g) {
  let mfe = 0, mae = 0;
  const last = Math.min(end, bars.length - 1);
  for (let j = i + 1; j <= last; j++) {
    const b = bars[j];
    const fav = g.dir === "up" ? b.high - g.spot : g.spot - b.low;
    const adv = g.dir === "up" ? g.spot - b.low : b.high - g.spot;
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);
    const hitT = g.dir === "up" ? b.high >= g.target : b.low <= g.target;
    const inval = g.dir === "up" ? b.close < g.invalid : b.close > g.invalid;
    if (inval) return { status: "failed", barsHeld: j - i - 1, mfeAtr: +(mfe / g.atr).toFixed(2), maeAtr: +(mae / g.atr).toFixed(2) };
    if (hitT) return { status: "respected", barsHeld: j - i, mfeAtr: +(mfe / g.atr).toFixed(2), maeAtr: +(mae / g.atr).toFixed(2), partial: j < last };
  }
  if (end === Infinity || end > bars.length - 1) return { status: "pending", barsHeld: last - i, mfeAtr: +(mfe / g.atr).toFixed(2), maeAtr: +(mae / g.atr).toFixed(2) };
  return { status: "expired", barsHeld: last - i, mfeAtr: +(mfe / g.atr).toFixed(2), maeAtr: +(mae / g.atr).toFixed(2) };
}

export function realGeometry(ev) {
  const { lo, hi } = ev.level;
  const W = hi - lo;
  const up = ev.direction === "up";
  return { dir: ev.direction, spot: ev.spot, invalid: up ? lo : hi, target: up ? ev.spot + W : ev.spot - W, atr: ev.atr };
}

// Mirror: reflect the zone across spot; the direction flips.
export function mirrorGeometry(ev) {
  const g = realGeometry(ev);
  return {
    dir: g.dir === "up" ? "down" : "up", spot: g.spot,
    invalid: 2 * g.spot - g.invalid, target: 2 * g.spot - g.target, atr: g.atr,
  };
}

// Same direction, same ATR-scaled geometry, at bar r.
export function randTimeGeometry(ev, bars, r, atrAtR) {
  const g = realGeometry(ev);
  const s = atrAtR / g.atr;
  const spot = bars[r].close;
  return {
    dir: g.dir, spot, atr: atrAtR,
    invalid: spot + (g.invalid - g.spot) * s,
    target: spot + (g.target - g.spot) * s,
  };
}

// Seeded RNG (mulberry32) so replays are reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Exact two-sided binomial sign test on discordant pairs.
export function signTestP(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let p = 0;
  let coef = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) coef = (coef * (n - i + 1)) / i;
    p += coef;
  }
  return Math.min(1, (2 * p) / Math.pow(2, n));
}
