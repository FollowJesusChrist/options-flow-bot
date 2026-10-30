// One-off TEST post to a Discord channel. Not the live poster.
// Reads the bot token and channel from the local .env at runtime only.
// Never prints the token.
import fs from "node:fs";

function loadLocalEnv() {
  try {
    const text = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* no .env — env vars must be set directly */ }
}
loadLocalEnv();

const token = (process.env.DISCORD_BOT_TOKEN || "").trim();
if (!token) { console.error("no-token: set DISCORD_BOT_TOKEN in .env — see .env.example"); process.exit(1); }
const channel = (process.env.DISCORD_TEST_CHANNEL_ID || "").trim();
if (!channel) { console.error("no-channel: set DISCORD_TEST_CHANNEL_ID in .env"); process.exit(1); }

const embed = {
  title: "TEST · SPY — Resistance Held",
  description: [
    "Price $765.37 · Resistance $765.61–$766.21 · Zone ±$0.28",
    "Held at 10:15, 13:30, 15:15 today — price stayed below the zone.",
    "Support below: $756.33–$761.05 · Resistance above: $766.64–$770.95 (50d average)",
  ].join("\n"),
  color: 0x5865f2,
  footer: { text: "TEST — format test only · S/R bot · Paper mode · Not financial advice" },
  timestamp: new Date().toISOString(),
};

const res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
  method: "POST",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ embeds: [embed] }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error("http-" + res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
console.log("posted message_id=" + body.id);
