// sr/levels.js — level engine (spec §1–§3, robust set only).
//
// Every level carries `knownAt` (ET wall clock): the moment it became knowable.
// levelsAt(ctx, lane, asOf) only uses bars whose CLOSE is <= asOf, and swing
// pivots are only usable N bars after they form (no hindsight swing points).
//
// Not built (spec marks them fragile / v2): trendlines, 9/21 EMA levels, fib,
// GEX, max pain. VWAPs, volume-profile nodes and round numbers are moving or
// weak, so they are CONFLUENCE-ONLY here: they add to a zone, never anchor one.

import { atrAt, to1h, closeTimeOf, dayOf, sessionDates, makeTodRelVol, makeDailyRelVol, sma, minsOf } from "./bars.js";
import { eventsInWindow } from "./calendar.js";

export const LANES = {
  L0: { watchOnly: true, decision: "5min", windowSessions: 1, distAtr: 1.0, horizon: { type: "session" }, dte: [0, 0] },
  L1: { watchOnly: true, decision: "5min", windowSessions: 3, distAtr: 1.5, horizon: { type: "sessions", n: 2 }, dte: [1, 2] },
  L2: { watchOnly: false, decision: "15min", windowSessions: 10, distAtr: 3.0, horizon: { type: "sessions", n: 5 }, dte: [3, 7] },
  L4: { watchOnly: false, decision: "daily", windowSessions: 60, distAtr: 6.0, horizon: { type: "bars", n: 15 }, dte: [15, 9999] },
};
// L3 (8–14 DTE) is not built in v1 (spec §9 "start narrow": L2 + L4 alertable).

const HALF_LIFE_SESSIONS = { "5min": 1, "15min": 3, "60min": 7, daily: 30, weekly: 130, monthly: 130 };
const INTRADAY = new Set(["5min", "15min", "60min"]);
const FLOOR = 0.1; // SPY/QQQ zone half-width floor ($)

// ---------- context (precomputed once per symbol) ----------

function weekKey(day) {
  const d = new Date(day + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  return new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10);
}

function aggregate(daily, keyFn) {
  const out = [];
  for (const b of daily) {
    const k = keyFn(b.t);
    const cur = out[out.length - 1];
    if (!cur || cur.key !== k) out.push({ key: k, t: b.t, lastT: b.t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; cur.lastT = b.t; }
  }
  // A week/month bar is knowable only after its LAST day closes. The newest
  // bucket may be incomplete in live use; its close time is its last stored day,
  // which is > asOf for any asOf inside that bucket — so it is never used early.
  return out.map((b) => ({ ...b, closeT: `${b.lastT}T16:00:00` }));
}

function withClose(bars, interval) {
  return bars.map((b) => ({ ...b, closeT: closeTimeOf(b, interval) }));
}

// Last COMPLETED week/month bucket before asOf's own bucket. Key-based, so a
// partial current week in live data is never mistaken for the prior week.
function lastBucket(bars, asOf, keyFn) {
  const k = keyFn(dayOf(asOf));
  let i = bars.length - 1;
  while (i >= 0 && bars[i].key >= k) i--;
  return i;
}
const monthKey = (t) => t.slice(0, 7);

// Last index with closeT <= asOf (binary search), or -1.
function lastKnown(bars, asOf) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].closeT <= asOf) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

function pivots(bars, n, frame) {
  const out = [];
  for (let k = n; k < bars.length - n; k++) {
    let isH = true, isL = true;
    for (let j = 1; j <= n; j++) {
      if (!(bars[k].high > bars[k - j].high && bars[k].high > bars[k + j].high)) isH = false;
      if (!(bars[k].low < bars[k - j].low && bars[k].low < bars[k + j].low)) isL = false;
    }
    const knownAt = bars[k + n].closeT; // confirmed only N bars later
    const confirmKey = bars[k + n].key ?? null; // weekly: the confirming bucket must be complete
    if (isH) out.push({ price: bars[k].high, hl: "H", t: bars[k].t, knownAt, confirmKey, frame });
    if (isL) out.push({ price: bars[k].low, hl: "L", t: bars[k].t, knownAt, confirmKey, frame });
  }
  return out;
}

export function buildContext(symbol, { daily, m5, m15, pre5 = [] }) {
  const d = withClose(daily, "daily");
  const f5 = withClose(m5, "5min");
  const f15 = withClose(m15, "15min");
  const h1 = withClose(to1h(m15), "60min");
  const weekly = aggregate(daily, weekKey);
  const monthly = aggregate(daily, monthKey);
  const dayHL = new Map(d.map((b) => [b.t, b]));
  return {
    symbol,
    frames: { "5min": f5, "15min": f15, "60min": h1, daily: d, weekly, monthly },
    pre5: withClose(pre5, "5min"),
    pivots: {
      "5min": pivots(f5, 3, "5min"),
      "15min": pivots(f15, 3, "15min"),
      "60min": pivots(h1, 3, "60min"),
      daily: pivots(d, 5, "daily"),
      weekly: pivots(weekly, 2, "weekly"),
    },
    relVol: { "5min": makeTodRelVol(f5), "15min": makeTodRelVol(f15), daily: makeDailyRelVol(d) },
    dayHL,
    sessions: { "5min": sessionDates(f5), "15min": sessionDates(f15), daily: d.map((b) => b.t) },
    profileCache: new Map(),
  };
}

export function atrOf(ctx, frame, asOf) {
  const f = frame === "monthly" ? "weekly" : frame; // monthly zones use weekly ATR (documented)
  const bars = ctx.frames[f];
  const i = f === "weekly" ? lastBucket(bars, asOf, weekKey) : lastKnown(bars, asOf);
  return i < 1 ? NaN : atrAt(bars, i, 14);
}

function halfWidth(ctx, frame, asOf) {
  const k = INTRADAY.has(frame) ? 0.25 : 0.15;
  return Math.max(FLOOR, k * atrOf(ctx, frame, asOf));
}

// ---------- level sources ----------

const PRIOR = { weeklyHL: 15, sma200: 15, pdhl: 12, sma50: 12, gap: 12, pdc: 10, or: 10, avwap: 10, ema20: 10, pivot: 8, pre: 5, round: 5, profile: 0 };

// event key: two sources from the same price event count once (independence rule)
// Only a CLOSED day's high/low may be used (today's final high is hindsight).
// Otherwise pivots at the same price on the same day are the same event.
function dayEventKey(ctx, day, price, hl, asOf) {
  const b = ctx.dayHL.get(day);
  if (b && b.closeT <= asOf) {
    if (hl === "H" && Math.abs(b.high - price) < 1e-6) return `${day}:H`;
    if (hl === "L" && Math.abs(b.low - price) < 1e-6) return `${day}:L`;
  }
  return `${day}:${hl}:${price.toFixed(2)}`;
}

function sessionStartIdx(sessions, asOfDay, n) {
  const i = sessions.findIndex((s) => s >= asOfDay);
  const end = i === -1 ? sessions.length : i;
  return sessions[Math.max(0, end - n)];
}

function vwapBands(bars) {
  let pv = 0, v = 0;
  for (const b of bars) { pv += (b.vwap ?? b.close) * b.volume; v += b.volume; }
  if (!v) return null;
  const vw = pv / v;
  let s2 = 0;
  for (const b of bars) s2 += b.volume * ((b.vwap ?? b.close) - vw) ** 2;
  return { vwap: vw, sd: Math.sqrt(s2 / v) };
}

// Volume profile from bars knowable before the session of asOf (cached per session).
function profileAt(ctx, lane, asOf) {
  const day = dayOf(asOf);
  const key = `${lane}|${day}`;
  if (ctx.profileCache.has(key)) return ctx.profileCache.get(key);
  let bars, bin;
  if (lane === "L4") {
    const d = ctx.frames.daily;
    const i = lastKnown(d, asOf);
    bars = d.slice(Math.max(0, i - 59), i + 1);
    bin = 0.25 * atrAt(d, i, 14);
  } else {
    const f5 = ctx.frames["5min"];
    const startDay = sessionStartIdx(ctx.sessions["5min"], day, 20);
    bars = f5.filter((b) => dayOf(b.t) >= startDay && dayOf(b.t) < day);
    const avgRange = sma(bars.slice(-390).map((b) => b.high - b.low));
    bin = Math.max(FLOOR, avgRange); // bin >= 5m average range, or it invents structure
  }
  let prof = null;
  if (bars.length >= 20 && bin > 0) {
    const lo = Math.min(...bars.map((b) => b.low));
    const n = Math.ceil((Math.max(...bars.map((b) => b.high)) - lo) / bin) + 1;
    const vol = new Array(n).fill(0);
    for (const b of bars) {
      const a = Math.floor((b.low - lo) / bin), z = Math.floor((b.high - lo) / bin);
      for (let k = a; k <= z; k++) vol[k] += b.volume / (z - a + 1);
    }
    const poc = vol.indexOf(Math.max(...vol));
    const sorted = [...vol].sort((x, y) => x - y);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    const center = (k) => lo + (k + 0.5) * bin;
    prof = { poc: center(poc), hvn: vol.map((x, k) => (x >= p80 ? center(k) : null)).filter((x) => x != null), bin };
  }
  ctx.profileCache.set(key, prof);
  return prof;
}

function rawSources(ctx, lane, asOf, spot) {
  const S = [];
  const day = dayOf(asOf);
  const d = ctx.frames.daily;
  const di = lastKnown(d, asOf);
  if (di < 1) return S;
  const datr = atrAt(d, di, 14);
  const add = (s) => S.push({ standalone: true, ...s });

  // Prior day H/L/C
  const pd = d[di];
  add({ key: `PDH:${pd.t}`, label: "PDH", price: pd.high, family: "structure", frame: "daily", prior: PRIOR.pdhl, knownAt: pd.closeT, event: `${pd.t}:H` });
  add({ key: `PDL:${pd.t}`, label: "PDL", price: pd.low, family: "structure", frame: "daily", prior: PRIOR.pdhl, knownAt: pd.closeT, event: `${pd.t}:L` });
  add({ key: `PDC:${pd.t}`, label: "PDC", price: pd.close, family: "structure", frame: "daily", prior: PRIOR.pdc, knownAt: pd.closeT, event: `${pd.t}:C` });

  // Prior week (and month for L4) H/L
  const w = ctx.frames.weekly, wi = lastBucket(w, asOf, weekKey);
  if (wi >= 0) {
    add({ key: `PWH:${w[wi].key}`, label: "prior-week high", price: w[wi].high, family: "structure", frame: "weekly", prior: PRIOR.weeklyHL, knownAt: w[wi].closeT, event: null });
    add({ key: `PWL:${w[wi].key}`, label: "prior-week low", price: w[wi].low, family: "structure", frame: "weekly", prior: PRIOR.weeklyHL, knownAt: w[wi].closeT, event: null });
  }
  if (lane === "L4") {
    const m = ctx.frames.monthly, mi = lastBucket(m, asOf, monthKey);
    if (mi >= 0) {
      add({ key: `PMH:${m[mi].key}`, label: "prior-month high", price: m[mi].high, family: "structure", frame: "monthly", prior: PRIOR.weeklyHL, knownAt: m[mi].closeT, event: null });
      add({ key: `PML:${m[mi].key}`, label: "prior-month low", price: m[mi].low, family: "structure", frame: "monthly", prior: PRIOR.weeklyHL, knownAt: m[mi].closeT, event: null });
    }
  }

  // Moving averages (daily, knowable at the prior close)
  const closes = d.slice(0, di + 1).map((b) => b.close);
  if (closes.length >= 200) add({ key: `SMA200:${pd.t}`, label: "200d SMA", price: sma(closes.slice(-200)), family: "ma", frame: "daily", prior: PRIOR.sma200, knownAt: pd.closeT, event: null, moving: true });
  if (closes.length >= 50) add({ key: `SMA50:${pd.t}`, label: "50d SMA", price: sma(closes.slice(-50)), family: "ma", frame: "daily", prior: PRIOR.sma50, knownAt: pd.closeT, event: null, moving: true });
  if (lane === "L2" || lane === "L4") {
    let e = closes[Math.max(0, closes.length - 100)];
    for (const c of closes.slice(Math.max(0, closes.length - 99))) e = e + (2 / 21) * (c - e);
    add({ key: `EMA20:${pd.t}`, label: "20d EMA", price: e, family: "ma", frame: "daily", prior: PRIOR.ema20, knownAt: pd.closeT, event: null, moving: true });
  }

  // Unfilled daily gaps (edges), last 120 sessions
  for (let k = Math.max(1, di - 119); k <= di; k++) {
    const a = d[k - 1], b = d[k];
    let lo = null, hi = null;
    if (b.low > a.high) { lo = a.high; hi = b.low; }
    else if (b.high < a.low) { lo = b.high; hi = a.low; }
    if (lo == null) continue;
    let filled = false;
    for (let m = k + 1; m <= di && !filled; m++) {
      if (b.low > a.high ? d[m].low <= a.high : d[m].high >= a.low) filled = true;
    }
    if (filled) continue;
    add({ key: `GAP:${b.t}:lo`, label: `gap edge (${b.t})`, price: lo, family: "gap", frame: "daily", prior: PRIOR.gap, knownAt: b.closeT, event: `gap:${b.t}` });
    add({ key: `GAP:${b.t}:hi`, label: `gap edge (${b.t})`, price: hi, family: "gap", frame: "daily", prior: PRIOR.gap, knownAt: b.closeT, event: `gap:${b.t}` });
  }

  // Swing pivots, by lane
  const pivotFrames = {
    L0: [["5min", 1]],
    L1: [["5min", 3], ["15min", 3]],
    L2: [["15min", 10], ["60min", 10], ["daily", 60]],
    L4: [["daily", 260], ["weekly", 520]],
  }[lane];
  for (const [frame, nSess] of pivotFrames) {
    let fromDay;
    if (frame === "daily" || frame === "weekly") fromDay = d[Math.max(0, di - nSess + 1)].t;
    else fromDay = sessionStartIdx(ctx.sessions[frame === "60min" ? "15min" : frame], day, nSess);
    for (const p of ctx.pivots[frame]) {
      if (p.knownAt > asOf || dayOf(p.t) < fromDay) continue;
      if (frame === "weekly" && p.confirmKey >= weekKey(day)) continue;
      const ev = frame === "daily" ? `${p.t}:${p.hl}` : dayEventKey(ctx, dayOf(p.t), p.price, p.hl, asOf);
      add({ key: `P${frame}${p.hl}:${p.t}`, label: `${frame} swing ${p.hl === "H" ? "high" : "low"}`, price: p.price, family: "structure", frame, prior: PRIOR.pivot, knownAt: p.knownAt, event: ev });
    }
  }

  // Intraday-only sources (today)
  if (lane === "L0" || lane === "L1") {
    const today5 = ctx.frames["5min"].filter((b) => dayOf(b.t) === day && b.closeT <= asOf);
    if (lane === "L0") {
      for (const [mins, lab] of [[15, "OR15"], [30, "OR30"]]) {
        const orBars = today5.filter((b) => minsOf(b.t) < 570 + mins);
        if (orBars.length === mins / 5) {
          const kt = orBars[orBars.length - 1].closeT;
          add({ key: `${lab}H:${day}`, label: `${lab} high`, price: Math.max(...orBars.map((b) => b.high)), family: "structure", frame: "5min", prior: PRIOR.or, knownAt: kt, event: `${day}:${lab}H` });
          add({ key: `${lab}L:${day}`, label: `${lab} low`, price: Math.min(...orBars.map((b) => b.low)), family: "structure", frame: "5min", prior: PRIOR.or, knownAt: kt, event: `${day}:${lab}L` });
        }
      }
    }
    const pre = ctx.pre5.filter((b) => dayOf(b.t) === day && minsOf(b.t) >= 240);
    if (pre.length >= 6 && asOf >= `${day}T09:30:00`) {
      add({ key: `PMH:${day}`, label: "premarket high", price: Math.max(...pre.map((b) => b.high)), family: "structure", frame: "5min", prior: PRIOR.pre, knownAt: `${day}T09:30:00`, event: null });
      add({ key: `PML:${day}`, label: "premarket low", price: Math.min(...pre.map((b) => b.low)), family: "structure", frame: "5min", prior: PRIOR.pre, knownAt: `${day}T09:30:00`, event: null });
    }
    const vb = today5.length >= 3 ? vwapBands(today5) : null;
    if (vb) {
      for (const [m, lab] of [[0, "session VWAP"], [1, "VWAP +1σ"], [-1, "VWAP −1σ"], [2, "VWAP +2σ"], [-2, "VWAP −2σ"]]) {
        S.push({ standalone: false, key: `VWAP${m}:${asOf}`, label: lab, price: vb.vwap + m * vb.sd, family: "vwap", frame: "5min", prior: PRIOR.avwap, knownAt: asOf, event: null });
      }
    }
  }
  if (lane === "L2") {
    const wk = weekKey(day);
    const wb = ctx.frames["15min"].filter((b) => weekKey(dayOf(b.t)) === wk && b.closeT <= asOf);
    const vb = wb.length >= 2 ? vwapBands(wb) : null;
    if (vb) S.push({ standalone: false, key: `WAVWAP:${wk}`, label: "week-anchored VWAP", price: vb.vwap, family: "vwap", frame: "15min", prior: PRIOR.avwap, knownAt: asOf, event: null });
  }
  if (lane === "L4") {
    const mb = d.slice(0, di + 1).filter((b) => b.t.slice(0, 7) === d[di].t.slice(0, 7));
    const tp = mb.map((b) => ({ vwap: (b.high + b.low + b.close) / 3, volume: b.volume }));
    const vb = tp.length >= 2 ? vwapBands(tp) : null;
    if (vb) S.push({ standalone: false, key: `MAVWAP:${d[di].t.slice(0, 7)}`, label: "month-anchored VWAP", price: vb.vwap, family: "vwap", frame: "daily", prior: PRIOR.avwap, knownAt: asOf, event: null });
  }

  // Volume profile POC (confluence) and round numbers (confluence)
  const prof = profileAt(ctx, lane, asOf);
  if (prof) S.push({ standalone: false, key: `POC:${lane}:${day}`, label: "volume POC", price: prof.poc, family: "profile", frame: lane === "L4" ? "daily" : "5min", prior: PRIOR.profile, knownAt: asOf, event: null });
  const step = 5;
  for (let r = Math.ceil((spot - 3 * datr) / step) * step; r <= spot + 3 * datr; r += step) {
    S.push({ standalone: false, key: `RND:${r}`, label: `$${r} round`, price: r, family: "round", frame: "none", prior: PRIOR.round, knownAt: asOf, event: null });
  }

  const maxDist = LANES[lane].distAtr * datr;
  return S.filter((s) => Number.isFinite(s.price) && Math.abs(s.price - spot) <= maxDist);
}

// ---------- zones + merge ----------

function mergeZones(ctx, sources, asOf) {
  const anchors = sources.filter((s) => s.standalone).map((s) => {
    const h = halfWidth(ctx, s.frame, asOf);
    return { lo: s.price - h, hi: s.price + h, h, members: [s] };
  }).sort((a, b) => a.lo - b.lo);
  const zones = [];
  for (const z of anchors) {
    const cur = zones[zones.length - 1];
    if (cur && z.lo <= cur.hi) {
      cur.members.push(...z.members);
      cur.hMax = Math.max(cur.hMax, z.h);
      cur.lo = Math.min(cur.lo, z.lo);
      cur.hi = Math.max(cur.hi, z.hi);
    } else zones.push({ ...z, hMax: z.h });
  }
  for (const z of zones) {
    // Union, capped at 2x the wider half-width, centred on the prior-weighted price.
    const wsum = z.members.reduce((s, m) => s + m.prior, 0);
    const c = z.members.reduce((s, m) => s + m.price * m.prior, 0) / wsum;
    const cap = 2 * z.hMax;
    z.lo = Math.max(z.lo, c - cap);
    z.hi = Math.min(z.hi, c + cap);
    z.mid = (z.lo + z.hi) / 2;
    const kept = z.members.filter((m) => m.price >= z.lo && m.price <= z.hi);
    z.members = kept.length ? kept : [z.members.sort((a, b) => b.prior - a.prior)[0]];
    for (const s of sources) if (!s.standalone && s.price >= z.lo && s.price <= z.hi) z.members.push(s);
  }
  return zones;
}

// ---------- walking a zone over decision bars (touches, tests, breaks) ----------

export function sideOf(close, lo, hi) {
  return close > hi ? "above" : close < lo ? "below" : "inside";
}

// Count respected touches on decision-frame bars[from..to].
function walkZone(bars, from, to, lo, hi, atr) {
  const W = hi - lo;
  let side = null;
  let entered = false, entryBar = -1;
  const touches = [];
  let tests = 0;
  let broken = false;
  for (let i = from; i <= to; i++) {
    const b = bars[i];
    const pos = sideOf(b.close, lo, hi);
    if (side === null) { if (pos !== "inside") side = pos; continue; }
    const touched = side === "above" ? b.low <= hi : b.high >= lo;
    if (touched && !entered) { entered = true; entryBar = i; tests++; }
    if (!entered) continue;
    if (pos === side) {
      // closed back out on the same side: measure reaction until re-entry (max 10 bars)
      let best = 0;
      for (let j = i; j <= Math.min(to, i + 10); j++) {
        const m = side === "above" ? bars[j].high - hi : lo - bars[j].low;
        best = Math.max(best, m);
        if (j > i && (side === "above" ? bars[j].low <= hi : bars[j].high >= lo)) break;
      }
      if (best >= W) touches.push({ i: entryBar, reactionAtr: best / atr });
      entered = false;
    } else if (pos !== "inside") {
      broken = !broken; // closed through: polarity flips
      side = pos;
      entered = false;
    }
  }
  return { touches, tests, broken, side };
}

// ---------- score ----------

function touchPoints(n) {
  return [0, 7, 13, 18, 20][Math.min(n, 4)];
}

export function scoreZone(ctx, lane, z, asOf, decisionBars, di) {
  const L = LANES[lane];
  const standalone = z.members.filter((m) => m.standalone);
  const primary = [...standalone].sort((a, b) => b.prior - a.prior || (a.knownAt < b.knownAt ? 1 : -1))[0];
  const structural = Math.max(...standalone.map((m) => m.prior));
  const decFrame = L.decision;
  const decAtr = atrOf(ctx, decFrame, asOf);

  // touch window: lane window start, but not before the level was knowable
  const sess = ctx.sessions[decFrame === "daily" ? "daily" : decFrame];
  const winStart = sessionStartIdx(sess, dayOf(asOf), L.windowSessions);
  const knownAt = standalone.reduce((a, m) => (m.knownAt < a ? m.knownAt : a), standalone[0].knownAt);
  let from = di;
  while (from > 0 && decisionBars[from - 1].closeT > knownAt && dayOf(decisionBars[from - 1].t) >= winStart) from--;
  const walk = walkZone(decisionBars, from, di, z.lo, z.hi, decAtr);

  const tPts = touchPoints(walk.touches.length);
  const reactions = walk.touches.map((t) => t.reactionAtr).sort((a, b) => a - b);
  const med = reactions.length ? reactions[Math.floor(reactions.length / 2)] : 0;
  const rPts = 15 * Math.min(1, med);

  const prof = profileAt(ctx, lane, asOf);
  let vPts = 0;
  if (prof) {
    if (prof.poc >= z.lo && prof.poc <= z.hi) vPts += 8;
    else if (prof.hvn.some((p) => p >= z.lo - prof.bin / 2 && p <= z.hi + prof.bin / 2)) vPts += 5;
  }
  const rv = ctx.relVol[decFrame];
  if (walk.touches.length && rv) {
    const loud = walk.touches.filter((t) => rv(t.i) >= 1.5).length;
    vPts += 7 * (loud / walk.touches.length);
  }

  // confluence: independent sources from a different frame or method family
  const seen = new Set([`${primary.family}|${primary.frame}`]);
  const events = new Set(primary.event ? [primary.event] : []);
  let conf = 0;
  for (const m of z.members) {
    if (m === primary) continue;
    const fk = `${m.family}|${m.frame}`;
    if (seen.has(fk)) continue;
    if (m.event && events.has(m.event)) continue; // same price event counts once
    seen.add(fk);
    if (m.event) events.add(m.event);
    conf += 8;
  }
  conf = Math.min(25, conf);

  // recency multiplier
  // age in sessions: completed sessions after the level's day, +1 for today if later.
  // Counted from asOf's calendar day, not from whether today's bars exist yet, so
  // live (partial store) and replay (full store) agree.
  const kd = dayOf(primary.knownAt), ad = dayOf(asOf);
  const ageSessions = sess.filter((s) => s > kd && s < ad).length + (ad > kd ? 1 : 0);
  let rec = Math.pow(0.5, ageSessions / (HALF_LIFE_SESSIONS[primary.frame] ?? 30));
  if (primary.frame === "weekly" || primary.frame === "monthly" || primary.label === "200d SMA") rec = Math.max(0.4, rec);

  const raw = structural + tPts + rPts + vPts + conf;
  const penalties = [];
  if (walk.tests >= 3) penalties.push(["tested 3+ times", -10]);
  if (walk.broken) penalties.push(["broken, not reclaimed (polarity flipped)", -15]);
  const ev = eventsInWindow(dayOf(asOf), lane);
  if (ev.length) penalties.push([`event risk: ${ev.join(", ")}`, -10]);
  const pen = Math.max(-30, penalties.reduce((s, p) => s + p[1], 0));
  const score = Math.max(0, Math.min(100, raw * rec + pen));
  return {
    score: Math.round(score * 10) / 10,
    primary,
    knownAt,
    parts: { structural, touches: tPts, touchN: walk.touches.length, reaction: +rPts.toFixed(1), volume: +vPts.toFixed(1), confluence: conf, recency: +rec.toFixed(2), penalties },
    eventRisk: ev,
  };
}

// All scored zones for a lane as of `asOf` (the OPEN of decision bar di+1, i.e. the close of bar di).
export function levelsAt(ctx, lane, asOf, spot) {
  const decisionBars = ctx.frames[LANES[lane].decision];
  const di = lastKnown(decisionBars, asOf);
  if (di < 20) return [];
  const sources = rawSources(ctx, lane, asOf, spot);
  const zones = mergeZones(ctx, sources, asOf);
  return zones.map((z) => {
    const s = scoreZone(ctx, lane, z, asOf, decisionBars, di);
    return {
      key: s.primary.key, lane, lo: z.lo, hi: z.hi, mid: z.mid,
      label: s.primary.label, knownAt: s.knownAt,
      sources: z.members.map((m) => ({ key: m.key, label: m.label, price: +m.price.toFixed(2), family: m.family, frame: m.frame, knownAt: m.knownAt })),
      score: s.score, parts: s.parts, eventRisk: s.eventRisk,
    };
  });
}

export { lastKnown };
