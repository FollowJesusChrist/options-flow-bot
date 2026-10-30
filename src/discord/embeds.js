// embeds.js — Discord embed builders (pure JSON payloads, no discord.js dependency).
// Matches the approved signal mockup. Colors by tier.

export const TIER_COLORS = {
  S: 0xffd700, // gold
  A: 0x57f287, // green
  B: 0x5865f2, // blurple
  C: 0xfee75c, // yellow
  D: 0xed4245, // red
};

const fmtMoney = (n) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;

export function signalId(s) {
  return `${s.underlying}-${s.expiration}-${s.strike}${s.optionType === "call" ? "C" : "P"}`.replace(
    /[^A-Za-z0-9-]/g,
    ""
  );
}

// signal: output of scan() in src/signals/unusual.js, plus optional enrichments:
//   { why: string[], contracts: [{label, strike, delta, mid}], paperMode: bool }
export function buildSignalEmbed(signal, { why = [], contracts = [], paperMode = true } = {}) {
  const emoji = { S: "🔥", A: "🟢", B: "🔵", C: "🟡", D: "🔴" }[signal.tier] ?? "⚪";
  const type = signal.optionType === "call" ? "Call" : "Put";
  const title = `${emoji} TIER ${signal.tier} — Unusual ${type} Activity`;
  const id = signalId(signal);

  const fields = [
    { name: "Premium", value: fmtMoney(signal.premium), inline: true },
    {
      name: "Vol / OI",
      value: `${signal.volume.toLocaleString()} / ${signal.openInterest.toLocaleString()} (${signal.vOi.toFixed(1)}×)`,
      inline: true,
    },
    {
      name: "Vol vs 20d avg",
      value: signal.vAdv ? `${signal.vAdv.toFixed(1)}×` : "n/a",
      inline: true,
    },
    {
      name: "Strike / Exp",
      value: `$${signal.strike} · ${signal.expiration}`,
      inline: true,
    },
    {
      name: "Delta / DTE",
      value: `${Number.isFinite(signal.delta) ? signal.delta.toFixed(2) : "n/a"} / ${signal.dte}`,
      inline: true,
    },
    { name: "Score", value: `${signal.score}/100`, inline: true },
  ];

  const description =
    (signal.tier === "S" ? "🎯 **SNIPER** — every conviction gate passed\n" : "") +
    `**$${signal.underlying}** · ${signal.expiration} $${signal.strike} ${type} · \`${id}\`` +
    (why.length ? `\n\n**Why it fired:**\n${why.map((w) => `• ${w}`).join("\n")}` : "") +
    (signal.factors?.length
      ? `\n\n**Factors:** ${signal.factors.join(" · ")}`
      : "");

  return {
    embeds: [
      {
        title,
        description,
        color: TIER_COLORS[signal.tier] ?? 0x5865f2,
        fields,
        footer: {
          text: `${paperMode ? "Paper mode" : "LIVE"} · Bid/Ask $${signal.bid.toFixed(2)} / $${signal.ask.toFixed(2)} · Dismiss feeds the optimizer`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
    contracts,
    signalRefId: id,
  };
}

// Human-readable one-liner for logs / threads.
export function signalSummary(signal) {
  const type = signal.optionType === "call" ? "C" : "P";
  return `[${signal.tier}] $${signal.underlying} ${signal.expiration} $${signal.strike}${type} score=${signal.score} prem=${fmtMoney(signal.premium)} vOi=${signal.vOi.toFixed(1)}x`;
}
