// chart-webhook/frames.mjs — single-frame support/resistance for /chart interval +
// lookback. Pure, no I/O.
//
// The lane engine (src/sr/levels.js) mixes frames on purpose (L2 = 15m + 1h + daily
// pivots, plus prior-day/week levels and moving averages) and has fixed windows,
// so it can't answer "15m levels over 1 month". This module does, with the same
// building blocks and none of the engine's code changed:
//   - frame bars: 5m / 15m / daily as loaded by chart-cmd/data.js (completed bars
//     only); 1h and 4h are grouped from regular-session 15m bars anchored at 09:30
//     ET, exactly like src/sr/bars.js to1h (toNh(bars15, 60) equals to1h).
//   - swing pivots, 3 bars each side, confirmed only 3 bars later (the engine's
//     intraday pivot rule), inside the lookback window only; plus the window's
//     high and low.
//   - zone half-width = 0.25 × ATR(14) intraday / 0.15 × ATR(14) daily, floor $0.10,
//     same as the engine. Overlapping zones merge (capped at 2× the wider half-width).
//   - turns = distinct bars where price turned inside the zone (swing points, window
//     high/low); visits = separate visits of price into the zone inside the window.
// Nearest zone fully below spot = support, fully above = resistance, preferring zones
// where price turned at least twice, then the window high/low, then any zone.
// Informational only — no proven edge vs random.

import { atrAt, minsOf, dayOf, closeTimeOf } from "../src/sr/bars.js";
import { INTERVALS, LOOKBACKS, MIN_FRAME_BARS } from "./command.mjs";

const PIVOT_N = 3;
const FLOOR = 0.1;
const MIN_TURNS = 2;
const pad2 = (n) => String(n).padStart(2, "0");
const hm = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

export const addDays = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Group regular-session 15m bars into `minutes`-long bars anchored at 09:30 ET, the
// same way src/sr/bars.js to1h does (last slot of the day is short, capped at 16:00).
// 4h → 09:30–13:30 and 13:30–16:00. closeT = slot end, so a partial slot is
// never treated as closed.
export function toNh(bars15, minutes) {
  const out = [];
  let cur = null;
  for (const b of bars15) {
    const slot = Math.floor((minsOf(b.t) - 570) / minutes);
    const key = `${dayOf(b.t)}#${slot}`;
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur);
      const sm = 570 + slot * minutes;
      cur = { key, t: `${dayOf(b.t)}T${hm(sm)}:00`, session: "regular", open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, lastT: b.t, pv: (b.vwap ?? b.close) * b.volume, end: Math.min(sm + minutes, 960) };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.lastT = b.t;
      cur.pv += (b.vwap ?? b.close) * b.volume;
    }
  }
  if (cur) out.push(cur);
  return out.map(({ key, pv, end, ...b }) => ({ ...b, vwap: b.volume ? pv / b.volume : b.close, closeT: `${dayOf(b.t)}T${hm(end)}:00` }));
}

// All completed bars of one frame (engine bars from chart-cmd/data.js loadSymbolBars).
export function frameBars(engine, frame, nowT) {
  const done = (bars) => bars.filter((b) => b.closeT <= nowT);
  if (frame === "5m") return done(engine.m5.map((b) => ({ ...b, closeT: closeTimeOf(b, "5min") })));
  if (frame === "15m") return done(engine.m15.map((b) => ({ ...b, closeT: closeTimeOf(b, "15min") })));
  if (frame === "1h") return done(toNh(engine.m15, 60));
  if (frame === "4h") return done(toNh(engine.m15, 240));
  return done(engine.daily.map((b) => ({ ...b, closeT: closeTimeOf(b, "daily") })));
}

// Bars inside the lookback window: day > today − days.
export function windowOf(bars, today, lookback) {
  const cutoff = addDays(today, -LOOKBACKS[lookback].days);
  const i = bars.findIndex((b) => dayOf(b.t) > cutoff);
  return { from: i === -1 ? bars.length : i, cutoff };
}

function pivots(bars, from) {
  const out = [];
  for (let k = Math.max(from, PIVOT_N); k < bars.length - PIVOT_N; k++) {
    let isH = true, isL = true;
    for (let j = 1; j <= PIVOT_N; j++) {
      if (!(bars[k].high > bars[k - j].high && bars[k].high > bars[k + j].high)) isH = false;
      if (!(bars[k].low < bars[k - j].low && bars[k].low < bars[k + j].low)) isL = false;
    }
    if (isH) out.push({ price: bars[k].high, kind: "swing high", t: bars[k].t });
    if (isL) out.push({ price: bars[k].low, kind: "swing low", t: bars[k].t });
  }
  return out;
}

// Separate visits of price into [lo, hi] over bars[from..].
function visits(bars, from, lo, hi) {
  let n = 0, inside = false;
  for (let i = from; i < bars.length; i++) {
    const touch = bars[i].low <= hi && bars[i].high >= lo;
    if (touch && !inside) n++;
    inside = touch;
  }
  return n;
}

// Zones for one frame over a window. Returns { zones, atr, half, bars: windowed bars }.
export function frameZones(all, from, frame) {
  const win = all.slice(from);
  if (win.length < MIN_FRAME_BARS) return { zones: [], tooFew: true, bars: win };
  const atr = atrAt(all, all.length - 1, 14);
  const half = Math.max(FLOOR, (INTERVALS[frame].intraday ? 0.25 : 0.15) * atr);
  const hiBar = win.reduce((a, b) => (b.high > a.high ? b : a));
  const loBar = win.reduce((a, b) => (b.low < a.low ? b : a));
  const anchors = [
    ...pivots(all, from),
    { price: hiBar.high, kind: "window high", t: hiBar.t },
    { price: loBar.low, kind: "window low", t: loBar.t },
  ].map((p) => ({ lo: p.price - half, hi: p.price + half, members: [p] })).sort((a, b) => a.lo - b.lo);
  const zones = [];
  for (const z of anchors) {
    const cur = zones[zones.length - 1];
    if (cur && z.lo <= cur.hi) { cur.members.push(...z.members); cur.hi = Math.max(cur.hi, z.hi); }
    else zones.push({ ...z });
  }
  for (const z of zones) {
    const c = z.members.reduce((s, m) => s + m.price, 0) / z.members.length;
    z.lo = Math.max(z.lo, c - 2 * half);
    z.hi = Math.min(z.hi, c + 2 * half);
    z.mid = (z.lo + z.hi) / 2;
    z.visits = visits(all, from, z.lo, z.hi);
    z.turns = new Set(z.members.map((m) => m.t)).size;
    z.extreme = z.members.some((m) => m.kind.startsWith("window"));
    const top = z.members.find((m) => m.kind.startsWith("window")) ?? z.members[z.members.length - 1];
    z.label = `${frame} ${top.kind}`;
    z.key = `${frame}:${top.kind}:${top.t}`;
    z.score = z.turns + z.visits; // logged for inspection only, not an edge
  }
  return { zones, atr, half, bars: win, tooFew: false };
}

export function pickLevels(zones, spot) {
  const pick = (cands, cmp) => cands.filter((z) => z.turns >= MIN_TURNS).sort(cmp)[0]
    ?? cands.filter((z) => z.extreme).sort(cmp)[0] ?? cands.sort(cmp)[0] ?? null;
  return {
    support: pick(zones.filter((z) => z.hi < spot), (a, b) => b.hi - a.hi),
    resistance: pick(zones.filter((z) => z.lo > spot), (a, b) => a.lo - b.lo),
  };
}

// What happened at the shown zones in the latest session (daily frame: the last
// daily bar). held = price came into the zone and closed back out on the side it
// came from; broke = a close on the other side. Plain, unconfirmed: card text says so.
const money = (p) => `$${p.toFixed(p < 10 ? 3 : 2)}`;
const STATUS = {
  "held|above": { key: "support-held", title: "Support Held", text: (r) => `price dipped into ${r} and closed back above it` },
  "held|below": { key: "resistance-held", title: "Resistance Held", text: (r) => `price pushed into ${r} and closed back below it` },
  "broke|above": { key: "resistance-broke", title: "Resistance Broke", text: (r) => `price closed above ${r} (one close, not confirmed)` },
  "broke|below": { key: "support-broke", title: "Support Broke", text: (r) => `price closed below ${r} (one close, not confirmed)` },
};
export function latestStatus(bars, frame, picked) {
  if (bars.length < 2) return { status: { key: "none", title: "Between Levels" }, event: null };
  const lastDay = dayOf(bars[bars.length - 1].t);
  let s = frame === "daily" ? bars.length - 1 : bars.findIndex((b) => dayOf(b.t) === lastDay);
  s = Math.max(1, s);
  const events = [];
  for (const [role, z] of Object.entries(picked)) {
    if (!z) continue;
    const pos = (c) => (c > z.hi ? "above" : c < z.lo ? "below" : "inside");
    let side = pos(bars[s - 1].close);
    let entered = false;
    for (let i = s; i < bars.length; i++) {
      const b = bars[i], p = pos(b.close);
      if (side === "inside") { if (p !== "inside") side = p; continue; }
      if (side === "above" ? b.low <= z.hi : b.high >= z.lo) entered = true;
      if (p !== "inside" && p !== side) { events.push({ kind: "broke", side: p, role, bar: b }); side = p; entered = false; }
      else if (entered && p === side) { events.push({ kind: "held", side, role, bar: b }); entered = false; }
    }
  }
  events.sort((a, b) => (a.bar.closeT < b.bar.closeT ? -1 : 1));
  const e = events[events.length - 1];
  if (!e) return { status: { key: "none", title: "Between Levels" }, event: null };
  const st = STATUS[`${e.kind}|${e.side}`];
  const z = picked[e.role];
  return { status: { ...st, text: st.text(`${money(z.lo)}–${money(z.hi)}`) }, event: { lane: frame === "daily" ? "L4" : frame, t: e.bar.t, closeT: e.bar.closeT, kind: e.kind, role: e.role } };
}
