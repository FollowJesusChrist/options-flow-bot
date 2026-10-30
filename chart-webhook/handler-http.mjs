// chart-webhook/handler-http.mjs — answer Discord /chart over HTTP (Interactions
// Endpoint), no gateway websocket. Node built-ins only for HTTP + crypto.
//
// Request in: { method, headers, body (raw string) }. Response out:
// { status, headers, body, background } — `background` is the promise that finishes
// the chart after the ACK; the host adapter must keep it alive (waitUntil).
//
// Flow: Ed25519 signature check (DISCORD_PUBLIC_KEY) → PING→PONG → /chart: the
// existing chart-cmd handler runs against an adapter interaction, with this bot's
// option parser (ticker, dte, interval, lookback: command.mjs) and builder (build.mjs):
//   reply(p)      → the HTTP response itself (type 4; ephemeral flag kept)
//   deferReply()  → the HTTP response itself (type 5, ACK well inside 3 s)
//   editReply(p)  → webhook call after the ACK: chart + card edits the original
//                   message; a plain-text rejection (unknown / thin / no data /
//                   error) is sent as an ephemeral followup and the public
//                   "thinking…" placeholder is deleted.
// All Discord network calls go through ONE function, sendToDiscord(), which the
// dry run and tests replace with a stub.

import { createPublicKey, verify } from "node:crypto";
import { createChartHandler, RateLimiter } from "../chart-cmd/handler.js";
import { SR_CHANNEL_ID } from "../chart-cmd/command.js";
import { parseWebhookChartOptions } from "./command.mjs";
import { buildWebhookChart } from "./build.mjs";

export const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const MAX_SKEW_S = 300; // reject replayed requests older than 5 minutes
const ACK_DEADLINE_MS = 2500; // auto-defer if the handler hasn't answered by then

const json = (status, obj) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(obj), background: null });
const plain = (status, text) => ({ status, headers: { "content-type": "text/plain" }, body: text, background: null });

function header(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? "";
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
  const v = k ? headers[k] : "";
  return Array.isArray(v) ? v[0] : v ?? "";
}

// ── Ed25519 (Discord: signature over timestamp + raw body, hex-encoded) ──
const keyCache = new Map();
function publicKeyObject(hex) {
  if (!keyCache.has(hex)) {
    const raw = Buffer.from(hex, "hex");
    if (raw.length !== 32) throw new Error("DISCORD_PUBLIC_KEY must be 32 bytes hex");
    keyCache.set(hex, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" }));
  }
  return keyCache.get(hex);
}

export function verifyDiscordSignature({ publicKey, signature, timestamp, body, nowS = Date.now() / 1000 }) {
  try {
    if (!publicKey || !/^[0-9a-f]{128}$/i.test(signature ?? "") || !/^\d{1,12}$/.test(timestamp ?? "")) return false;
    if (Math.abs(nowS - Number(timestamp)) > MAX_SKEW_S) return false;
    return verify(null, Buffer.from(timestamp + body, "utf8"), publicKeyObject(publicKey.trim()), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

// ── Discord webhook calls (the ONLY network to Discord; stubbed in dry run) ──
// op: { kind: "edit-original" | "replace-with-ephemeral", applicationId, interactionToken, payload, files }
export function buildDiscordRequests(op, { botToken = "" } = {}) {
  const base = `${DISCORD_API}/webhooks/${op.applicationId}/${op.interactionToken}`;
  const auth = botToken ? { authorization: `Bot ${botToken}` } : {}; // optional: interaction webhooks accept no auth
  const form = () => {
    const fd = new FormData();
    fd.set("payload_json", JSON.stringify(op.payload));
    (op.files ?? []).forEach((f, i) => fd.set(`files[${i}]`, new Blob([f.data], { type: "image/png" }), f.name));
    return fd;
  };
  if (op.kind === "edit-original") return [{ method: "PATCH", url: `${base}/messages/@original`, headers: auth, body: form() }];
  return [
    { method: "POST", url: base, headers: auth, body: form() },
    { method: "DELETE", url: `${base}/messages/@original`, headers: auth, body: null },
  ];
}

export async function sendToDiscord(op, { botToken = process.env.DISCORD_BOT_TOKEN ?? "" } = {}) {
  for (const r of buildDiscordRequests(op, { botToken: botToken.trim() })) {
    const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
    if (!res.ok && !(r.method === "DELETE" && res.status === 404)) throw new Error(`Discord ${res.status} on ${r.method} webhook`);
  }
}

// discord.js-style reply options → raw Discord message payload + files.
function toMessage(p = {}) {
  const files = (p.files ?? []).map((f) => ({ name: f.name, data: f.attachment }));
  const payload = {};
  if (p.content != null) payload.content = p.content;
  if (p.embeds) payload.embeds = p.embeds;
  if (p.flags) payload.flags = p.flags;
  if (p.allowedMentions) payload.allowed_mentions = p.allowedMentions;
  if (p.files) payload.attachments = files.map((f, i) => ({ id: i, filename: f.name }));
  return { payload, files };
}

// One raw interaction → an object with the shape chart-cmd/handler.js calls.
function adapterInteraction(raw, { send, onInitial }) {
  const opts = Object.fromEntries((raw.data?.options ?? []).map((o) => [o.name, o.value == null ? null : String(o.value)]));
  const user = raw.member?.user ?? raw.user ?? {};
  const ids = { applicationId: raw.application_id, interactionToken: raw.token };
  const it = {
    commandName: raw.data?.name,
    user: { id: user.id, username: user.username },
    guildId: raw.guild_id ?? null,
    channelId: raw.channel_id ?? raw.channel?.id ?? null,
    deferred: false,
    replied: false,
    options: { getString: (n) => opts[n] ?? null },
    async reply(p) {
      const m = toMessage(p);
      if (it.deferred || it.replied) return send({ kind: "replace-with-ephemeral", ...ids, payload: { ...m.payload, flags: EPHEMERAL }, files: [] });
      it.replied = true;
      onInitial({ type: 4, data: m.payload });
    },
    async deferReply() {
      if (it.deferred || it.replied) return;
      it.deferred = true;
      onInitial({ type: 5 });
      await new Promise((r) => setTimeout(r, 0)); // let the ACK flush before CPU-heavy chart work
    },
    async editReply(p) {
      const m = toMessage(p);
      const isChart = (m.payload.embeds?.length ?? 0) > 0 || m.files.length > 0;
      if (isChart) return send({ kind: "edit-original", ...ids, ...m });
      // Plain-text outcome after the public defer → ephemeral to the user only.
      return send({ kind: "replace-with-ephemeral", ...ids, payload: { content: m.payload.content, flags: EPHEMERAL, allowed_mentions: { parse: [] } }, files: [] });
    },
  };
  return it;
}

// deps: { publicKey, tradier, send = sendToDiscord, limiter, channelId, log, now, dbPath, ackDeadlineMs }
export function createInteractionsHandler({
  publicKey, tradier, send = (op) => sendToDiscord(op), limiter = new RateLimiter(60_000),
  channelId = SR_CHANNEL_ID, log, now, dbPath, ackDeadlineMs = ACK_DEADLINE_MS, nowS,
} = {}) {
  const chart = createChartHandler({ tradier, limiter, channelId, dbPath, parse: parseWebhookChartOptions, build: buildWebhookChart, ...(log ? { log } : {}), ...(now ? { now } : {}) });

  return async function handle({ method, headers, body }) {
    if (method !== "POST") return plain(405, "method not allowed");
    const raw = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : "";
    const sig = header(headers, "x-signature-ed25519");
    const ts = header(headers, "x-signature-timestamp");
    if (!verifyDiscordSignature({ publicKey, signature: sig, timestamp: ts, body: raw, ...(nowS ? { nowS: nowS() } : {}) })) {
      return plain(401, "invalid request signature");
    }
    let it;
    try { it = JSON.parse(raw); } catch { return plain(400, "bad json"); }

    if (it.type === 1) return json(200, { type: 1 }); // PING → PONG
    if (it.type !== 2) return plain(400, "unsupported interaction type");
    if (it.data?.name !== "chart") return json(200, { type: 4, data: { content: "Unknown command.", flags: EPHEMERAL } });

    let resolveInitial;
    const initial = new Promise((r) => { resolveInitial = r; });
    let first = true;
    const onInitial = (resp) => { if (first) { first = false; resolveInitial(resp); } };
    const ai = adapterInteraction(it, { send, onInitial });
    const work = chart(ai).catch((e) => console.error(`chart handler crash: ${String(e?.message).slice(0, 200)}`));
    let tid;
    const timer = new Promise((r) => { tid = setTimeout(r, ackDeadlineMs, "timeout"); });
    const winner = await Promise.race([initial, work.then(() => "done"), timer]);
    clearTimeout(tid);

    let resp;
    if (winner === "timeout") { await ai.deferReply(); resp = await initial; } // safety ACK; handler finishes via webhook
    else if (winner === "done" && first) resp = { type: 4, data: { content: "Couldn't build a chart right now. Try again in a minute.", flags: EPHEMERAL } };
    else resp = await initial;
    return { ...json(200, resp), background: work };
  };
}
