// chart-cmd/dryrun.js — local dry run of /chart. NOTHING is sent to Discord.
//
// Drives the real handler with a fake interaction object (records reply /
// deferReply / editReply instead of calling Discord), writes each chart PNG to
// disk, and prints the card text. Uses Tradier (read-only) if TRADIER_TOKEN is
// set, otherwise SPY/QQQ from the recorded sr.db only.
//
//   node dryrun.js [TICKER[:DTE] ...]     default: a fixed set of cases
//   OUT_DIR=/path node dryrun.js          where PNGs go (default ./out)

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TradierRO } from "../src/sr/tradier-ro.js";
import { createChartHandler, RateLimiter, logRequest } from "./handler.js";
import { SR_CHANNEL_ID, LAB_GUILD_ID } from "./command.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.OUT_DIR || join(HERE, "out"));
mkdirSync(OUT, { recursive: true });

export function fakeInteraction({ ticker, dte = null, user = "dry-user", channelId = SR_CHANNEL_ID }) {
  const calls = [];
  const t0 = Date.now();
  return {
    calls,
    commandName: "chart",
    user: { id: user, username: user },
    guildId: LAB_GUILD_ID || "test-guild",
    channelId,
    deferred: false,
    replied: false,
    options: { getString: (n) => (n === "ticker" ? ticker : n === "dte" ? dte : null) },
    async reply(p) { this.replied = true; calls.push({ op: "reply", ms: Date.now() - t0, p }); },
    async deferReply(p) { this.deferred = true; calls.push({ op: "deferReply", ms: Date.now() - t0, p }); },
    async editReply(p) { calls.push({ op: "editReply", ms: Date.now() - t0, p }); },
  };
}

const CASES = [
  { ticker: "SPY", user: "u1" },
  { ticker: "SPY", user: "u1", note: "same user again → rate limited" },
  { ticker: "qqq", dte: "0DTE", user: "u2" },
  { ticker: "NVDA", dte: "15DTE", user: "u3" },
  { ticker: "$AAPL", dte: "5dte", user: "u4" },
  { ticker: "SPY1", user: "u5", note: "invalid format" },
  { ticker: "TSLA", dte: "soon", user: "u6", note: "invalid dte" },
  { ticker: "ZZZZZ", user: "u7", note: "unknown ticker" },
  { ticker: "AACG", user: "u8", note: "thin name" },
  { ticker: "SPY", user: "u9", channelId: "123", note: "wrong channel" },
];

async function main() {
  const args = process.argv.slice(2);
  const cases = args.length
    ? args.map((a, k) => { const [ticker, dte] = a.split(":"); return { ticker, dte: dte ?? null, user: `cli${k}` }; })
    : CASES;
  const tradier = new TradierRO({ token: (process.env.TRADIER_TOKEN || "").trim() });
  console.log(`DRY RUN — fake interactions, no Discord. Tradier: ${tradier.hasToken ? "yes (read-only)" : "no (recorded sr.db only)"}. PNGs → ${OUT}\n`);
  const handler = createChartHandler({
    tradier, limiter: new RateLimiter(60_000), channelId: SR_CHANNEL_ID,
    log: (e) => logRequest({ ...e, dryRun: true }),
  });
  for (const c of cases) {
    const i = fakeInteraction(c);
    await handler(i);
    console.log(`── /chart ticker:${c.ticker}${c.dte ? ` dte:${c.dte}` : ""} (user ${c.user})${c.note ? ` — ${c.note}` : ""}`);
    for (const k of i.calls) {
      if (k.op === "deferReply") { console.log(`   ACK deferReply at ${k.ms} ms`); continue; }
      const p = k.p;
      if (p.content) console.log(`   ${k.op}${p.flags === 64 ? " (ephemeral)" : ""}: ${p.content}`);
      for (const e of p.embeds ?? []) {
        console.log(`   ${k.op} at ${k.ms} ms — card:\n     ${e.title}\n     ${e.description.replace(/\n/g, "\n     ")}\n     [${e.footer.text}]`);
      }
      for (const f of p.files ?? []) {
        const path = join(OUT, `dryrun-${f.name}`.replace(".png", `${c.dte ? "-" + c.dte.toUpperCase() : ""}.png`));
        writeFileSync(path, f.attachment);
        console.log(`     PNG → ${path} (${f.attachment.length} bytes)`);
      }
    }
    console.log("");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.stack); process.exit(1); });
