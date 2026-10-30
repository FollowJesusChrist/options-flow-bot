// sr-levels-poller/dryrun.js — dry run of the poller. NOTHING is sent to Discord.
//
// A fake Discord client serves fake #support-resistance messages and records the
// replies instead of posting them. Tradier is real (read-only) via the vault
// surrogate, or TRADIER_TOKEN if set. Seen-ID state goes to a scratch file (not
// the live vault state); request log entries go to the real log with "dryRun": true.
//
//   node dryrun.js            (or ./run-dryrun.sh)
//   OUT_DIR=/path node dryrun.js   where PNGs go (default ./out)

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPoller, SeenStore, jsonlLogger, paths } from "./poller.js";
import { TradierProvider } from "./tradier-token.js";
import { SR_CHANNEL_ID_DEFAULT } from "../chart-cmd/command.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.OUT_DIR || join(HERE, "out"));
const BOT_ID = "999000000000000001";

// Snowflake for "now + k ms" so fake messages are fresh and ordered.
const snow = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);

export function fakeDiscord(messages) {
  const sent = [];
  let n = 0;
  return {
    sent,
    async me() { return { id: BOT_ID, username: "dry-bot" }; },
    async messages(_ch, { after, limit }) {
      const out = messages.filter((m) => !after || BigInt(m.id) > BigInt(after)).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      return out.slice(0, limit); // Discord returns newest first
    },
    async reply(channelId, messageId, body) {
      const id = `dry-reply-${++n}`;
      sent.push({ id, channelId, messageId, ...body });
      return { id };
    },
  };
}

const t0 = Date.now() - 20_000;
const msg = (k, user, content, bot = false) => ({ id: snow(t0 + k * 1000), content, author: { id: user, username: user, ...(bot ? { bot: true } : {}) } });
export const CASES = [
  [msg(1, "u1", "levels SPY"), "SPY chart + card"],
  [msg(2, "u2", "levels NVDA"), "NVDA chart + card (Tradier only)"],
  [msg(3, "u3", "levels ZZZZZ"), "bad ticker → plain 'couldn't find' reply"],
  [msg(4, "u4", "levels SPY1"), "bad ticker format → plain reply"],
  [msg(5, "u1", "levels QQQ"), "same user within a minute → rate-limit reply"],
  [msg(6, "u5", "SPY looking strong today"), "wrong pattern → ignored, no reply"],
  [msg(7, "u6", "levels are holding up nicely"), "chat that starts with 'levels' → ignored"],
  [msg(8, BOT_ID, "levels SPY", true), "bot's own message → ignored"],
  [msg(9, "u7", "CHART nvda 15dte"), "alias + DTE, case-insensitive → NVDA 15DTE (daily view)"],
  [msg(10, "u8", "levels spy 0DTE"), "SPY 0DTE (today)"],
  [msg(11, "u9", "levels AACG"), "thin name → plain rejection"],
  [msg(12, "u10", "levels TSLA 5DTE"), "TSLA 5DTE (last 5 sessions)"],
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const seenPath = join(OUT, "dryrun-seen.json");
  rmSync(seenPath, { force: true });
  const discord = fakeDiscord(CASES.map(([m]) => m));
  const tradier = new TradierProvider();
  const live = jsonlLogger(paths().log);
  const mk = () => createPoller({
    discord, tradier, channelId: SR_CHANNEL_ID_DEFAULT, botUserId: BOT_ID, seen: new SeenStore(seenPath),
    log: (e) => live({ ...e, dryRun: true }), warn: (m) => console.log(`   WARN ${m}`),
  });
  console.log(`DRY RUN: fake channel, nothing sent to Discord. Tradier read-only. PNGs → ${OUT}\n`);

  const t = Date.now();
  const results = await mk().pollOnce();
  console.log(`poll 1: ${results.length} messages in ${Date.now() - t} ms\n`);
  const notes = new Map(CASES.map(([m, note]) => [m.id, [m, note]]));
  for (const r of results) {
    const [m, note] = notes.get(r.id);
    console.log(`── "${m.content}" (from ${m.author.id === BOT_ID ? "the bot itself" : m.author.id}) | expect: ${note}`);
    const sent = discord.sent.filter((s) => s.messageId === m.id);
    if (!sent.length) console.log(`   no reply (${r.outcome})`);
    for (const s of sent) {
      console.log(`   REPLY to ${s.messageId} [${r.outcome}${r.ms != null ? `, ${r.ms} ms` : ""}]`);
      if (s.content) console.log(`     ${s.content}`);
      if (s.embed) console.log(`     ${s.embed.title}\n     ${s.embed.description.replace(/\n/g, "\n     ")}\n     [${s.embed.footer.text}]`);
      if (s.png) {
        const p = join(OUT, `levels-${s.filename.replace("chart-", "").replace(".png", "")}-${m.id.slice(-4)}.png`);
        writeFileSync(p, s.png);
        console.log(`     PNG ${s.filename} → ${p} (${s.png.length} bytes)`);
      }
    }
  }
  const replies = discord.sent.length;
  const again = await mk().pollOnce(); // fresh poller from the saved seen file = a restart
  console.log(`\nrestart check: new poller from saved seen file → ${again.length} messages re-handled, ${discord.sent.length - replies} new replies (expect 0, 0)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.stack); process.exit(1); });
