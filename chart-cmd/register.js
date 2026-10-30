// chart-cmd/register.js — register /chart as a GUILD command on your server
// (CHART_GUILD_ID in env) via REST. Never global.
//
//   node register.js              dry run (default): prints the payload and the
//                                 endpoints it WOULD call. No network at all.
//   node register.js --execute    real run: GET /users/@me (application id),
//                                 then POST the guild command (upsert by name, so
//                                 other commands this app has are left alone).
//
// Already done for the lab server — not part of the normal start. Token: CHART_DISCORD_BOT_TOKEN env only. Never printed.

import { CHART_COMMAND, LAB_GUILD_ID } from "./command.js";

const API = "https://discord.com/api/v10";
const execute = process.argv.includes("--execute");
const token = (process.env.CHART_DISCORD_BOT_TOKEN || "").trim();

export function plan(appId = "<application id from GET /users/@me>") {
  return [
    { method: "GET", url: `${API}/users/@me` },
    { method: "POST", url: `${API}/applications/${appId}/guilds/${LAB_GUILD_ID}/commands`, body: CHART_COMMAND },
  ];
}

async function main() {
  if (!execute) {
    console.log("DRY RUN — nothing sent to Discord. Add --execute to register.\n");
    for (const s of plan()) console.log(`${s.method} ${s.url}${s.body ? "\n" + JSON.stringify(s.body, null, 2) : ""}\n`);
    console.log(`Scope: guild ${LAB_GUILD_ID} only (not global). Token in env: ${token ? "yes" : "no"}.`);
    return;
  }
  if (!token) { console.error("Missing CHART_DISCORD_BOT_TOKEN."); process.exit(1); }
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  const me = await fetch(`${API}/users/@me`, { headers });
  if (!me.ok) { console.error(`GET /users/@me failed: http ${me.status}`); process.exit(1); }
  const appId = (await me.json()).id; // a bot user's id is its application id
  const [, post] = plan(appId);
  const res = await fetch(post.url, { method: "POST", headers, body: JSON.stringify(post.body) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`register failed: http ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    if (res.status === 403) console.error("403 usually means the bot was invited without the applications.commands scope — see README.md.");
    process.exit(1);
  }
  console.log(`Registered /${body.name} (command id ${body.id}) on guild ${LAB_GUILD_ID}. Guild commands show up right away.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
