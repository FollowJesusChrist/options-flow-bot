// chart-cmd/test.js — offline checks for /chart (no Discord, no Tradier).
// SPY/QQQ end-to-end checks use the recorded sr.db and skip if it is missing.

import { existsSync } from "node:fs";
import { parseChartOptions, dteToLane, CHART_COMMAND, LAB_GUILD_ID, SR_CHANNEL_ID } from "./command.js";
import { RateLimiter, createChartHandler } from "./handler.js";
import { describeEvent } from "./engine.js";
import { buildCard, FOOTER } from "./card.js";
import { plan } from "./register.js";
import { srDbPath } from "../src/sr/store.js";
import { fakeInteraction } from "./dryrun.js";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// command definition
ok(CHART_COMMAND.name === "chart" && CHART_COMMAND.options.length === 2, "one command, two options");
ok(CHART_COMMAND.options[0].name === "ticker" && CHART_COMMAND.options[0].required === true && CHART_COMMAND.options[0].type === 3, "ticker: required string");
ok(CHART_COMMAND.options[1].name === "dte" && !CHART_COMMAND.options[1].required && CHART_COMMAND.options[1].type === 3, "dte: optional string");

// parsing
const p = (ticker, dte) => parseChartOptions({ ticker, dte });
ok(p("spy").ok && p("spy").ticker === "SPY" && p("spy").lane === null, "lowercase ticker, default nearest");
ok(p("$nvda").ticker === "NVDA", "strips $");
ok(p(" QQQ ").ticker === "QQQ", "trims");
for (const bad of ["", "SPY1", "BRK.B", "TOOLONG", "S P Y", "12345", null]) ok(!p(bad).ok && typeof p(bad).error === "string", `rejects ticker ${JSON.stringify(bad)}`);
ok(p("SPY", "0DTE").lane === "L0" && p("SPY", "1dte").lane === "L1" && p("SPY", "2").lane === "L1", "0/1/2 DTE lanes");
ok(p("SPY", "5DTE").lane === "L2" && p("SPY", "7D").lane === "L2", "3–7 DTE → L2");
ok(p("SPY", "10DTE").lane === "L4" && p("SPY", "15DTE").lane === "L4" && p("SPY", "45dte").lane === "L4", "8+ DTE → L4");
for (const bad of ["soon", "-1", "DTE", "1W", "1000DTE"]) ok(!p("SPY", bad).ok, `rejects dte ${bad}`);
ok(dteToLane(0).view === "0DTE", "view label");

// rate limit: 1 per user per minute
const rl = new RateLimiter(60_000);
ok(rl.take("a", 0) === 0 && rl.take("a", 30_000) === 30 && rl.take("b", 30_000) === 0 && rl.take("a", 60_000) === 0, "1/user/min");

// status wording
const st = (transition, direction) => describeEvent({ transition, direction }).title;
ok(st("held", "down") === "Resistance Held" && st("held", "up") === "Support Held", "held wording");
ok(st("break-confirmed", "up") === "Resistance Broke" && st("break-confirmed", "down") === "Support Broke", "broke wording");
ok(st("break-failed", "down") === "Resistance Break Failed" && st("break-failed", "up") === "Support Break Failed", "failed wording");
ok(describeEvent(null).key === "none", "no event");

// card: paper footer, informational, no trade-call framing
const z = (lo, hi) => ({ lo, hi, mid: (lo + hi) / 2, score: 40, label: "x", lane: "L2" });
for (const ev of [null, { transition: "held", direction: "down", t: "2026-10-26T12:00:00", closeT: "2026-10-26T12:15:00", lane: "L2" }]) {
  const card = buildCard({ support: z(100, 101), resistance: z(105, 106), event: ev, status: describeEvent(ev) },
    { symbol: "SPY", view: "5DTE", last: 103, today: "2026-10-26", attachmentName: "chart-SPY.png" });
  const text = `${card.title}\n${card.description}\n${card.footer.text}`;
  ok(card.footer.text === FOOTER && FOOTER === "Paper mode · Not financial advice", "footer exact");
  ok(card.description.split("\n").length === 2, "title + 2 lines");
  ok(/informational, not a proven edge/.test(card.description), "says informational");
  ok(!/\b(buy|sell|long|short|entry|target|stop|size|sizing|guarantee|edge proven)\b/i.test(text.replace("not a proven edge", "")), "no trade-call words");
  ok(card.image.url === "attachment://chart-SPY.png", "image attachment ref");
}
ok(/09:15 PT/.test(buildCard({ support: null, resistance: z(1, 2), event: { transition: "held", direction: "down", t: "x", closeT: "2026-10-26T12:15:00", lane: "L0" }, status: describeEvent({ transition: "held", direction: "down" }) },
  { symbol: "SPY", view: "0DTE", last: 0.5, today: "2026-10-26", attachmentName: "a.png" }).description), "ET → PT time");

// registration plan: guild only, never global
const steps = plan("123");
ok(steps[0].url.endsWith("/users/@me") && steps[1].method === "POST", "GET @me then POST");
ok(steps[1].url.includes(`/guilds/${LAB_GUILD_ID}/commands`) && !/applications\/123\/commands$/.test(steps[1].url), "guild scoped, not global");

// handler end-to-end with a fake interaction, offline (recorded bars)
const logs = [];
const offline = { hasToken: false };
const h = createChartHandler({ tradier: offline, channelId: "chan", log: (e) => logs.push(e) });
const run = async (o) => { const i = fakeInteraction({ channelId: "chan", ...o }); await h(i); return i; };
let i = await run({ ticker: "SPY1", user: "x1" });
ok(i.calls.length === 1 && i.calls[0].op === "reply" && i.calls[0].p.flags === 64 && !i.deferred, "invalid → plain ephemeral reply, no defer");
i = await run({ ticker: "SPY", user: "x2", channelId: "other" });
ok(i.calls[0].op === "reply" && /only/.test(i.calls[0].p.content), "wrong channel refused");
const fixed = createChartHandler({ tradier: offline, log: () => {} });
const fi = fakeInteraction({ ticker: "SPY", user: "x9", channelId: "other" });
await fixed(fi);
ok(fi.calls[0].op === "reply" && fi.calls[0].p.content.includes(SR_CHANNEL_ID), "default: #support-resistance only");
i = await run({ ticker: "NVDA", user: "x3" });
ok(i.calls[0].op === "deferReply" && i.calls[1].op === "editReply" && typeof i.calls[1].p.content === "string", "no data offline → plain reply, not a crash");
if (existsSync(srDbPath())) {
  i = await run({ ticker: "SPY", user: "x4" });
  ok(i.calls[0].op === "deferReply" && i.calls[0].ms < 3000, "ACK first, under 3 s");
  const e = i.calls[1]?.p;
  ok(e?.embeds?.[0]?.footer?.text === FOOTER && e.files?.[0]?.name === "chart-SPY.png", "chart + card reply");
  const png = e?.files?.[0]?.attachment;
  ok(png && png.subarray(1, 4).toString() === "PNG" && png.length > 20_000, "valid PNG");
  i = await run({ ticker: "SPY", user: "x4" });
  ok(i.calls.length === 1 && /per minute/.test(i.calls[0].p.content), "second request in a minute → rate-limited reply");
  i = await run({ ticker: "QQQ", dte: "15DTE", user: "x5" });
  ok(i.calls[1]?.p?.embeds?.[0]?.title.includes("15DTE"), "dte reflected in title");
} else console.log("skip: no sr.db for offline SPY/QQQ end-to-end");
ok(logs.length >= 4 && logs.every((l) => l.outcome && l.at && "ticker" in l), "every request logged");
ok(!JSON.stringify(logs).match(/Bearer\s|[\w-]{20,}\.[\w-]{6}\.[\w-]{20,}/), "no credentials in logs");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
