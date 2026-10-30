// sr-levels-poller/test.js — offline checks (no network: fake Discord, fake fetch,
// buildChart is never reached except via the stubbed Tradier provider).
//   node test.js

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLevelsMessage } from "./parse.js";
import { createPoller, SeenStore, snowflakeMs, jsonlLogger } from "./poller.js";
import { DiscordRest } from "./discord-rest.js";
import { TradierProvider } from "./tradier-token.js";
import { fakeDiscord } from "./dryrun.js";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ── parser ──
const p = (s) => parseLevelsMessage(s);
ok(p("levels SPY")?.ticker === "SPY" && p("levels SPY").lane === null, "levels SPY");
ok(p("Levels spy")?.ticker === "SPY", "case-insensitive");
ok(p("chart NVDA")?.ticker === "NVDA" && p("chart NVDA").word === "chart", "chart alias");
ok(p("levels SPY 0DTE")?.lane === "L0", "0DTE → L0");
ok(p("levels SPY 2dte")?.lane === "L1", "2DTE → L1");
ok(p("levels SPY 5DTE")?.lane === "L2", "5DTE → L2");
ok(p("levels NVDA 15DTE")?.lane === "L4", "15DTE → L4");
ok(p("levels $AAPL")?.ticker === "AAPL", "$ prefix");
ok(p("  levels   QQQ  ")?.ticker === "QQQ", "whitespace");
ok(p("levels SPY1")?.ok === false, "bad ticker format → error");
ok(p("levels TOOLONG")?.ok === false, "6+ letters → error");
ok(p("levels") === null, "bare word ignored");
ok(p("SPY levels") === null, "wrong order ignored");
ok(p("levels are holding up") === null, "chat ignored (4 words)");
ok(p("levels are holding") === null, "chat ignored (non-DTE 3rd word)");
ok(p("what are the levels SPY") === null, "mid-sentence ignored");
ok(p("levelsSPY") === null, "no space ignored");
ok(p("") === null && p(null) === null, "empty ignored");

// ── snowflake ──
ok(snowflakeMs("175928847299117063") === 1462015105796, "snowflake → ms (Discord docs example)");

// ── poller with fake Discord + stub chart builder via a fake Tradier that throws offline ──
const dir = mkdtempSync(join(tmpdir(), "srlp-"));
const snow = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);
const t0 = Date.now() - 10_000;
const m = (k, user, content, extra = {}) => ({ id: snow(t0 + k * 1000), content, author: { id: user, username: user }, ...extra });
const BOT = "999000000000000001";
const msgs = [
  m(1, "u1", "levels SPY1"),
  m(2, "u1", "levels SPY2"),        // invalid again: typos don't use the minute
  m(3, "u2", "hello"),
  m(4, BOT, "levels SPY", { author: { id: BOT, bot: true } }),
  m(5, "u3", "levels SPY", { author: { id: "u3", bot: true } }), // any bot ignored
  { id: snow(Date.now() - 60 * 60_000), content: "levels SPY", author: { id: "u4" } }, // 1h old → stale
];
const discord = fakeDiscord(msgs);
const logged = [];
const logPath = join(dir, "log.jsonl");
const fileLog = jsonlLogger(logPath);
const seenPath = join(dir, "seen.json");
const mk = () => createPoller({
  discord, tradier: { get: () => ({ hasToken: false }), invalidate() {} }, botUserId: BOT,
  seen: new SeenStore(seenPath), log: (e) => { logged.push(e); fileLog(e); }, warn: () => {}, dbPath: join(dir, "none.db"),
});
const r1 = await mk().pollOnce();
ok(r1.length === msgs.length, "all messages handled");
ok(discord.sent.length === 2 && discord.sent.every((s) => /isn't a ticker/.test(s.content)), "two invalid replies only");
ok(discord.sent.every((s) => msgs.some((x) => x.id === s.messageId)), "replies reference the user message");
ok(r1.find((x) => x.id === msgs[3].id).outcome === "ignored-bot", "own message ignored");
ok(r1.find((x) => x.id === msgs[4].id).outcome === "ignored-bot", "other bot ignored");
ok(r1.find((x) => x.id === msgs[2].id).outcome === "ignored-no-match", "chat ignored");
ok(logged.find((e) => e.messageId === msgs[5].id)?.outcome === "stale-skipped", "stale request skipped");
ok(logged.every((e) => "messageId" in e && "user" in e && "ticker" in e && "dte" in e && "replyMessageId" in e && "at" in e), "log fields present");
ok(existsSync(seenPath), "seen file written");
const r2 = await mk().pollOnce();
ok(r2.length === 0 && discord.sent.length === 2, "restart: nothing re-answered");

// rate limit + build path with a stubbed Tradier that fails → error reply, no crash
const d2 = fakeDiscord([m(20, "u9", "levels SPY"), m(21, "u9", "levels QQQ"), m(80, "u9", "levels NVDA")]);
let gets = 0, inval = 0;
const throwing = { get: () => { gets++; return { hasToken: true, quotes: async () => { throw new Error("Tradier 401 on /markets/quotes: Bearer hsurr:SECRET"); } }; }, invalidate() { inval++; } };
const logs2 = [];
const res2 = await createPoller({ discord: d2, tradier: throwing, botUserId: BOT, seen: new SeenStore(join(dir, "s2.json")), log: (e) => logs2.push(e), warn: () => {} }).pollOnce();
ok(res2[0].outcome === "error" && /Couldn't build levels for SPY/.test(d2.sent[0].content), "build failure → plain reply, no crash");
ok(inval === 2 && gets === 4, "Tradier auth error → surrogate refreshed + exactly one retry per request");
ok(!JSON.stringify(logs2).includes("SECRET"), "surrogate redacted from log");
ok(res2[1].outcome === "rate-limited" && /per minute/.test(d2.sent[1].content), "2nd request within a minute → rate-limit reply");
ok(res2[2].outcome === "error", "request 60 s later is allowed (not rate-limited)");

// log file never contains a token or PNG bytes
const logText = readFileSync(logPath, "utf8");
ok(!/Bot\s+[A-Za-z0-9._-]{20,}|hsurr:/.test(logText) && !/"png"/.test(logText), "log has no token / png");

// ── Discord REST client: reply shape, no token in errors ──
const calls = [];
const fakeFetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ id: "r1" }), { status: 200 }); };
const rest = new DiscordRest({ token: "TOKEN_ABC", fetchImpl: fakeFetch });
await rest.reply("C1", "M1", { embed: { title: "x" }, png: Buffer.from([1, 2, 3]), filename: "chart-SPY.png" });
const form = calls[0].init.body;
const payload = JSON.parse(form.get("payload_json"));
ok(calls[0].init.method === "POST" && calls[0].url.endsWith("/channels/C1/messages"), "reply POSTs to channel messages");
ok(payload.message_reference.message_id === "M1" && payload.message_reference.fail_if_not_exists === false, "message_reference set");
ok(payload.allowed_mentions.parse.length === 0 && payload.allowed_mentions.replied_user === false, "no pings");
ok(payload.attachments[0].filename === "chart-SPY.png" && form.get("files[0]") instanceof Blob, "PNG attached");
await rest.messages("C1", { after: "5", limit: 100 });
ok(calls[1].init.method === "GET" && /after=5/.test(calls[1].url), "messages GET with after cursor");
const bad = new DiscordRest({ token: "TOKEN_ABC", fetchImpl: async () => new Response("nope", { status: 403 }) });
const err = await bad.me().catch((e) => e);
ok(err.status === 403 && !err.message.includes("TOKEN_ABC"), "errors carry no token");
ok((() => { try { new DiscordRest({}); return false; } catch { return true; } })(), "no token → refuses");

// ── Tradier provider: env override, refresh cadence ──
let fetched = 0, clock = 0;
const prov = new TradierProvider({ env: {}, fetchToken: () => `hsurr:t${++fetched}`, now: () => clock });
prov.get(); prov.get(); ok(fetched === 1, "surrogate cached");
clock = 11 * 60_000; prov.get(); ok(fetched === 2, "surrogate refreshed after 10 min");
prov.invalidate(); prov.get(); ok(fetched === 3, "invalidate forces refresh");
ok(new TradierProvider({ env: { TRADIER_TOKEN: "x" }, fetchToken: () => { throw new Error("no"); } }).get().hasToken, "TRADIER_TOKEN env override");

// ── constraints: no gate/order code, no .env reads ──
const src = ["poller.js", "parse.js", "discord-rest.js", "tradier-token.js", "run-poller.sh", "watchdog.sh"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
ok(!/\.env\b(?!ironment)/.test(src.replace(/process\.env/g, "")), "no .env file reads");
ok(!/\/orders|SR_POST_QUIET=1|SR_POST_LOUD=1|src\/sr\/post\.js"/.test(src.replace(/\/\/.*$/gm, "")), "no order paths, no gate switches");
ok(!/systemctl|pm2 start|setsid/.test(src.replace(/#.*$/gm, "")), "nohup only (no systemd / PM2 / setsid)");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
