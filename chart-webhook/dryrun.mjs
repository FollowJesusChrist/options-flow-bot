// chart-webhook/dryrun.mjs — local dry run of the HTTP /chart bot. NOTHING reaches Discord.
//
// Starts the local Node http adapter on 127.0.0.1, sends signed fake Discord
// interactions to it (signed with a throwaway keypair made here — the real
// DISCORD_PUBLIC_KEY is not used), and captures what WOULD be sent to Discord:
// the HTTP ACK (PONG / defer / ephemeral reply) and the stubbed webhook op
// (card + PNG, or an ephemeral rejection). PNGs go to ./out.
// Tradier (read-only) is used if TRADIER_TOKEN is set; otherwise SPY/QQQ come from
// the recorded sr.db and other tickers report "No live data".
//
//   node dryrun.mjs [TICKER[:DTE] ...]       default: fixed case list
//   node dryrun.mjs SOFI:interval=15m,lookback=1month[,dte=5DTE]
//   node dryrun.mjs --frames                 interval + lookback case list (a–f);
//                                            results also → out/frames-results.json
//   ./run-dryrun-vm.sh [...]                 same, with the VM's Tradier surrogate

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createInteractionsHandler } from "./handler-http.mjs";
import { startLocalServer } from "./worker.mjs";
import { tradierFromEnv } from "./tradier.mjs";
import { SR_CHANNEL_ID, LAB_GUILD_ID } from "../chart-cmd/command.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const readLog = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// Throwaway Ed25519 keypair standing in for Discord's signing key.
export function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  const headers = (body, ts = String(Math.floor(Date.now() / 1000))) => ({
    "content-type": "application/json",
    "x-signature-timestamp": ts,
    "x-signature-ed25519": sign(null, Buffer.from(ts + body), privateKey).toString("hex"),
  });
  return { publicKeyHex, headers };
}

let seq = 0;
export function chartInteraction({ ticker, dte = null, interval = null, lookback = null, user = "dry-user", channelId = SR_CHANNEL_ID, name = "chart" }) {
  const options = [{ name: "ticker", type: 3, value: ticker }];
  if (dte != null) options.push({ name: "dte", type: 3, value: dte });
  if (interval != null) options.push({ name: "interval", type: 3, value: interval });
  if (lookback != null) options.push({ name: "lookback", type: 3, value: lookback });
  return {
    type: 2, id: `dry-${++seq}`, application_id: "dry-app", token: `dry-interaction-${seq}`,
    guild_id: LAB_GUILD_ID, channel_id: channelId,
    member: { user: { id: user, username: user } },
    data: { name, type: 1, options },
  };
}

export function captureSend() {
  const ops = [];
  return { ops, send: async (op) => { ops.push({ ...op, at: performance.now() }); } };
}

const CASES = [
  { ping: true, note: "PING" },
  { ticker: "SPY", user: "u1" },
  { ticker: "SPY", user: "u1", note: "same user again → rate limited" },
  { ticker: "SOFI", user: "u2", note: "any-ticker (live Tradier only)" },
  { ticker: "qqq", dte: "0DTE", user: "u3" },
  { ticker: "SPY1", user: "u5", note: "invalid format" },
  { ticker: "TSLA", dte: "soon", user: "u6", note: "invalid dte" },
  { ticker: "ZZZZZ", user: "u7", note: "unknown ticker" },
  { ticker: "AACG", user: "u8", note: "thin name" },
  { ticker: "SPY", user: "u9", channelId: "123", note: "wrong channel" },
  { ticker: "SPY", user: "u10", badSig: true, note: "tampered body" },
];

// interval + lookback cases (task list a–f)
const FRAME_CASES = [
  { ticker: "SOFI", interval: "15m", lookback: "1month", user: "fa", note: "a) 15m over 1 month" },
  { ticker: "SOFI", interval: "daily", lookback: "3months", user: "fb", note: "b) daily over 3 months" },
  { ticker: "SOFI", interval: "5m", lookback: "1week", user: "fc", note: "c) 5m over 1 week" },
  { ticker: "SPY", interval: "4h", lookback: "1month", user: "fd", note: "d) 4h grouped from 15m" },
  { ticker: "SOFI", interval: "15m", lookback: "3months", user: "fe", note: "e) 3 months intraday → daily fallback on the card" },
  { ticker: "SPY", interval: "1h", lookback: "3months", dte: "5DTE", user: "fe2", note: "e2) 1h + 3 months + dte → daily fallback, 5DTE horizon label" },
  { ticker: "SOFI", interval: "15m", dte: "0DTE", user: "fg", note: "dte + interval: interval sets the frame (default 1 month), dte = label" },
  { ticker: "SOFI", interval: "2m", lookback: "1month", user: "ff1", note: "f) bad interval" },
  { ticker: "SOFI", interval: "15m", lookback: "6months", user: "ff2", note: "f) bad lookback" },
  { ticker: "SOFI", interval: "15m", lookback: "1month", user: "ff3", channelId: "123", note: "f) interval + wrong channel" },
  { ticker: "SOFI", interval: "5m", lookback: "1day", user: "ff4", note: "f) 1day lookback → too little data" },
  { ticker: "SOFI", interval: "4h", lookback: "1week", user: "ff5", note: "f) 4h over 1 week → too little data" },
];

function parseArg(a, k) {
  const [ticker, rest] = a.split(":");
  if (!rest) return { ticker, dte: null, user: `cli${k}` };
  if (!rest.includes("=")) return { ticker, dte: rest, user: `cli${k}` };
  return { ticker, user: `cli${k}`, ...Object.fromEntries(rest.split(",").map((kv) => kv.split("="))) };
}

async function main() {
  const OUT = resolve(process.env.OUT_DIR || join(HERE, "out"));
  mkdirSync(OUT, { recursive: true });
  const logPath = join(OUT, "dryrun-log.jsonl");
  const frames = process.argv.includes("--frames");
  const args = process.argv.slice(2).filter((a) => a !== "--frames");
  const cases = frames ? FRAME_CASES : args.length ? args.map(parseArg) : CASES;

  const signer = makeSigner();
  const cap = captureSend();
  const tradier = tradierFromEnv();
  const handle = createInteractionsHandler({
    publicKey: signer.publicKeyHex, tradier, send: cap.send,
    log: (e) => appendFileSync(logPath, JSON.stringify({ ...e, dryRun: true, via: "chart-webhook" }) + "\n"),
  });
  let pending = [], ackWritten = null;
  // onBackground fires right after res.end(), i.e. when the ACK leaves the server. The
  // client below shares this event loop, so its own timing includes the chart CPU work.
  const server = await startLocalServer({ handle, port: 0, onBackground: (p) => { ackWritten = performance.now(); pending.push(p); } });
  const url = `http://127.0.0.1:${server.address().port}/interactions`;
  console.log(`DRY RUN — signed fake interactions → local http adapter; Discord webhook stubbed. Tradier: ${tradier.hasToken ? "yes (read-only, live)" : "NO — recorded sr.db only (SPY/QQQ); other tickers: no live data"}. PNGs → ${OUT}\n`);

  const results = [];
  for (const c of cases) {
    const body = JSON.stringify(c.ping ? { type: 1, id: "ping", application_id: "dry-app", token: "dry-ping" } : chartInteraction(c));
    const headers = signer.headers(body);
    const sent = c.badSig ? body.replace(c.ticker, "QQQ") : body;
    cap.ops.length = 0; pending = []; ackWritten = null;
    const t0 = performance.now();
    const res = await fetch(url, { method: "POST", headers, body: sent });
    const clientMs = performance.now() - t0;
    const ackMs = ackWritten != null ? ackWritten - t0 : clientMs;
    const text = await res.text();
    await Promise.all(pending);
    const label = c.ping ? "PING" : `/chart ticker:${c.ticker}${c.dte ? ` dte:${c.dte}` : ""}${c.interval ? ` interval:${c.interval}` : ""}${c.lookback ? ` lookback:${c.lookback}` : ""} (user ${c.user})`;
    console.log(`── ${label}${c.note ? ` — ${c.note}` : ""}`);
    let ack = null;
    try { ack = JSON.parse(text); } catch { /* plain */ }
    const ackDesc = !ack ? `HTTP ${res.status} "${text}"` : ack.type === 1 ? "PONG (type 1)" : ack.type === 5 ? "DEFER (type 5)" : `type ${ack.type}${ack.data?.flags === 64 ? " ephemeral" : ""}: ${ack.data?.content}`;
    console.log(`   ACK ${ackDesc} written by server at ${ackMs.toFixed(0)} ms${ackWritten != null ? ` (client saw it at ${clientMs.toFixed(0)} ms, same event loop)` : ""}`);
    const r = { label, note: c.note ?? null, status: res.status, ack, ackMs, ops: [] };
    for (const op of cap.ops) {
      const after = (op.at - t0).toFixed(0);
      if (op.kind === "replace-with-ephemeral") console.log(`   webhook (stubbed) at ${after} ms — ephemeral followup + delete placeholder: ${op.payload.content}`);
      for (const e of op.payload.embeds ?? []) console.log(`   webhook (stubbed) at ${after} ms — edit original, card:\n     ${e.title}\n     ${e.description.replace(/\n/g, "\n     ")}\n     [${e.footer.text}]`);
      const pngs = [];
      for (const f of op.files ?? []) {
        const path = join(OUT, `webhook-${f.name}`.replace(".png", `${c.dte ? "-" + c.dte.toUpperCase() : ""}.png`));
        writeFileSync(path, f.data);
        pngs.push({ path, bytes: f.data.length });
        console.log(`     PNG → ${path} (${f.data.length} bytes)`);
      }
      r.ops.push({ kind: op.kind, content: op.payload.content, embed: op.payload.embeds?.[0], pngs });
      if (op.payload.embeds?.length) {
        const used = readLog(logPath).reverse().find((l) => l.user === c.user && l.outcome === "ok");
        r.result = { price: used?.last, support: used?.support, resistance: used?.resistance, status: used?.status, used: used?.used ?? { mode: "default", lane: used?.lane }, png: pngs[0]?.path };
        console.log(`     used: ${JSON.stringify(r.result.used)}`);
      }
    }
    results.push(r);
    console.log("");
  }
  server.close();
  if (frames) {
    const slim = results.map(({ label, note, ack, ops, result }) => ({ label, note, ack: ack?.type === 4 ? ack.data.content : ack?.type === 5 ? "DEFER" : ack, followup: ops.find((o) => o.kind === "replace-with-ephemeral")?.content ?? null, card: ops.find((o) => o.embed)?.embed && { title: ops.find((o) => o.embed).embed.title, description: ops.find((o) => o.embed).embed.description, footer: ops.find((o) => o.embed).embed.footer.text }, result: result ?? null }));
    writeFileSync(join(OUT, "frames-results.json"), JSON.stringify({ at: new Date().toISOString(), tradier: tradier.hasToken ? "live read-only" : "offline", cases: slim }, null, 2));
    console.log(`results → ${join(OUT, "frames-results.json")}`);
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.stack); process.exit(1); });
