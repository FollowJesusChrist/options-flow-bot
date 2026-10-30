// chart-webhook/worker.mjs — host entry points, both sharing handler-http.mjs.
//
//   export default { fetch }   Web-standard fetch handler (Request → Response).
//                              Primary host: Vercel Functions, Node runtime (see
//                              README for why not Cloudflare Workers). Also the
//                              Workers shape: fetch(request, env, ctx).
//   node worker.mjs --serve    Local Node http server, DRY RUN ONLY: Discord webhook
//                              calls are captured and printed, never sent.
//
// Env (names only): DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, TRADIER_TOKEN.

import { createServer } from "node:http";
import { createInteractionsHandler, sendToDiscord } from "./handler-http.mjs";
import { tradierFromEnv } from "./tradier.mjs";

// Vercel keeps the function alive for post-response work only via waitUntil.
const vercelWaitUntil = await import("@vercel/functions").then((m) => m.waitUntil).catch(() => null);

let cached = null; // one handler per warm instance, so the 1/user/min limiter persists
function handlerFor(env) {
  if (!cached) {
    cached = createInteractionsHandler({
      publicKey: String(env.DISCORD_PUBLIC_KEY ?? "").trim(),
      tradier: tradierFromEnv(env),
      send: (op) => sendToDiscord(op, { botToken: String(env.DISCORD_BOT_TOKEN ?? "") }),
      log: (e) => console.log(JSON.stringify({ slash_chart: e })),
    });
  }
  return cached;
}

function keepAlive(p, ctx) {
  if (ctx?.waitUntil) ctx.waitUntil(p);
  else if (vercelWaitUntil) vercelWaitUntil(p);
  // else: long-lived Node process, nothing to do
}

export default {
  async fetch(request, env = process.env, ctx) {
    const body = await request.text();
    const r = await handlerFor(env)({ method: request.method, headers: request.headers, body });
    if (r.background) keepAlive(r.background, ctx);
    return new Response(r.body, { status: r.status, headers: r.headers });
  },
};

// ── Node http adapter (local dry run) ──
export function nodeListener(handle, { onBackground = () => {} } = {}) {
  return (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const r = await handle({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(r.status, r.headers);
        res.end(r.body);
        if (r.background) onBackground(r.background);
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
        console.error(`local server error: ${String(e?.message).slice(0, 200)}`);
      }
    });
  };
}

export function startLocalServer({ handle, port = 8787, onBackground } = {}) {
  const server = createServer(nodeListener(handle, { onBackground }));
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes("--serve")) {
  const handle = createInteractionsHandler({
    publicKey: String(process.env.DISCORD_PUBLIC_KEY ?? "").trim(),
    tradier: tradierFromEnv(),
    send: async (op) => console.log(`DRY RUN — would ${op.kind} (${op.files?.length ?? 0} file(s)); not sent`),
    log: (e) => console.log(JSON.stringify({ slash_chart: { ...e, dryRun: true } })),
  });
  const s = await startLocalServer({ handle, port: Number(process.env.PORT) || 8787 });
  console.log(`DRY RUN local server on http://127.0.0.1:${s.address().port} — Discord calls are captured, never sent.`);
}
