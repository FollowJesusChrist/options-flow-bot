// test-sr.js — checks for the S/R bot. Run: node scripts/test-sr.js
// 1. No look-ahead: levels computed on the full store == levels computed on a
//    store truncated at asOf (what the live engine would have had).
// 2. State machine: held / break-confirmed / break-failed on synthetic bars.
// 3. Grading + mirror control symmetry.
// 4. Alert caps and posting gates (no flow → ≤C, wrong-way flow → C, watch-only, loud gate shut).
// 5. Read-only Tradier wrapper refuses non-/markets paths.

import assert from "node:assert/strict";
import { openSrDb, loadBars } from "../src/sr/store.js";
import { buildContext, levelsAt, LANES } from "../src/sr/levels.js";
import { step } from "../src/sr/events.js";
import { rng } from "../src/sr/grade.js";
import { gradeGeometry, realGeometry, mirrorGeometry, signTestP } from "../src/sr/grade.js";
import { scoreAlert } from "../src/sr/alert.js";
import { loudGate, quietGate } from "../src/sr/post.js";
import { TradierRO } from "../src/sr/tradier-ro.js";
import { closeTimeOf } from "../src/sr/bars.js";

let pass = 0;
const ok = (name, fn) => { try { fn(); } catch (e) { console.log(`  ✗ ${name}`); throw e; } pass++; console.log(`  ✓ ${name}`); };

// ---------- 1. look-ahead ----------
const db = openSrDb();
const raw = {
  daily: loadBars(db, "SPY", "daily"),
  m5: loadBars(db, "SPY", "5min"),
  m15: loadBars(db, "SPY", "15min"),
  pre5: loadBars(db, "SPY", "5min", { sessions: ["pre"] }),
};
const full = buildContext("SPY", raw);
const cut = (asOf) => buildContext("SPY", {
  daily: raw.daily.filter((b) => closeTimeOf(b, "daily") <= asOf),
  m5: raw.m5.filter((b) => closeTimeOf(b, "5min") <= asOf),
  m15: raw.m15.filter((b) => closeTimeOf(b, "15min") <= asOf),
  pre5: raw.pre5.filter((b) => closeTimeOf(b, "5min") <= asOf),
});
const norm = (lv) => lv.map((l) => `${l.key}|${l.lo.toFixed(4)}|${l.hi.toFixed(4)}|${l.score}`).sort().join("\n");
const probes = [
  ["L0", "2026-10-21T10:35:00"], ["L0", "2026-10-14T14:05:00"],
  ["L1", "2026-10-07T11:20:00"], ["L2", "2026-10-15T13:45:00"], ["L2", "2026-10-22T09:30:00"],
  ["L4", "2026-10-21T09:30:00"], ["L4", "2026-10-26T09:30:00"], ["L4", "2026-09-30T09:30:00"],
];
const R = rng(7);
for (const lane of ["L0", "L1", "L2", "L4"]) {
  const dec = full.frames[LANES[lane].decision];
  const lo = LANES[lane].decision === "daily" ? dec.length - 40 : dec.length - 30 * (lane === "L2" ? 26 : 78);
  for (let k = 0; k < 6; k++) {
    const b = dec[lo + Math.floor(R() * (dec.length - lo))];
    probes.push([lane, LANES[lane].decision === "daily" ? `${b.t}T09:30:00` : b.t]);
  }
}
for (const [lane, asOf] of probes) {
  ok(`no look-ahead ${lane} @ ${asOf}`, () => {
    const dec = full.frames[LANES[lane].decision];
    const bar = dec.find((b) => (LANES[lane].decision === "daily" ? `${b.t}T09:30:00` : b.t) === asOf);
    assert.ok(bar, "probe bar exists");
    const a = levelsAt(full, lane, asOf, bar.open);
    const b = levelsAt(cut(asOf), lane, asOf, bar.open);
    assert.ok(a.length > 0, "has levels");
    assert.equal(norm(a), norm(b));
  });
}

// ---------- 2. state machine on synthetic bars (zone 99–101, price above) ----------
const B = (o, h, l, c) => ({ t: "2026-01-05T10:00:00", open: o, high: h, low: l, close: c });
const run = (seq, st = { phase: "idle", side: "above" }) => seq.map(([bar, rv, first]) => step(st, bar, 99, 101, rv, !!first, "L2")?.transition ?? null);
ok("wick into zone, close back above → held (up)", () => {
  assert.deepEqual(run([[B(102, 102.2, 100.5, 101.5), 1]]), ["held"]);
});
ok("close below on 1.5x volume, back inside within 3 bars → break-failed", () => {
  assert.deepEqual(run([[B(101.5, 101.6, 98.2, 98.5), 2], [B(98.5, 98.9, 98, 98.6), 1], [B(98.6, 100.5, 98.5, 100), 1]]), [null, null, "break-failed"]);
});
ok("close below on volume + follow-through ≥ 1 zone width, no close back in 3 bars → break-confirmed", () => {
  assert.deepEqual(run([[B(101.5, 101.6, 98.2, 98.5), 2], [B(98.5, 98.6, 97.4, 97.5), 1], [B(97.5, 97.6, 96.4, 96.5), 1], [B(96.5, 96.7, 95.8, 96), 1]]), [null, null, null, "break-confirmed"]);
});
ok("retest from the new side that closes back outside → break-confirmed", () => {
  assert.deepEqual(run([[B(101.5, 101.6, 98.2, 98.5), 2], [B(98.5, 99.3, 98, 98.6), 1]]), [null, "break-confirmed"]);
});
ok("close below on light volume is NOT a break", () => {
  assert.deepEqual(run([[B(101.5, 101.6, 98.2, 98.5), 1.0], [B(98.5, 98.6, 98.1, 98.4), 1.0]]), [null, null]);
});
ok("gap open through the zone is skipped, not tested", () => {
  const st = { phase: "idle", side: "above" };
  assert.deepEqual(run([[B(96, 96.5, 95.5, 96.2), 3, true]], st), [null]);
  assert.equal(st.side, "below");
});

// ---------- 3. grading ----------
ok("grade: target before invalidation = respected; mirror symmetric", () => {
  const bars = [{ high: 10, low: 10, close: 10 }, { high: 10.6, low: 9.9, close: 10.5 }, { high: 11.2, low: 10.4, close: 11 }];
  const ev = { direction: "up", spot: 10, atr: 1, level: { lo: 9.5, hi: 9.9 } };
  const g = gradeGeometry(bars, 0, 2, realGeometry(ev));
  assert.equal(g.status, "respected");
  const m = gradeGeometry(bars, 0, 2, mirrorGeometry(ev));
  assert.equal(m.status, "failed"); // mirror: zone 10.1–10.5 expecting down; bar 2 closes 11 > 10.5 → invalid
  // symmetric world: reflect bars around 10 → mirror becomes respected
  const refl = bars.map((b) => ({ high: 20 - b.low, low: 20 - b.high, close: 20 - b.close }));
  assert.equal(gradeGeometry(refl, 0, 2, mirrorGeometry(ev)).status, "respected");
});
ok("grade: same-bar target + invalidation counts as not respected", () => {
  const bars = [{ high: 10, low: 10, close: 10 }, { high: 10.5, low: 9, close: 9.2 }];
  const g = gradeGeometry(bars, 0, 1, realGeometry({ direction: "up", spot: 10, atr: 1, level: { lo: 9.5, hi: 9.9 } }));
  assert.equal(g.status, "failed");
});
ok("sign test", () => { assert.equal(signTestP(0, 0), 1); assert.ok(signTestP(15, 2) < 0.01); });

// ---------- 4. alert caps + gates ----------
ok("no flow → nothing above C; strong level → digest", () => {
  const a = scoreAlert({ lane: "L2", watchOnly: false, levelScore: 85, setup: "defend", direction: "up" });
  assert.equal(a.tier, "C"); assert.equal(a.delivery, "digest");
  const b = scoreAlert({ lane: "L2", watchOnly: false, levelScore: 65, setup: "defend", direction: "up" });
  assert.equal(b.tier, "D"); assert.equal(b.delivery, "log");
});
ok("flow in the wrong direction caps at C", () => {
  const a = scoreAlert({ lane: "L2", watchOnly: false, levelScore: 90, setup: "defend", direction: "up",
    flow: { score: 100, option_type: "put" }, fit: { score: 100, caps: [], labels: [] } });
  assert.equal(a.tier, "C");
});
ok("coherent flow + fit can reach B (side-inferred half weight)", () => {
  const a = scoreAlert({ lane: "L2", watchOnly: false, levelScore: 90, setup: "defend", direction: "up",
    flow: { score: 100, option_type: "call" }, fit: { score: 100, caps: [], labels: [] } });
  assert.equal(a.tier, "A"); // 36 + 17.5 + 25 = 78.5
  assert.equal(a.delivery, "loud");
});
ok("lottery delta caps at C; event risk caps at B", () => {
  const a = scoreAlert({ lane: "L2", watchOnly: false, levelScore: 90, setup: "defend", direction: "up",
    flow: { score: 100, option_type: "call" }, fit: { score: 100, caps: ["lottery-ticket delta < 0.20 (cap C)"], labels: [] } });
  assert.equal(a.tier, "C");
  const b = scoreAlert({ lane: "L2", watchOnly: false, levelScore: 90, setup: "defend", direction: "up",
    flow: { score: 100, option_type: "call" }, fit: { score: 100, caps: [], labels: [] }, eventRisk: ["FOMC 2026-10-28"] });
  assert.equal(b.tier, "B");
});
ok("0–2 DTE lanes are watch-only", () => {
  const a = scoreAlert({ lane: "L0", watchOnly: true, levelScore: 90, setup: "defend", direction: "up",
    flow: { score: 100, option_type: "call" }, fit: { score: 100, caps: [], labels: [] } });
  assert.equal(a.delivery, "watch-log");
});
ok("posting gates are shut by default", () => {
  const env = {};
  assert.equal(quietGate(env).open, false);
  assert.equal(loudGate(db, env).open, false);
  // even with every env switch on, loud stays shut without 30 graded calls per tier beating control
  assert.equal(loudGate(db, { SR_POST_LOUD: "1", SR_POST_QUIET: "1", SR_CHANNEL_ID: "1", SR_SHADOW_VERIFIED: "1" }).open, false);
});

// ---------- 5. read-only ----------
await assert.rejects(() => new TradierRO({ token: "x" }).get("/accounts/123/orders"));
pass++; console.log("  ✓ TradierRO refuses non-/markets paths");

console.log(`\n${pass} checks passed.`);
