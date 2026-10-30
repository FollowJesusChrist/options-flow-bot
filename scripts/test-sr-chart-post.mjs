// One-off TEST chart post to a Discord channel. Not live posting.
// Reads the bot token and channel from the local .env at runtime only.
// Never prints the token. Uploads a chart PNG as an embed image.
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

const pngPath = process.argv[2] || "./test-chart.png";
const png = fs.readFileSync(pngPath);
const embed = {
  title: "TEST · Chart format test",
  description: "Chart format test only — not a live signal.",
  color: 0x5865f2,
  image: { url: "attachment://test-chart.png" },
  footer: { text: "TEST — chart format test only · S/R bot · Paper mode · Not financial advice" },
  timestamp: new Date().toISOString(),
};

const form = new FormData();
form.append("payload_json", JSON.stringify({ embeds: [embed] }));
form.append("files[0]", new Blob([png], { type: "image/png" }), "test-chart.png");

const res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
  method: "POST",
  headers: { Authorization: `Bot ${token}` },
  body: form,
});
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error("http-" + res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
console.log("posted message_id=" + body.id);
