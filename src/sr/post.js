// sr/post.js — #support-resistance posting, WIRED BUT OFF.
//
// Gates (all must pass; none are open today):
//   quiet B posts + C digest: SR_POST_QUIET=1 AND SR_SHADOW_VERIFIED=1 (Maple's
//     dry-run sign-off on the shadow results) AND SR_CHANNEL_ID set (the channel is
//     created separately via the browser seat — this code never creates channels).
//   loud S/A: all of the above AND SR_POST_LOUD=1 AND, for that lane+tier, >= 30
//     graded calls in sr.db whose respected rate beats the mirror control
//     (sign-test p < 0.05). No env switch can bypass the graded-call check.
// Flow dedup: if the move already has a flow alert, the S/R post must be a
//   reply in that alert's thread. The flow bot does not store Discord message ids
//   yet, so such calls are HELD (not posted) until it does.
// Token: SR_DISCORD_BOT_TOKEN or DISCORD_BOT_TOKEN env only. Never read from
//   another bot's folder, never logged.
// Paper mode, no "buy this" framing, no orders.

import { TIER_COLORS } from "../discord/embeds.js";
import { signTestP } from "./grade.js";

const MIN_GRADED = 30;

export function quietGate(env = process.env) {
  const why = [];
  if (env.SR_POST_QUIET !== "1") why.push("SR_POST_QUIET off");
  if (env.SR_SHADOW_VERIFIED !== "1") why.push("shadow results not verified by Maple (SR_SHADOW_VERIFIED)");
  if (!(env.SR_CHANNEL_ID || "").trim()) why.push("no #support-resistance channel id (SR_CHANNEL_ID)");
  return { open: why.length === 0, why };
}

// Per lane+tier evidence from graded calls (replay + shadow).
export function tierEvidence(db) {
  const rows = db.prepare(`SELECT lane, tier, grade, control_grade FROM level_calls
    WHERE watch_only = 0 AND tier IN ('S','A') AND grade IS NOT NULL`).all();
  const cells = {};
  for (const r of rows) {
    const g = JSON.parse(r.grade), c = JSON.parse(r.control_grade || "{}");
    if (g.status === "pending" || !c.mirror || c.mirror.status === "pending") continue;
    const k = `${r.lane}:${r.tier}`;
    const cell = (cells[k] ??= { n: 0, hit: 0, mir: 0, b: 0, c: 0 });
    const h = g.status === "respected", m = c.mirror.status === "respected";
    cell.n++; cell.hit += h; cell.mir += m; cell.b += h && !m; cell.c += !h && m;
  }
  for (const cell of Object.values(cells)) {
    cell.p = signTestP(cell.b, cell.c);
    cell.beats = cell.n >= MIN_GRADED && cell.hit > cell.mir && cell.p < 0.05;
  }
  return cells;
}

export function loudGate(db, env = process.env, lane = null, tier = null) {
  const q = quietGate(env);
  const why = [...q.why];
  if (env.SR_POST_LOUD !== "1") why.push("SR_POST_LOUD off");
  const cells = tierEvidence(db);
  const keys = lane && tier ? [`${lane}:${tier}`] : ["L2:S", "L2:A", "L4:S", "L4:A"];
  for (const k of keys) {
    const c = cells[k];
    if (!c || !c.beats) why.push(`${k}: ${c ? c.n : 0}/${MIN_GRADED} graded${c ? `, ${c.hit} vs mirror ${c.mir}, p=${c.p.toFixed(2)}` : ""} — not proven`);
  }
  return { open: why.length === 0, why, cells };
}

export function buildSrEmbed(call) {
  const zone = `$${call.zone[0].toFixed(2)}–$${call.zone[1].toFixed(2)}`;
  const verb = { held: "held", "break-confirmed": "break confirmed", "break-failed": "break failed" }[call.transition];
  const lines = [
    `**$${call.symbol}** ${call.lane} · ${call.levelLabel} ${zone} **${verb}** (${call.direction === "up" ? "▲" : "▼"} expected)`,
    `Level ${call.levelScore}/100 · Alert ${call.alertScore ?? "—"}/100 · sources: ${call.sources.slice(0, 6).map((s) => s.label).join(", ")}`,
  ];
  if (call.contract) lines.push(`Contract context: ${call.contract.symbol} · BE $${call.contract.breakeven} · Δ ${call.contract.deltaLive} (live recompute) · ${call.contract.paperSizing}`);
  if (call.caps?.length) lines.push(`Caps: ${call.caps.join(" · ")}`);
  if (call.labels?.length) lines.push(`Notes: ${call.labels.join(" · ")}`);
  return {
    title: `${call.tier} · S/R ${verb}`,
    description: lines.join("\n"),
    color: TIER_COLORS[call.tier] ?? 0x5865f2,
    footer: { text: "Paper mode · 0/30 validation gate · not a trade call" },
    timestamp: new Date().toISOString(),
  };
}

// Decide and (only if gates are open) post. Returns { posted, reason }.
export async function postCall(db, call, { env = process.env, flowMessageId = null, fetchFn = fetch } = {}) {
  if (call.delivery === "watch-log" || call.delivery === "log") return { posted: false, reason: `delivery=${call.delivery}` };
  if (call.delivery === "digest") return { posted: false, reason: "C → hourly digest (digest sender is gated with quiet posts)" };
  const gate = call.delivery === "loud" ? loudGate(db, env, call.lane, call.tier) : quietGate(env);
  if (!gate.open) return { posted: false, reason: `gate shut: ${gate.why.join("; ")}` };
  if (call.flowRefId && !flowMessageId) return { posted: false, reason: "flow alert exists for this move; its Discord message id is unknown → held (no duplicate post)" };
  const token = (env.SR_DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN || "").trim();
  if (!token) return { posted: false, reason: "no-token" };
  const channel = flowMessageId ? flowMessageId /* thread id == starter message id */ : env.SR_CHANNEL_ID.trim();
  const body = { content: call.delivery === "loud" && call.tier === "S" ? "📡 S-tier S/R (paper)" : undefined, embeds: [buildSrEmbed(call)], allowed_mentions: { parse: [] } };
  const res = await fetchFn(`https://discord.com/api/v10/channels/${channel}/messages`, {
    method: "POST", headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => null);
  if (!res || !res.ok) return { posted: false, reason: `http-${res ? res.status : "network"}` };
  return { posted: true, reason: null };
}
