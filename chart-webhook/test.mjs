// chart-webhook/test.mjs — checks for the HTTP /chart bot. No Discord network: the
// webhook sender is a capture stub. Tradier: live (read-only) only if TRADIER_TOKEN
// is set (./run-dryrun-vm.sh --test); otherwise offline, recorded sr.db for SPY/QQQ.
// Guard tests (unknown / thin / low ADV / short history) use fake Tradier clients.

import { existsSync } from "node:fs";
import { createInteractionsHandler, verifyDiscordSignature, buildDiscordRequests, DISCORD_API } from "./handler-http.mjs";
import { startLocalServer } from "./worker.mjs";
import { GuardedTradier, tradierFromEnv, isOutage } from "./tradier.mjs";
import { makeSigner, chartInteraction, captureSend } from "./dryrun.mjs";
import { RateLimiter } from "../chart-cmd/handler.js";
import { FOOTER } from "../chart-cmd/card.js";
import { SR_CHANNEL_ID, CHART_COMMAND } from "../chart-cmd/command.js";
import { srDbPath } from "../src/sr/store.js";
import { to1h } from "../src/sr/bars.js";
import { WEBHOOK_CHART_COMMAND, parseWebhookChartOptions, TOO_LITTLE_1DAY, INTRADAY_MAX_DAYS } from "./command.mjs";
import { toNh, frameBars, windowOf, frameZones, pickLevels, latestStatus } from "./frames.mjs";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const signer = makeSigner();
const offline = { hasToken: false };
const live = tradierFromEnv();
const NO_DB = "/nonexistent/sr.db";
const logs = [];

function setup({ tradier = offline, dbPath, limiter = new RateLimiter(60_000) } = {}) {
  const cap = captureSend();
  const handle = createInteractionsHandler({ publicKey: signer.publicKeyHex, tradier, send: cap.send, limiter, dbPath, log: (e) => logs.push(e) });
  const call = async (obj, { tamper, headers } = {}) => {
    const body = JSON.stringify(obj);
    const r = await handle({ method: "POST", headers: headers ?? signer.headers(body), body: tamper ? tamper(body) : body });
    await r.background;
    return { r, ack: r.status === 200 ? JSON.parse(r.body) : null, ops: [...cap.ops.splice(0)] };
  };
  return { handle, call, cap };
}

// ── Ed25519 ──
{
  const body = JSON.stringify({ type: 1 });
  const h = signer.headers(body);
  const v = (o) => verifyDiscordSignature({ publicKey: signer.publicKeyHex, signature: h["x-signature-ed25519"], timestamp: h["x-signature-timestamp"], body, ...o });
  ok(v({}) === true, "valid signature passes");
  ok(v({ body: body.replace("1", "2") }) === false, "tampered body fails");
  ok(v({ signature: "" }) === false && v({ timestamp: "" }) === false, "missing signature / timestamp fails");
  ok(v({ publicKey: makeSigner().publicKeyHex }) === false, "wrong public key fails");
  ok(v({ publicKey: "" }) === false && v({ publicKey: "zz" }) === false, "missing / malformed public key fails");
  ok(v({ nowS: Date.now() / 1000 + 3600 }) === false, "stale timestamp (replay) fails");
  const { handle } = setup();
  const r401 = await handle({ method: "POST", headers: { "content-type": "application/json" }, body });
  ok(r401.status === 401 && r401.body === "invalid request signature", "missing headers → 401 plain");
  const rT = await handle({ method: "POST", headers: h, body: body + " " });
  ok(rT.status === 401 && !/token|Bot /i.test(rT.body), "tampered → 401, nothing sensitive in body");
  ok((await handle({ method: "GET", headers: h, body })).status === 405, "GET → 405");
}

// ── PING ──
{
  const { call } = setup();
  const { r, ack, ops } = await call({ type: 1 });
  ok(r.status === 200 && ack.type === 1 && !r.background && ops.length === 0, "PING → PONG, nothing else");
}

// ── wrong channel / invalid input → ephemeral only, no defer, no chart ──
{
  const { call } = setup();
  let x = await call(chartInteraction({ ticker: "SPY", user: "w1", channelId: "123" }));
  ok(x.ack.type === 4 && x.ack.data.flags === 64 && x.ack.data.content === `/chart works in <#${SR_CHANNEL_ID}> only.` && x.ops.length === 0, "wrong channel → ephemeral, same wording, no chart");
  x = await call(chartInteraction({ ticker: "SPY1", user: "w2" }));
  ok(x.ack.type === 4 && x.ack.data.flags === 64 && x.ack.data.content === `"SPY1" isn't a ticker. Use 1–5 letters, like SPY or NVDA.` && x.ops.length === 0, "bad ticker SPY1 → ephemeral, parseChartOptions wording");
  x = await call(chartInteraction({ ticker: "TSLA", dte: "soon", user: "w3" }));
  ok(x.ack.type === 4 && x.ack.data.flags === 64 && /isn't a timeframe/.test(x.ack.data.content) && x.ops.length === 0, "bad dte soon → ephemeral");
  x = await call(chartInteraction({ ticker: "SPY", user: "w4", name: "other" }));
  ok(x.ack.type === 4 && x.ack.data.flags === 64 && x.ops.length === 0, "other command → ephemeral, no chart");
}

// ── guards via fake Tradier clients (thin / low ADV / short history / unknown / not a stock) ──
function fakeTradier({ quote, days = 300, price = 50, volume = 5_000_000 }) {
  const daily = Array.from({ length: days }, (_, k) => {
    const d = new Date(Date.UTC(2025, 0, 1) + k * 86400000).toISOString().slice(0, 10);
    return { date: d, open: price, high: price * 1.01, low: price * 0.99, close: price, volume };
  });
  return { hasToken: true, quotes: async (s) => (quote === null ? [] : [{ symbol: s[0], type: "stock", last: price, ...quote }]), daily: async () => daily, timesales: async () => [] };
}
async function guard(name, client, ticker, re) {
  const { call } = setup({ tradier: client, dbPath: NO_DB });
  const x = await call(chartInteraction({ ticker, user: `g-${name}` }));
  const op = x.ops[0];
  ok(x.ack.type === 5 && x.ops.length === 1 && op.kind === "replace-with-ephemeral" && op.payload.flags === 64
    && !op.files.length && !op.payload.embeds && re.test(op.payload.content), `${name} → plain ephemeral, no chart (${op?.payload?.content})`);
}
await guard("unknown ticker", fakeTradier({ quote: null }), "ZZZZZ", /^I couldn't find ZZZZZ\. Check the ticker and try again\.$/);
await guard("not a stock", fakeTradier({ quote: { type: "index" } }), "VIXX", /isn't a stock or ETF/);
await guard("thin name", fakeTradier({ price: 2, volume: 50_000 }), "AACG", /^AACG is too thin for S\/R levels: price under \$5; 20-day average volume 50,000 shares/);
await guard("low ADV", fakeTradier({ price: 40, volume: 200_000 }), "LOWV", /too thin.*20-day average volume 200,000 shares \(need 1,000,000\)/);
await guard("short history", fakeTradier({ days: 100 }), "NEWCO", /too thin.*only 100 days of history \(need 250\)/);

// ── outage handling: Tradier errors mark the client unavailable ──
{
  ok(isOutage(new TypeError("fetch failed")) && isOutage(new Error("Tradier 401 on /markets/quotes: x")) && isOutage(new Error("Tradier 503 on /x: y")), "outage errors detected");
  ok(!isOutage(new Error("Tradier 400 on /markets/timesales: must be on or after")), "400 is not an outage");
  let t = 0;
  const g = new GuardedTradier({ hasToken: true, quotes: async () => { throw new TypeError("fetch failed"); } }, { now: () => t });
  ok(g.hasToken, "guarded: available before failure");
  await g.quotes(["SPY"]).catch(() => {});
  ok(!g.hasToken, "guarded: unavailable after outage (→ recorded fallback)");
  t = 61_000;
  ok(g.hasToken, "guarded: retries after cool-off");
}

// ── /chart SPY → defer, then followup with PNG + card ──
const canSpy = live.hasToken || existsSync(srDbPath());
if (canSpy) {
  const { call } = setup({ tradier: live.hasToken ? live : offline });
  const t0 = Date.now();
  const x = await call(chartInteraction({ ticker: "SPY", user: "s1" }));
  ok(x.ack.type === 5, "SPY → DEFER (type 5) ACK");
  const op = x.ops[0];
  ok(x.ops.length === 1 && op.kind === "edit-original", "SPY → one webhook edit of the original");
  const e = op?.payload?.embeds?.[0];
  ok(e?.footer?.text === FOOTER && /^SPY — /.test(e.title) && /Price \*\*\$[\d.]+\*\* · Support below .* · Resistance above /.test(e.description), "SPY card: title + price + support/resistance + paper footer");
  ok(op?.files?.[0]?.name === "chart-SPY.png" && op.files[0].data.subarray(1, 4).toString() === "PNG" && op.files[0].data.length > 20_000, "SPY PNG attached");
  ok(op?.payload?.attachments?.[0]?.filename === "chart-SPY.png" && e?.image?.url === "attachment://chart-SPY.png", "attachment wired to embed image");
  const reqs = buildDiscordRequests(op);
  ok(reqs.length === 1 && reqs[0].method === "PATCH" && reqs[0].url === `${DISCORD_API}/webhooks/dry-app/${op.interactionToken}/messages/@original` && !reqs[0].headers.authorization, "followup = PATCH webhook @original, no auth header when DISCORD_BOT_TOKEN unset");
  // rate limit: same user again within 60 s
  const y = await call(chartInteraction({ ticker: "SPY", user: "s1" }));
  ok(y.ack.type === 4 && y.ack.data.flags === 64 && /^One \/chart per minute\. Try again in \d+s\.$/.test(y.ack.data.content) && y.ops.length === 0, "second request same user < 60 s → rate-limit reply");
  console.log(`info: SPY via ${live.hasToken ? "live Tradier" : "recorded sr.db"} — ${e?.description.split("\n")[0]} (${Date.now() - t0} ms incl. render)`);
} else console.log("skip: SPY end-to-end (no Tradier token and no sr.db)");

// ── /chart SOFI ──
{
  const { call } = setup({ tradier: live.hasToken ? live : offline });
  const x = await call(chartInteraction({ ticker: "SOFI", user: "s2" }));
  const op = x.ops[0];
  ok(x.ack.type === 5, "SOFI → DEFER ACK");
  if (live.hasToken) {
    const e = op?.payload?.embeds?.[0];
    ok(op?.kind === "edit-original" && /^SOFI — /.test(e?.title) && op.files[0]?.data.length > 20_000, "SOFI (live Tradier) → PNG + card");
    console.log(`info: SOFI via LIVE Tradier — ${e?.description.split("\n")[0]}`);
  } else {
    ok(op?.kind === "replace-with-ephemeral" && /^No live data for SOFI right now/.test(op.payload.content) && !op.files.length, "SOFI (no Tradier) → plain 'No live data', not SPY/QQQ levels");
    console.log("info: SOFI — no Tradier token in this shell → 'No live data' (expected)");
  }
}

// ── through the real Node http adapter ──
{
  const cap = captureSend();
  const handle = createInteractionsHandler({ publicKey: signer.publicKeyHex, tradier: offline, send: cap.send, log: () => {} });
  const bg = [];
  const server = await startLocalServer({ handle, port: 0, onBackground: (p) => bg.push(p) });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const body = JSON.stringify({ type: 1 });
  const a = await fetch(url, { method: "POST", headers: signer.headers(body), body });
  ok(a.status === 200 && (await a.json()).type === 1, "http adapter: PING → PONG");
  const b = await fetch(url, { method: "POST", headers: signer.headers(body), body: body + "x" });
  ok(b.status === 401, "http adapter: bad signature → 401");
  const c = JSON.stringify(chartInteraction({ ticker: "SPY1", user: "h1" }));
  const cr = await (await fetch(url, { method: "POST", headers: signer.headers(c), body: c })).json();
  ok(cr.type === 4 && cr.data.flags === 64, "http adapter: invalid ticker → ephemeral");
  server.close();
}

// ── worker fetch entry: Web Request → Response ──
{
  const worker = (await import("./worker.mjs")).default;
  const res = await worker.fetch(new Request("http://x/", { method: "POST", body: "{}" }), { DISCORD_PUBLIC_KEY: signer.publicKeyHex });
  ok(res.status === 401, "worker.fetch: unsigned → 401");
}

// ── safety: ACK deadline + logs ──
{
  const slow = { hasToken: true, quotes: () => new Promise(() => {}) }; // never answers
  const cap = captureSend();
  const handle = createInteractionsHandler({ publicKey: signer.publicKeyHex, tradier: slow, send: cap.send, log: () => {}, ackDeadlineMs: 50 });
  const body = JSON.stringify(chartInteraction({ ticker: "SPY", user: "slow" }));
  const r = await handle({ method: "POST", headers: signer.headers(body), body });
  ok(JSON.parse(r.body).type === 5, "slow upstream still ACKs (defer) before deadline");
}
// ── interval + lookback: command definition ──
{
  const o = WEBHOOK_CHART_COMMAND.options;
  ok(o.map((x) => x.name).join() === "ticker,dte,interval,lookback" && o.every((x) => x.type === 3), "webhook /chart options: ticker, dte, interval, lookback (strings)");
  ok(o[0].required === true && o.slice(1).every((x) => !x.required), "only ticker required; dte/interval/lookback optional");
  ok(CHART_COMMAND.options.length === 2 && WEBHOOK_CHART_COMMAND.name === "chart", "gateway CHART_COMMAND unchanged (2 options), same command name");
}

// ── interval + lookback: parsing rules ──
{
  const P = (o) => parseWebhookChartOptions({ ticker: "SOFI", ...o });
  let r = P({});
  ok(r.ok && r.mode === "default" && r.lane === null && r.view === "Nearest levels", "no interval/lookback → old default (nearest across lanes)");
  r = P({ dte: "5DTE" });
  ok(r.ok && r.mode === "default" && r.lane === "L2", "dte only → old dte lane (L2)");
  r = P({ interval: "15m", lookback: "1month" });
  ok(r.ok && r.mode === "frame" && r.frame === "15m" && r.lookback === "1month" && !r.fallback && r.view === "15m · 1 month", "15m + 1month → 15m frame over 1 month");
  ok(P({ interval: "15MIN", lookback: "1mo" }).frame === "15m" && P({ interval: "60m" }).frame === "1h" && P({ interval: " Daily " }).frame === "daily", "interval aliases / case / spaces");
  r = P({ interval: "15m", dte: "0DTE" });
  ok(r.ok && r.frame === "15m" && r.lane === null && r.horizon === "0DTE" && r.view === "15m · 1 month · 0DTE horizon", "dte + interval: interval sets the frame, dte only the horizon label");
  r = P({ interval: "daily", dte: "15DTE", lookback: "1month" });
  ok(r.frame === "daily" && r.horizon === "15DTE" && r.lane === null, "dte + daily interval: frame daily, horizon 15DTE");
  for (const [iv, lb] of [["5m", "1week"], ["15m", "1month"], ["1h", "1month"], ["4h", "1month"], ["daily", "3months"]]) {
    r = P({ interval: iv });
    ok(r.frame === iv && r.lookback === lb && r.lookbackSource === `default for ${iv}`, `interval ${iv} alone → default lookback ${lb}`);
  }
  for (const [lb, iv] of [["1week", "15m"], ["1month", "1h"], ["3months", "daily"]]) {
    r = P({ lookback: lb });
    ok(r.frame === iv && r.lookback === lb && r.intervalSource.startsWith("picked for"), `lookback ${lb} alone → ${iv} frame`);
  }
  for (const iv of ["5m", "15m", "1h", "4h"]) {
    r = P({ interval: iv, lookback: "3months" });
    ok(r.ok && r.frame === "daily" && r.fallback?.from === iv && r.requestedInterval === iv && new RegExp(`${INTRADAY_MAX_DAYS} days`).test(r.fallback.why) && r.view.includes(`(${iv} → daily fallback)`), `${iv} + 3months → daily fallback, labelled`);
  }
  ok(!P({ interval: "daily", lookback: "3months" }).fallback, "daily + 3months → no fallback");
  ok(!P({ interval: "15m", lookback: "1month" }).fallback && !P({ interval: "1h", lookback: "1month" }).fallback, "intraday ≤ 44 days → no fallback");
  for (const bad of ["2m", "30m", "weekly", "1w", "x"]) ok(!P({ interval: bad }).ok && /isn't an interval\. Use 5m, 15m, 1h, 4h or daily\./.test(P({ interval: bad }).error), `rejects interval ${bad}`);
  ok(/use interval daily/.test(P({ interval: "1day" }).error), "interval 1day → points to daily");
  for (const bad of ["2weeks", "6months", "1y", "1m"]) ok(!P({ lookback: bad }).ok && /isn't a lookback\. Use 1week, 1month or 3months\./.test(P({ lookback: bad }).error), `rejects lookback ${bad}`);
  for (const d of ["1day", "1d", "today"]) ok(P({ lookback: d, interval: "5m" }).error === TOO_LITTLE_1DAY, `lookback ${d} → plain too-little-data`);
  ok(/4h over 1 week is too little data/.test(P({ interval: "4h", lookback: "1week" }).error) && /daily over 1 week is too little data/.test(P({ interval: "daily", lookback: "1week" }).error), "4h/daily over 1week → too little data");
  ok(!P({ ticker: "SPY1", interval: "15m" }).ok && /isn't a ticker/.test(P({ ticker: "SPY1", interval: "15m" }).error), "bad ticker still rejected first");
  ok(!P({ dte: "soon", interval: "15m" }).ok, "bad dte still rejected with interval");
}

// ── 1h/4h grouping, windows, zones, status (synthetic bars) ──
const ET = (d, m) => `${d}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
function weekdays(from, to) {
  const out = [];
  for (let t = Date.parse(from + "T12:00:00Z"); t <= Date.parse(to + "T12:00:00Z"); t += 86400000) {
    const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const wave = (k, base = 50) => base + 4 * Math.sin(k / 9) + 1.5 * Math.sin(k / 2.3);
function bars15(days, stepMin = 15, endMins = 960) {
  const out = []; let k = 0;
  for (const d of days) for (let m = 570; m < endMins; m += stepMin, k++) {
    const c = wave(k / (15 / stepMin)), o = wave((k - 1) / (15 / stepMin));
    out.push({ t: ET(d, m), session: "regular", open: o, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2, close: c, volume: 1000 + k, vwap: (o + c) / 2 });
  }
  return out;
}
{
  const days = weekdays("2026-10-19", "2026-10-23");
  const m15 = bars15(days);
  const strip = (b) => { const { closeT, ...r } = b; return r; };
  ok(JSON.stringify(toNh(m15, 60).map(strip)) === JSON.stringify(to1h(m15)), "toNh(15m, 60) == src/sr/bars.js to1h (same grouping)");
  const h4 = toNh(m15, 240);
  ok(h4.length === days.length * 2 && h4[0].t.endsWith("09:30:00") && h4[1].t.endsWith("13:30:00") && h4[0].closeT.endsWith("13:30:00") && h4[1].closeT.endsWith("16:00:00"), "4h = 09:30–13:30 + 13:30–16:00 per session");
  ok(h4[0].high === Math.max(...m15.slice(0, 16).map((b) => b.high)) && h4[0].close === m15[15].close && h4[1].volume === m15.slice(16, 26).reduce((s, b) => s + b.volume, 0), "4h OHLCV from its 15m bars (16 + 10)");
  const partial = frameBars({ m15: bars15(["2026-10-26"], 15, 720), m5: [], daily: [] }, "4h", "2026-10-26T12:00:00");
  ok(partial.length === 0, "partial live 4h bar is not used (closes 13:30 > now)");
  const w = windowOf(m15, "2026-10-26", "1week");
  ok(w.cutoff === "2026-10-19" && m15[w.from].t.startsWith("2026-10-20") && (w.from === 0 || !m15[w.from - 1].t.startsWith("2026-10-2")), "1week window: days after today−7");
  ok(frameZones(m15, m15.length - 10, "15m").tooFew === true, "< 20 bars in window → too few");
  const fz = frameZones(m15, 0, "15m");
  const spot = m15[m15.length - 1].close;
  const pk = pickLevels(fz.zones, spot);
  ok(!fz.tooFew && pk.support && pk.resistance && pk.support.hi < spot && pk.resistance.lo > spot, "support fully below spot, resistance fully above");
  ok(fz.zones.every((z) => z.hi - z.lo <= 4 * fz.half + 1e-9 && z.hi - z.lo > 0), "zone width capped at 2× half-width each side");
  // status: held / broke on a hand-made zone
  const mk = (cs) => cs.map((c, i) => ({ t: ET("2026-10-23", 570 + i * 15), closeT: ET("2026-10-23", 585 + i * 15), open: c, high: c + 0.3, low: c - 0.3, close: c }));
  const prev = [{ t: ET("2026-10-22", 945), closeT: ET("2026-10-22", 960), open: 52, high: 52.3, low: 51.7, close: 52 }];
  const z = { lo: 50, hi: 51 };
  ok(latestStatus([...prev, ...mk([51.8, 51.2, 51.6, 52])], "15m", { support: z }).status.key === "support-held", "dip into zone, close back above → Support Held");
  ok(latestStatus([...prev, ...mk([51.5, 49.5, 49.4])], "15m", { resistance: z }).status.key === "support-broke", "close below zone → Support Broke");
  ok(latestStatus([...prev, ...mk([51.5, 49.5, 49.4])], "15m", { resistance: z }).status.text === "price closed below $50.00–$51.00 (one close, not confirmed)", "status text names the zone it refers to");
  ok(latestStatus([...prev, ...mk([52.5, 53, 53.2])], "15m", { support: z }).status.key === "none", "no visit → Between Levels");
}

// ── interval/lookback through the HTTP handler ──
// Fake Tradier with moving prices: daily since 2025, 5m/15m regular session for the
// last 44 days. Fixed clock: Wed 2026-10-28 15:00 ET.
const NOW = new Date("2026-10-28T19:00:00Z");
function waveTradier({ intraday = true } = {}) {
  const dd = weekdays("2025-01-02", "2026-10-28");
  const daily = dd.map((d, k) => { const c = wave(k * 3), o = wave(k * 3 - 3); return { date: d, open: o, high: Math.max(o, c) + 0.5, low: Math.min(o, c) - 0.5, close: c, volume: 3_000_000 }; });
  const id = weekdays("2026-09-14", "2026-10-28");
  const rows = (step) => bars15(id, step, 960).filter((b) => b.t < "2026-10-28T15:00:00").map((b) => ({ time: b.t, timestamp: 0, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, vwap: b.vwap }));
  const r5 = rows(5), r15 = rows(15);
  return {
    hasToken: true,
    quotes: async (s) => [{ symbol: s[0], type: "stock", last: r15[r15.length - 1].close }],
    daily: async () => daily,
    timesales: async (_s, o) => (!intraday ? [] : (o.interval === "5min" ? r5 : r15).filter((r) => r.time >= o.start.slice(0, 10))),
  };
}
function frameSetup(tradier = waveTradier()) {
  const cap = captureSend();
  const handle = createInteractionsHandler({ publicKey: signer.publicKeyHex, tradier, send: cap.send, dbPath: NO_DB, now: () => NOW, log: (e) => logs.push(e) });
  return async (obj) => {
    const body = JSON.stringify(obj);
    const r = await handle({ method: "POST", headers: signer.headers(body), body });
    await r.background;
    return { ack: JSON.parse(r.body), ops: [...cap.ops.splice(0)] };
  };
}
{
  const call = frameSetup();
  const eph = (x) => x.ack.type === 4 && x.ack.data.flags === 64 && x.ops.length === 0;
  let x = await call(chartInteraction({ ticker: "SOFI", interval: "15m", lookback: "1month", user: "f0", channelId: "123" }));
  ok(eph(x) && x.ack.data.content === `/chart works in <#${SR_CHANNEL_ID}> only.`, "interval + wrong channel → same ephemeral, no chart");
  x = await call(chartInteraction({ ticker: "SOFI", interval: "2m", user: "f1" }));
  ok(eph(x) && /isn't an interval/.test(x.ack.data.content), "bad interval → ephemeral, no defer, no chart");
  x = await call(chartInteraction({ ticker: "SOFI", lookback: "6months", user: "f2" }));
  ok(eph(x) && /isn't a lookback/.test(x.ack.data.content), "bad lookback → ephemeral, no chart");
  x = await call(chartInteraction({ ticker: "SOFI", interval: "5m", lookback: "1day", user: "f3" }));
  ok(eph(x) && x.ack.data.content === TOO_LITTLE_1DAY, "lookback 1day → plain too-little-data, no chart");
  x = await call(chartInteraction({ ticker: "SOFI", interval: "15m", lookback: "1month", user: "f3" }));
  ok(x.ack.type === 5, "rejections above don't use up the 1/min slot");

  const card = (x) => x.ops[0]?.payload?.embeds?.[0];
  let e = card(x);
  ok(x.ops[0]?.kind === "edit-original" && x.ops[0].files[0].name === "chart-SOFI-15m-1month.png" && x.ops[0].files[0].data.subarray(1, 4).toString() === "PNG", "15m 1month → PNG named with ticker/interval/lookback");
  ok(/^SOFI — .+ · 15m · 1 month$/.test(e.title) && e.footer.text === FOOTER, "card title shows 15m · 1 month; paper footer");
  ok(/^Price \*\*\$[\d.]+\*\* · Support below .* · Resistance above /.test(e.description) && /Levels are informational, not a proven edge\./.test(e.description), "card: price + support + resistance + informational line");
  ok(/Levels from \*\*15m\*\* bars, last \*\*1 month\*\* \(Sep 29–Oct 28, 22 sessions\)\./.test(e.description), `card shows frame + window actually used (${e.description.split("\n")[2]})`);

  x = await call(chartInteraction({ ticker: "SOFI", interval: "15m", lookback: "3months", dte: "5DTE", user: "f4" }));
  e = card(x);
  ok(x.ops[0]?.files[0].name === "chart-SOFI-15m-3months-fallback-daily.png" && /· daily · 3 months \(15m → daily fallback\) · 5DTE horizon$/.test(e.title), "15m 3months → daily fallback in title + file name");
  ok(/Levels from \*\*daily\*\* bars, last \*\*3 months\*\* .*you asked for 15m, but 15m bars only go back 44 days, so 3 months uses daily bars\./.test(e.description), "fallback explained on the card");
  ok(/Trade horizon 5DTE: label only, the interval sets the frame\./.test(e.description), "dte shown as horizon label only");
  const fl = logs.find((l) => l.user === "f4");
  ok(fl?.outcome === "ok" && fl.used?.frame === "daily" && fl.used.fallback === true && fl.used.requestedInterval === "15m" && fl.interval === "15m" && fl.lookback === "3months", "log records requested + used frame");

  x = await call(chartInteraction({ ticker: "SOFI", interval: "4h", lookback: "1month", user: "f5" }));
  e = card(x);
  ok(x.ops[0]?.files[0].name === "chart-SOFI-4h-1month.png" && /Levels from \*\*4h\*\* bars/.test(e?.description) && logs.find((l) => l.user === "f5")?.used?.bars >= 40, "4h 1month → grouped 4h frame (≥ 40 bars)");

  x = await call(chartInteraction({ ticker: "SOFI", user: "f6" }));
  ok(x.ops[0]?.files[0].name === "chart-SOFI.png" && !/Levels from/.test(card(x)?.description ?? "x"), "no interval/lookback → old default card unchanged");

  const noIntra = frameSetup(waveTradier({ intraday: false }));
  x = await noIntra(chartInteraction({ ticker: "SOFI", interval: "5m", lookback: "1week", user: "f7" }));
  ok(x.ack.type === 5 && x.ops[0]?.kind === "replace-with-ephemeral" && /^Too little data for SOFI 5m levels over 1 week: 0 bars \(need 20\)/.test(x.ops[0].payload.content) && !x.ops[0].files.length, "no intraday bars → plain too-little-data, never invented bars");

  const thin = frameSetup(fakeTradier({ price: 2, volume: 50_000 }));
  x = await thin(chartInteraction({ ticker: "AACG", interval: "15m", lookback: "1month", user: "f8" }));
  ok(x.ops[0]?.kind === "replace-with-ephemeral" && /too thin for S\/R levels/.test(x.ops[0].payload.content), "liquidity guard still applies with interval");
}

// ── interval/lookback with live Tradier (only via ./run-dryrun-vm.sh --test) ──
if (live.hasToken) {
  const { call } = setup({ tradier: live });
  const x = await call(chartInteraction({ ticker: "SOFI", interval: "15m", lookback: "1month", user: "lv1" }));
  const e = x.ops[0]?.payload?.embeds?.[0];
  ok(x.ops[0]?.kind === "edit-original" && x.ops[0].files[0].name === "chart-SOFI-15m-1month.png" && /Levels from \*\*15m\*\* bars, last \*\*1 month\*\*/.test(e?.description), "live SOFI 15m 1month → chart + frame line");
  const y = await call(chartInteraction({ ticker: "SPY", interval: "4h", lookback: "1month", user: "lv2" }));
  ok(y.ops[0]?.files?.[0]?.name === "chart-SPY-4h-1month.png", "live SPY 4h 1month → chart");
  console.log(`info: live SOFI 15m/1month — ${e?.description.split("\n")[0]}`);
}

ok(logs.length >= 8 && logs.every((l) => l.outcome && l.at && "ticker" in l), "every /chart request logged");
ok(!JSON.stringify(logs).match(/Bearer\s|Bot\s|dry-interaction|[\w-]{20,}\.[\w-]{6}\.[\w-]{20,}/), "no credentials / interaction tokens in logs");

console.log(`${pass} passed, ${fail} failed (Tradier: ${live.hasToken ? "live" : "offline"})`);
process.exit(fail ? 1 : 0);
