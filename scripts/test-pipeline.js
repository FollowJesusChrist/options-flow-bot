// test-pipeline.js — end-to-end: signal -> embed -> components -> store -> stats.
// Uses in-memory SQLite. Exit 0 = all pass.

import { buildSignalEmbed, signalId, signalSummary } from "../src/discord/embeds.js";
import { signalButtons, contractPicker, parseCustomId } from "../src/discord/components.js";
import { COMMANDS } from "../src/discord/commands.js";
import { openDb, logSignal, openPaperTrade, closePaperTrade, logDismissal, accuracyStats } from "../src/store.js";

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

const signal = {
  underlying: "SPY",
  symbol: "SPY_261121C00585000",
  optionType: "call",
  strike: 585,
  expiration: "2026-11-21",
  dte: 37,
  volume: 8240,
  openInterest: 1930,
  bid: 4.2,
  ask: 4.35,
  delta: 0.38,
  tier: "A",
  score: 82,
  premium: 3522600,
  vOi: 4.3,
  vAdv: 3.1,
  factors: ["V/OI 4.3x (+30)", "premium $3523K (+20)"],
};

// Embeds
const refId = signalId(signal);
t("signal ref id stable", refId === "SPY-2026-11-21-585C", refId);
const { embeds } = buildSignalEmbed(signal, {
  why: ["swept across 3 exchanges in one burst", "2nd appearance in 2 days"],
  contracts: [],
  paperMode: true,
});
t("embed has tier color", embeds[0].color === 0x57f287, `color=${embeds[0].color?.toString(16)}`);
t("embed title has tier", embeds[0].title.includes("TIER A"));
t("embed has 6 fields", embeds[0].fields.length === 6, `got ${embeds[0].fields.length}`);
t("embed footer says paper mode", embeds[0].footer.text.includes("Paper mode"));
t("summary one-liner", signalSummary(signal).includes("[A] $SPY"), signalSummary(signal));

// Components
const rows = signalButtons(refId);
t("3 buttons", rows[0].components.length === 3);
t("button ids parse", parseCustomId(rows[0].components[0].custom_id).action === "track");
const picker = contractPicker(refId, [
  { label: "Conservative · 580C", delta: 0.3, mid: 3.1 },
  { label: "Moderate · 585C", delta: 0.38, mid: 4.27 },
]);
t("contract picker has 2 options", picker[0].components[0].options.length === 2);
t("picker custom id parses", parseCustomId(picker[0].components[0].custom_id).action === "contract");

// Commands
t("4 slash commands", COMMANDS.length === 4, COMMANDS.map((c) => c.name).join(","));
t("/analyze has ticker option", COMMANDS[0].options[0].name === "ticker");

// Store (in-memory)
const db = openDb(":memory:");
const sid = logSignal(db, { ...signal, refId }, "test rationale");
t("signal logged", typeof sid === "number", `id=${sid}`);
const dup = logSignal(db, { ...signal, refId }, "dup");
t("duplicate signal ignored", dup === sid);
const tid = openPaperTrade(db, sid, 4.27, 1, "test trade");
const pnl = closePaperTrade(db, tid, 5.1);
t("paper trade pnl correct", Math.abs(pnl - 83) < 0.01, `pnl=${pnl}`); // (5.10-4.27)*100
logDismissal(db, sid, "too far OTM");
const stats = accuracyStats(db);
t("stats: 1 closed", stats.closed === 1);
t("stats: 100% win rate on 1", stats.winRate === 100);
t("stats: not ready (<30)", stats.ready === false);
db.close();

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
