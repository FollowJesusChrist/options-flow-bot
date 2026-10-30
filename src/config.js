// config.js — env parsing with fail-fast validation.
// Keys are NEVER logged, NEVER echoed, NEVER committed.

const REQUIRED_IN_PROD = ["TRADIER_TOKEN"];

export function loadConfig(env = process.env) {
  const isProd = (env.TRADIER_BASE || "").includes("api.tradier.com");

  const config = {
    tradierToken: (env.TRADIER_TOKEN || "").trim(),
    tradierBase: (env.TRADIER_BASE || "https://sandbox.tradier.com/v1").replace(/\/$/, ""),
    discordToken: (env.DISCORD_BOT_TOKEN || "").trim(),
    alertChannelId: (env.DISCORD_ALERT_CHANNEL_ID || "").trim(),
    paperMode: true, // ALWAYS true until 30+ validated paper signals. No exceptions.
    isProd,
  };

  const missing = [];
  if (isProd) {
    for (const k of REQUIRED_IN_PROD) {
      if (!env[k] || !String(env[k]).trim()) missing.push(k);
    }
  }
  if (missing.length) {
    throw new Error(`Missing required env vars for production: ${missing.join(", ")}`);
  }
  return config;
}

// Sniper-tier premium bar per underlying (index ETFs trade far more notional,
// so $100K there is noise). Anything not listed uses `default`.
export const PREMIUM_TIERS = {
  SPY: 500_000,
  QQQ: 500_000,
  default: 100_000,
};

export function premiumBarFor(underlying) {
  return PREMIUM_TIERS[String(underlying || "").toUpperCase()] ?? PREMIUM_TIERS.default;
}

// SNIPER_POST_ONLY (default "1"): only tier-S signals post to Discord;
// everything else is logged to the vault quietly. "0" restores the old
// behavior (every non-D signal posts).
export function sniperPostOnly(env = process.env) {
  return (env.SNIPER_POST_ONLY ?? "1").trim() !== "0";
}

// Redaction helper: never print secrets, even partially.
export function redact(s) {
  if (!s) return "(empty)";
  return `(set, ${s.length} chars)`;
}
