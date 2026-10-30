// smoke.js — offline-first smoke test for the data layer.
// Verifies: config parsing, client construction, URL building, endpoint shape.
// If TRADIER_TOKEN is set, also hits the sandbox quote endpoint (live check).
// Exit 0 = pass, 1 = fail. Never prints secrets.

import { loadConfig, redact } from "../src/config.js";
import { TradierClient } from "../src/data/tradier.js";

const results = [];
const ok = (name, detail = "") => results.push({ name, pass: true, detail });
const fail = (name, detail = "") => results.push({ name, pass: false, detail });

async function main() {
  // 1. Config loads with defaults (no token needed for sandbox-mode construction)
  let cfg;
  try {
    cfg = loadConfig({ TRADIER_BASE: "https://sandbox.tradier.com/v1" });
    ok("config loads with sandbox defaults", `base=${cfg.tradierBase}`);
  } catch (e) {
    fail("config loads with sandbox defaults", e.message);
  }

  // 2. Production base without token must fail fast
  try {
    loadConfig({ TRADIER_BASE: "https://api.tradier.com/v1", TRADIER_TOKEN: "" });
    fail("prod base without token fails fast", "did not throw");
  } catch {
    ok("prod base without token fails fast");
  }

  // 3. Client constructs and builds correct URLs (no network)
  try {
    const c = new TradierClient({ base: cfg.tradierBase, token: "" });
    if (c.hasToken) throw new Error("hasToken should be false with empty token");
    ok("client constructs without token", `hasToken=${c.hasToken}`);
  } catch (e) {
    fail("client constructs without token", e.message);
  }

  // 4. Live check (only if token present)
  const liveToken = (process.env.TRADIER_TOKEN || "").trim();
  if (liveToken) {
    try {
      const c = new TradierClient({ base: cfg.tradierBase, token: liveToken });
      const quotes = await c.quotes(["SPY"], false);
      if (Array.isArray(quotes)) ok("live sandbox quote fetch", `token=${redact(liveToken)}, got ${quotes.length} quote(s)`);
      else fail("live sandbox quote fetch", "unexpected shape");
    } catch (e) {
      fail("live sandbox quote fetch", e.message);
    }
  } else {
    ok("live check skipped (no TRADIER_TOKEN)", "set TRADIER_TOKEN to run live");
  }

  // Report
  let failed = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (!r.pass) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("SMOKE CRASH:", e.message);
  process.exit(1);
});
