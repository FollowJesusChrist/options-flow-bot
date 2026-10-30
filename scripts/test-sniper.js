// test-sniper.js — sniper tier, spread trap, delta/lottery, premium tiers,
// time-of-day, DTE floor, and vault history wiring. Offline: synthetic chains,
// temp vault, fake Tradier client, fake poster. Never touches Discord.
// Exit 0 = all pass.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate env BEFORE importing modules that read it at call time.
const vault = mkdtempSync(join(tmpdir(), "sniper-vault-"));
process.env.TRADING_DATA_DIR = vault;
process.env.OPTIONS_POST_OVERRIDE = "1"; // lets runScan reach the (fake) poster
delete process.env.SNIPER_POST_ONLY;

const { scan, score, dteOf, sniperMisses, detectSpreadLegs, THRESHOLDS } = await import("../src/signals/unusual.js");
const { PREMIUM_TIERS, premiumBarFor, sniperPostOnly } = await import("../src/config.js");
const { openTradingDb, recordContractDaily, historyFor } = await import("../src/tracker.js");
const { runScan } = await import("../src/runner.js");
const { buildSignalEmbed } = await import("../src/discord/embeds.js");

let pass = 0, fail = 0;
const t = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const NEUTRAL = new Date("2026-10-15T14:00:00-04:00"); // Thu, mid-session
const POWER = new Date("2026-10-15T15:30:00-04:00");
const OPEN = new Date("2026-10-15T09:45:00-04:00");

// A contract that clears every sniper gate: AAPL, 37 DTE, delta 0.35,
// V/OI 5x, $2M premium. With 2 prior appearances, rising OI and a 7-day ADV
// it scores 90 neutral / 95 in power hour.
const base = (over = {}) => ({
  symbol: "AAPL261121C00260000", underlying: "AAPL", option_type: "call", strike: 260,
  expiration: "2026-11-21", volume: 10000, open_interest: 2000, bid: 1.95, ask: 2.05,
  greeks: { delta: 0.35, iv: 0.3 }, ...over,
});
const strongHist = { adv: 1000, advDays: 7, priorAppearances: 2, oiRising: true, dte: 37 };

// ---------- 1. DTE floor ----------
console.log("DTE floor:");
const nearNow = new Date("2026-10-21T11:12:00-04:00"); // 2.2 days before 10-23 16:00 ET
t("2.2 days out floors to 2 DTE", dteOf("2026-10-23", nearNow) === 2, `got ${dteOf("2026-10-23", nearNow)}`);
const q = scan([base({ symbol: "AAPL261023C00260000", expiration: "2026-10-23" })], { now: nearNow });
t("2.2 DTE contract quarantined", q.quarantined.length === 1 && q.signals.length === 0);
t("quarantine reason says 2 DTE", q.quarantined[0]?.reason.startsWith("2 DTE"), q.quarantined[0]?.reason);

// ---------- 2. Sniper tier ----------
console.log("sniper tier:");
const s0 = score(base(), { ...strongHist, now: POWER });
t("all conditions met -> tier S", s0.tier === "S" && s0.sniper, `tier=${s0.tier} score=${s0.score} misses=${s0.sniperMisses}`);
t("sniper factor recorded", s0.factors[0].startsWith("SNIPER"));
const neutral = score(base(), { ...strongHist, now: NEUTRAL });
t("all conditions met at neutral time scores 90 -> S", neutral.tier === "S" && neutral.score === 90, `score=${neutral.score}`);

const knockouts = [
  ["vOi < 3.0", base({ open_interest: 4000 }), strongHist, "V/OI"],
  ["oiRising false", base(), { ...strongHist, oiRising: false }, "OI not rising"],
  ["priorAppearances 1", base(), { ...strongHist, priorAppearances: 1 }, "prior appearances"],
  ["premium below SPY bar", base({ symbol: "SPY261121C00600000", underlying: "SPY", bid: 0.4, ask: 0.44 }), strongHist, "premium"],
  ["|delta| 0.65", base({ greeks: { delta: 0.65 } }), strongHist, "|delta|"],
  ["dte 6", base(), { ...strongHist, dte: 6 }, "DTE"],
  ["spreadSuspect", base(), { ...strongHist, spreadSuspect: true }, "spread"],
];
for (const [name, c, h, missKey] of knockouts) {
  const r = score(c, { ...h, now: POWER });
  t(`remove one gate (${name}) -> not S`, r.tier !== "S" && r.sniperMisses.some((m) => m.includes(missKey)),
    `tier=${r.tier} score=${r.score} misses=${r.sniperMisses}`);
}
// Gate-only knockouts (score stays >= 90) must top out at A, not S.
const gateOnly = score(base({ greeks: { delta: 0.65 } }), { ...strongHist, now: POWER });
t("score 90+ with a failed gate tops out at A", gateOnly.score >= 90 && gateOnly.tier === "A", `score=${gateOnly.score} tier=${gateOnly.tier}`);
const weak = score(base(), { dte: 37, now: POWER });
t("gates pass but score < 90 -> normal tiers", weak.tier !== "S" && weak.sniperMisses.length > 0);

// ---------- 3. Premium tiers ----------
console.log("premium tiers:");
t("PREMIUM_TIERS: SPY/QQQ $500K, default $100K",
  PREMIUM_TIERS.SPY === 500_000 && PREMIUM_TIERS.QQQ === 500_000 && premiumBarFor("AAPL") === 100_000);
const p200 = { bid: 1.95, ask: 2.05, volume: 1000, open_interest: 200 }; // 1000 * $2 * 100 = $200K
const spy200 = base({ ...p200, symbol: "SPY261121C00600000", underlying: "SPY" });
const aapl200 = base(p200);
const spyR = score(spy200, { ...strongHist, now: POWER });
const aaplR = score(aapl200, { ...strongHist, now: POWER });
t("$200K SPY premium -> not sniper", spyR.tier !== "S" && spyR.sniperMisses.some((m) => m.includes("premium")), spyR.sniperMisses.join(","));
t("$200K AAPL -> sniper-eligible on premium", !aaplR.sniperMisses.some((m) => m.includes("premium")), aaplR.sniperMisses.join(","));
t("premium gate checked directly", sniperMisses({ vOi: 5, oiRising: true, priorAppearances: 2, premium: 200_000, underlying: "QQQ", delta: 0.3, dte: 30 }).length === 1);

// ---------- 4. Delta / lottery ----------
console.log("delta:");
const lotto = score(base({ greeks: { delta: 0.08 } }), { ...strongHist, now: POWER });
t("|delta| 0.08 -> lottery flag", lotto.lottery === true && lotto.factors.some((f) => f.includes("lottery")));
t("|delta| 0.08 -> capped at C", lotto.tier === "C", `tier=${lotto.tier} score=${lotto.score}`);
const putLotto = score(base({ option_type: "put", greeks: { delta: -0.1 } }), { ...strongHist, now: POWER });
t("put delta -0.10 -> lottery, capped at C", putLotto.lottery && putLotto.tier === "C");
const d35 = score(base({ greeks: { delta: 0.35 } }), { ...strongHist, now: POWER });
t("|delta| 0.35 passes sniper delta gate", !d35.sniperMisses.some((m) => m.includes("delta")) && !d35.lottery);
const d18 = score(base({ greeks: { delta: 0.18 } }), { ...strongHist, now: POWER });
t("|delta| 0.18 -> not sniper, not lottery (no cap)", d18.tier === "A" && !d18.lottery, `tier=${d18.tier}`);

// ---------- 5. Spread / multi-leg trap ----------
console.log("spread trap:");
const leg = (sym, type, strike, volume, over = {}) => base({
  symbol: sym, option_type: type, strike, volume, open_interest: Math.round(volume / 5),
  greeks: { delta: type === "put" ? -0.35 : 0.35 }, ...over,
});
const straddle = [
  leg("AAPL261121C00260000", "call", 260, 10000),
  leg("AAPL261121P00260000", "put", 260, 4000),
];
const sp = scan(straddle, { now: POWER, history: Object.fromEntries(straddle.map((c) => [c.symbol, { ...strongHist, appearances: 2 }])) });
t("straddle: both legs flagged", sp.signals.length === 2 && sp.signals.every((s) => s.spreadSuspect), JSON.stringify(sp.signals.map((s) => [s.symbol, s.spreadSuspect])));
t("straddle: tier capped at C", sp.signals.every((s) => s.tier === "C"), sp.signals.map((s) => s.tier).join(","));
t("straddle: factor says not directional", sp.signals[0]?.factors.some((f) => f.startsWith("possible spread leg — not directional")));
t("straddle leg still reported (not dropped)", sp.signals.length === 2);

const vertical = [
  leg("AAPL261121C00260000", "call", 260, 10000),
  leg("AAPL261121C00270000", "call", 270, 6000),
];
const vt = detectSpreadLegs(vertical);
t("vertical: legs within 2x flagged", vt.size === 2 && vt.get("AAPL261121C00260000").startsWith("vertical"), [...vt.values()].join(" | "));
const vs = scan(vertical, { now: POWER, history: Object.fromEntries(vertical.map((c) => [c.symbol, { ...strongHist, appearances: 2 }])) });
t("vertical: tier capped at C", vs.signals.length && vs.signals.every((s) => s.tier === "C"), vs.signals.map((s) => s.tier).join(","));

t("vertical: 2.5x apart -> not flagged", detectSpreadLegs([vertical[0], leg("AAPL261121C00270000", "call", 270, 4000)]).size === 0);
t("straddle: put at 20% of call -> not flagged", detectSpreadLegs([straddle[0], leg("AAPL261121P00260000", "put", 260, 2000)]).size === 0);
t("different expirations never pair", detectSpreadLegs([vertical[0], leg("AAPL261218C00270000", "call", 270, 6000, { expiration: "2026-12-18" })]).size === 0);
t("stale partner (volume < OI) never pairs",
  detectSpreadLegs([vertical[0], leg("AAPL261121C00270000", "call", 270, 6000, { open_interest: 50000 })]).size === 0);
t("partner pool threshold is 1.0 V/OI", THRESHOLDS.spreadPartnerMinVOi === 1.0);

// ---------- 6. Time of day ----------
console.log("time of day:");
const morning = score(base(), { ...strongHist, now: OPEN });
const power = score(base(), { ...strongHist, now: POWER });
t("09:45 ET score < 15:30 ET score", morning.score < power.score, `${morning.score} vs ${power.score}`);
t("09:45 ET notes open noise x0.8", morning.factors.some((f) => f.includes("open noise")) && morning.score === Math.round(90 * 0.8));
t("15:30 ET notes power hour +5", power.factors.some((f) => f.includes("power hour")) && power.score === 95);
t("14:00 ET neutral", !neutral.factors.some((f) => f.includes("open noise") || f.includes("power hour")));
t("16:00 ET is outside power hour", !score(base(), { ...strongHist, now: new Date("2026-10-15T16:00:00-04:00") }).factors.some((f) => f.includes("power hour")));

// ---------- 7. History wiring (vault) ----------
console.log("history wiring:");
const db = openTradingDb(vault);
const SYM = "AAPL261121C00260000";
const rows = [
  ["2026-10-06", 600, 800], ["2026-10-07", 100, 800], // outside the 5-day window
  ["2026-10-08", 400, 850], ["2026-10-09", 200, 900], ["2026-10-12", 300, 900],
  ["2026-10-13", 0, 900], ["2026-10-14", 500, 1000],
];
for (const [date, volume, oi] of rows) recordContractDaily(db, [{ symbol: SYM, volume, open_interest: oi }], date);
recordContractDaily(db, [{ symbol: SYM, volume: 2400, open_interest: 1200 }], "2026-10-15");
const h = historyFor(db, SYM, { date: "2026-10-15" });
t("appearances = 4 (10-08,09,12,14; 10-13 had 0 volume)", h.appearances === 4, JSON.stringify(h));
t("oiRising: 1200 today > 1000 prior", h.oiRising === true);
t("advDays = 7 prior days (today excluded)", h.advDays === 7);
t("adv = mean of 7 prior days = 300", h.adv === 300, `adv=${h.adv}`);
recordContractDaily(db, [{ symbol: SYM, volume: 2600, open_interest: 1200 }], "2026-10-15");
t("same-day upsert overwrites, no duplicate row",
  db.prepare("SELECT COUNT(*) n, MAX(volume) v FROM contract_daily WHERE symbol=? AND date='2026-10-15'").get(SYM).v === 2600);

const SYM2 = "AAPL261121C00265000";
for (const [date, volume, oi] of [["2026-10-13", 50, 500], ["2026-10-14", 70, 600]]) {
  recordContractDaily(db, [{ symbol: SYM2, volume, open_interest: oi }], date);
}
recordContractDaily(db, [{ symbol: SYM2, volume: 900, open_interest: 550 }], "2026-10-15");
const h2 = historyFor(db, SYM2, { date: "2026-10-15" });
t("short history: adv null under 5 days", h2.adv === null && h2.advDays === 2, JSON.stringify(h2));
t("OI falling -> oiRising false", h2.oiRising === false);
t("no rows -> zeros", JSON.stringify(historyFor(db, "NOPE", { date: "2026-10-15" })) === JSON.stringify({ appearances: 0, oiRising: false, adv: null, advDays: 0 }));

const wired = scan([base({ volume: 2400, open_interest: 600, bid: 4.95, ask: 5.05 })], { history: { [SYM]: h }, advMap: { [SYM]: h.adv }, now: NEUTRAL });
const ws = wired.signals[0];
t("scan uses vault ADV, factor notes sample size (7d)", ws?.factors.some((f) => /^V\/ADV 8\.0x \(7d\)/.test(f)), ws?.factors.join(" | "));
t("scan uses vault appearances + oiRising", ws?.factors.some((f) => f.includes("repeat appearance x5")) && ws?.factors.some((f) => f.includes("OI rising")));
const short = score(base(), { advDays: 3, dte: 37 });
t("unknown ADV notes the short sample", short.factors.includes("V/ADV unknown (3d history, need 5)"), short.factors.join(" | "));

// ---------- 8. Runner wiring + posting gate (fake client, fake poster) ----------
console.log("runner (fake client, no Discord):");
const runNow = new Date("2026-10-16T15:30:00-04:00"); // Fri power hour
const SNIPE = "NVDA261120C00200000";
const SPREAD_A = "NVDA261120C00210000";
const SPREAD_B = "NVDA261120C00220000";
const fakeChain = [
  { symbol: SNIPE, underlying: "NVDA", option_type: "call", strike: 200, expiration: "2026-11-20", volume: 10000, open_interest: 2000, bid: 1.95, ask: 2.05, greeks: { delta: 0.4 } },
  // Pair whose volume clears the 4x vertical gap from SNIPE, but within 2x of each other.
  { symbol: SPREAD_A, underlying: "NVDA", option_type: "call", strike: 210, expiration: "2026-11-20", volume: 2000, open_interest: 400, bid: 2.95, ask: 3.05, greeks: { delta: 0.3 } },
  { symbol: SPREAD_B, underlying: "NVDA", option_type: "call", strike: 220, expiration: "2026-11-20", volume: 1500, open_interest: 300, bid: 2.45, ask: 2.55, greeks: { delta: 0.25 } },
  { symbol: "NVDA261023C00200000", underlying: "NVDA", option_type: "call", strike: 200, expiration: "2026-10-23", volume: 50, open_interest: 900, bid: 1, ask: 1.1, greeks: { delta: 0.5 } },
];
const exps = ["2026-10-23", "2026-10-30", "2026-11-06", "2026-11-20", "2026-12-18"];
const chainCalls = [];
const fakeClient = {
  expirations: async () => exps,
  chain: async (_sym, exp) => { chainCalls.push(exp); return fakeChain.filter((c) => c.expiration === exp); },
  quotes: async () => [],
  history: async () => [],
};
// Prior days: SNIPE traded on 10-14 and 10-15 with lower OI, 5 days of ADV.
for (const [date, vol, oi] of [["2026-10-09", 900, 1500], ["2026-10-12", 1100, 1500], ["2026-10-13", 0, 1500], ["2026-10-14", 1000, 1600], ["2026-10-15", 1000, 1700]]) {
  recordContractDaily(db, [{ symbol: SNIPE, volume: vol, open_interest: oi }], date);
}
const posts = [];
const logs = [];
const fakePost = async (s) => { posts.push(s); return { posted: true, messageId: "fake" }; };
const res = await runScan({ config: {}, client: fakeClient, db, watchlist: ["NVDA"], now: runNow, postFn: fakePost, log: (m) => logs.push(m) });
t("runner fetches first 4 expirations", chainCalls.length === 4 && !chainCalls.includes("2026-12-18"), chainCalls.join(","));
t("runner upserts every scanned contract for the scan day",
  db.prepare("SELECT COUNT(*) n FROM contract_daily WHERE date='2026-10-16'").get().n === fakeChain.length);
t("runner: sniper detected via vault history", res.tierCounts.S === 1, JSON.stringify(res.tierCounts));
t("SNIPER_POST_ONLY default on", sniperPostOnly({}) === true && sniperPostOnly({ SNIPER_POST_ONLY: "0" }) === false);
t("sniper-only: only the S signal posted", posts.length === 1 && posts[0].symbol === SNIPE && posts[0].tier === "S", posts.map((p) => `${p.symbol}:${p.tier}`).join(","));
t("non-S signals still logged to vault",
  db.prepare("SELECT COUNT(*) n FROM signals").get().n === 1 + res.tierCounts.A + res.tierCounts.B + res.tierCounts.C);
t("digest line printed", logs.some((l) => /^scan done: 1 sniper, \d+ A, \d+ B, \d+ C quiet-logged$/.test(l)), logs.join(" | "));
const spreadRows = db.prepare("SELECT tier, rationale FROM signals WHERE ref_id LIKE 'NVDA261120C002_0000@%' AND ref_id NOT LIKE ?").all(`${SNIPE}@%`);
t("spread pair logged quietly at C with spread factor",
  spreadRows.length === 2 && spreadRows.every((r) => r.tier === "C" && r.rationale.includes("possible spread leg")), JSON.stringify(spreadRows));

// SNIPER_POST_ONLY=0 restores old behavior: every non-D new signal posts.
db.exec("DELETE FROM signals");
process.env.SNIPER_POST_ONLY = "0";
posts.length = 0;
const res0 = await runScan({ config: {}, client: fakeClient, db, watchlist: ["NVDA"], now: runNow, postFn: fakePost, log: () => {} });
t("SNIPER_POST_ONLY=0: all non-D signals post", posts.length === res0.tierCounts.S + res0.tierCounts.A + res0.tierCounts.B + res0.tierCounts.C && posts.length === 3, `posted ${posts.length}`);
delete process.env.SNIPER_POST_ONLY;

// ---------- 9. Embed banner ----------
console.log("embed:");
const sniperSig = { underlying: "NVDA", optionType: "call", strike: 200, expiration: "2026-11-20", dte: 35, volume: 10000, openInterest: 2000, bid: 1.95, ask: 2.05, delta: 0.4, tier: "S", score: 95, premium: 2_000_000, vOi: 5, vAdv: 12.5, factors: [] };
const emb = buildSignalEmbed(sniperSig).embeds[0];
t("S embed starts with SNIPER banner", emb.description.startsWith("🎯 **SNIPER**"));
t("A embed has no banner", !buildSignalEmbed({ ...sniperSig, tier: "A" }).embeds[0].description.includes("SNIPER"));
t("embed still 6 fields", emb.fields.length === 6);

db.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
