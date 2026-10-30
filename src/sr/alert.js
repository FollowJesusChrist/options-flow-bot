// sr/alert.js — alert score, caps, tier → delivery, anti-spam ledger (spec §4, §6).
//
// alert = 0.40·level + 0.35·flow + 0.25·fit, mapped to S/A/B/C/D (unusual.js cutoffs).
// This module only DECIDES what a call would be. Whether anything is posted is
// decided by post.js gates (all OFF by default).

export const TIERS = ["D", "C", "B", "A", "S"];
export const tierOf = (s) => (s >= 90 ? "S" : s >= 75 ? "A" : s >= 60 ? "B" : s >= 45 ? "C" : "D");
const capTo = (tier, max) => (TIERS.indexOf(tier) > TIERS.indexOf(max) ? max : tier);
const downOne = (tier) => TIERS[Math.max(0, TIERS.indexOf(tier) - 1)];

// Flow direction from the option type. Tradier has no aggressor side for
// options, so "bought" is inferred → coherence weighted at half (spec §4).
export function flowDirection(sig) {
  return sig.option_type === "call" || sig.optionType === "call" ? "up" : "down";
}

export function scoreAlert({ lane, watchOnly, levelScore, setup, direction, flow = null, fit = null, tags = [], eventRisk = [], crossIndex = null }) {
  const caps = [];
  const labels = [];
  const flowScore = flow ? flow.score : 0;
  const flowPart = flow ? 0.35 * flowScore * 0.5 : 0; // side inferred → half weight
  if (flow) labels.push("side inferred");
  const alertScore = Math.round((0.4 * levelScore + flowPart + 0.25 * (fit ? fit.score : 0)) * 10) / 10;
  let tier = tierOf(alertScore);

  if (!flow) {
    // No flow → nothing above C; strong levels (≥70) with no flow go to the digest only.
    tier = levelScore >= 70 ? "C" : "D";
    caps.push(levelScore >= 70 ? "no flow: strong level → digest only" : "no flow");
  } else {
    if (flowDirection(flow) !== direction) { tier = capTo(tier, "C"); caps.push(`flow ${flowDirection(flow)} vs ${setup} ${direction} (cap C)`); }
  }
  if (levelScore < 55) { tier = capTo(tier, "C"); caps.push("weak level < 55 (cap C)"); }
  if (fit) for (const c of fit.caps) { tier = capTo(tier, "C"); caps.push(c); }
  if (fit) labels.push(...fit.labels);
  if (eventRisk.length) { tier = capTo(tier, "B"); caps.push("event risk (cap B)"); labels.push(`event risk: ${eventRisk.join(", ")}`); }
  if (setup === "break") {
    if (tags.includes("first-5-min") || tags.includes("lunch-lull")) { tier = downOne(tier); caps.push(`break in ${tags.filter((t) => t !== "session-open-bar").join("/")} (−1 tier)`); }
    if (crossIndex === "disagree") { tier = downOne(tier); caps.push("SPY/QQQ disagree (−1 tier)"); }
  }
  if (watchOnly) caps.push("0–2 DTE lane: watch-only, never posts");

  const delivery = watchOnly ? "watch-log" : { S: "loud", A: "loud", B: "quiet", C: "digest", D: "log" }[tier];
  return { alertScore, tier, caps, labels, delivery };
}

// ---------- anti-spam (applied in order; only loud/quiet are rationed) ----------
//   1 alert per level per direction per session (task limit; stricter than the
//     spec's "different transition may alert again" — the task file wins on spam)
//   cooldown: 30 min per symbol (L2), 1 session per symbol (L4)
//   max 3 loud per symbol per day (beyond → quiet), 8 posts total per day (beyond → digest)
export function applyAntiSpam(db, call, { session, nowT }) {
  if (call.delivery !== "loud" && call.delivery !== "quiet") return { delivery: call.delivery, reason: null };
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  if (q("SELECT 1 FROM alert_ledger WHERE session=? AND symbol=? AND lane=? AND level_key=? AND direction=?", session, call.symbol, call.lane, call.levelKey, call.direction)) {
    return { delivery: "digest", reason: "already alerted this level+direction this session" };
  }
  const last = q("SELECT MAX(t) AS t FROM alert_ledger WHERE session=? AND symbol=? AND lane=? AND delivery IN ('loud','quiet')", session, call.symbol, call.lane)?.t;
  if (last) {
    if (call.lane === "L4") return { delivery: "digest", reason: "L4 cooldown: 1 session per symbol" };
    const mins = (Date.parse(nowT + "Z") - Date.parse(last + "Z")) / 60000;
    if (mins < 30) return { delivery: "digest", reason: `cooldown: ${mins.toFixed(0)} min since last ${call.symbol} post (<30)` };
  }
  let delivery = call.delivery;
  let reason = null;
  if (delivery === "loud") {
    const n = q("SELECT COUNT(*) AS n FROM alert_ledger WHERE session=? AND symbol=? AND delivery='loud'", session, call.symbol).n;
    if (n >= 3) { delivery = "quiet"; reason = "3 loud/symbol/day cap → quiet"; }
  }
  const total = q("SELECT COUNT(*) AS n FROM alert_ledger WHERE session=? AND delivery IN ('loud','quiet')", session).n;
  if (total >= 8) return { delivery: "digest", reason: "8 posts/day cap → digest" };
  return { delivery, reason };
}

export function recordLedger(db, call, { session }) {
  db.prepare(`INSERT OR IGNORE INTO alert_ledger (session, symbol, lane, level_key, direction, transition, delivery, t, call_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(session, call.symbol, call.lane, call.levelKey, call.direction, call.transition, call.delivery, call.t, call.id);
}
