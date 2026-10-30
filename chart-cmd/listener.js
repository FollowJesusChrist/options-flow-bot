// chart-cmd/listener.js — the program that stays on and answers Discord when
// someone types /chart.
//
// Env only (never printed):
//   CHART_DISCORD_BOT_TOKEN   Discord bot token
//   TRADIER_TOKEN             Tradier token (read-only use)
//
// Posts nothing on its own.

import { Client, Events, GatewayIntentBits } from "discord.js";
import { TradierRO } from "../src/sr/tradier-ro.js";
import { createChartHandler } from "./handler.js";
import { SR_CHANNEL_ID } from "./command.js";

const token = (process.env.CHART_DISCORD_BOT_TOKEN || "").trim();
if (!token) { console.error("Missing CHART_DISCORD_BOT_TOKEN."); process.exit(1); }
const tradier = new TradierRO({ token: (process.env.TRADIER_TOKEN || "").trim() });
if (!tradier.hasToken) { console.error("Missing TRADIER_TOKEN."); process.exit(1); }

const handler = createChartHandler({ tradier });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once(Events.ClientReady, (c) => {
  console.log(`${new Date().toISOString()} /chart is ready (bot ${c.user.tag}). Leave this window open. Ctrl-C stops it.`);
});
client.on(Events.InteractionCreate, (i) => {
  if (!i.isChatInputCommand() || i.commandName !== "chart") return;
  console.log(`${new Date().toISOString()} /chart ${i.options.getString("ticker")} ${i.options.getString("dte") ?? ""} from ${i.user.username}`);
  handler(i).catch((e) => console.error(`handler crash: ${e.message}`));
});
client.on(Events.Error, (e) => console.error(`discord error: ${e.message}`));
process.on("unhandledRejection", (e) => console.error(`unhandled: ${e?.message ?? e}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { client.destroy(); process.exit(0); });

client.login(token).catch((e) => { console.error(`Discord login failed: ${e.message}`); process.exit(1); });
