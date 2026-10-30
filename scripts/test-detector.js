// test-detector.js — unit tests for the triple-filter detector with synthetic data.
// Exit 0 = all pass.

import { scan, score, premiumOf, THRESHOLDS } from "../src/signals/unusual.js";

let pass = 0,
  fail = 0;
const t = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

// Synthetic chain: one screaming signal, one borderline, one quiet, one 0DTE.
const chain = [
  {
    symbol: "SPY_261121C00585000",
    underlying: "SPY",
    option_type: "call",
    strike: 585,
    expiration: "2026-11-21",
    volume: 8240,
    open_interest: 1930,
    bid: 4.2,
    ask: 4.35,
    greeks: { delta: 0.38, iv: 0.21 },
  },
  {
    symbol: "AAPL_261121C00260000",
    underlying: "AAPL",
    option_type: "call",
    strike: 260,
    expiration: "2026-11-21",
    volume: 300,
    open_interest: 5000,
    bid: 1.1,
    ask: 1.2,
    greeks: { delta: 0.25, iv: 0.3 },
  },
  {
    symbol: "TSLA_261016C00450000",
    underlying: "TSLA",
    option_type: "call",
    strike: 450,
    expiration: "2026-10-16", // 0-1 DTE from Oct 15 -> quarantine
    volume: 50000,
    open_interest: 100,
    bid: 0.5,
    ask: 0.55,
    greeks: { delta: 0.5, iv: 0.9 },
  },
];

const advMap = { SPY_261121C00585000: 2600, AAPL_261121C00260000: 400 };
const now = new Date("2026-10-15T14:00:00-04:00");

const { signals, quarantined, scanned } = scan(chain, { advMap, now });

t("scans all contracts", scanned === 3, `got ${scanned}`);
t("finds the SPY signal", signals.length === 1 && signals[0].underlying === "SPY", `got ${signals.length}`);
t("raw scan tier is B with no history", signals[0]?.tier === "B", `tier=${signals[0]?.tier}`);
// With repeat appearances + rising OI the same contract upgrades to A:
const withHistory = score(chain[0], { adv: 2600, priorAppearances: 2, oiRising: true, dte: 37 });
t("history confirmation upgrades to A", withHistory.tier === "A", `tier=${withHistory.tier}, score=${withHistory.score}`);
t("SPY premium computed", signals[0]?.premium > 3_000_000, `premium=${signals[0]?.premium}`);
t("quiet AAPL filtered out", !signals.some((s) => s.underlying === "AAPL"));
t("0DTE TSLA quarantined", quarantined.length === 1, `got ${quarantined.length}`);
t(
  "quarantine reason mentions DTE",
  quarantined[0]?.reason.includes("DTE"),
  quarantined[0]?.reason
);

// Thresholds sane
t("premium floor is 100K", THRESHOLDS.premiumMin === 100_000);
t("quarantine floor is 3 DTE", THRESHOLDS.minDte === 3);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
