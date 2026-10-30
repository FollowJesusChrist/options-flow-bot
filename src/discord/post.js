// post.js — Discord REST post for options-flow signals.
// Alert-only: posts an embed + visual-only buttons to the alerts channel.
// No order code exists anywhere in this project and none is created here.
//
// Token: DISCORD_BOT_TOKEN env var (never logged, never printed).
// Channel: DISCORD_ALERT_CHANNEL_ID env var.

import { buildSignalEmbed, signalSummary } from "./embeds.js";
import { signalButtons } from "./components.js";

function resolveToken(env = process.env) {
  return (env.DISCORD_BOT_TOKEN || "").trim();
}

function resolveChannelId(env = process.env) {
  return (env.DISCORD_ALERT_CHANNEL_ID || "").trim();
}

// True during Mon–Fri 6:30 AM–1:00 PM Pacific (market hours for this bot).
export function isMarketHoursPT(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dow = get("weekday");
  if (dow === "Sat" || dow === "Sun") return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= 6 * 60 + 30 && mins <= 13 * 60;
}

// Posting is allowed only in market hours, or with an explicit override
// (used solely by the Monday pre-open test-fire).
export function postingAllowed(env = process.env, now = new Date()) {
  return env.OPTIONS_POST_OVERRIDE === "1" || isMarketHoursPT(now);
}

// Post one graded signal. Returns { posted, messageId } or { posted: false, reason }.
// Never throws for a missing token/channel — the scan still logs to the vault.
export async function postSignal(signal, { log = () => {} } = {}) {
  const token = resolveToken();
  const channelId = resolveChannelId();
  if (!token) return { posted: false, reason: "no-token" };
  const { embeds, signalRefId } = buildSignalEmbed(signal, { paperMode: true });
  const body = {
    content: `📡 Paper mode · ${signalSummary(signal)}`,
    embeds,
    components: signalButtons(signalRefId),
  };
  let res;
  try {
    res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    log(`Discord post failed (network): ${e.message}`);
    return { posted: false, reason: "network-error" };
  }
  if (!res.ok) {
    log(`Discord post failed: HTTP ${res.status}`);
    return { posted: false, reason: `http-${res.status}` };
  }
  const data = await res.json();
  return { posted: true, messageId: data.id };
}
