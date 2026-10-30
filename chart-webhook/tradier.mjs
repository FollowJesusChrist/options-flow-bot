// chart-webhook/tradier.mjs — Tradier client for the webhook /chart bot.
// Read-only: wraps src/sr/tradier-ro.js (GET /markets/* only). The bar fetching
// itself (daily back to 2016, 44 days of 5m/15m, extended-hours tail) is
// chart-cmd/data.js, reused unchanged.
//
// Token: TRADIER_TOKEN from the environment only. Never logged, never read from a file.
//
// "Unavailable" means no token, or Tradier failing (network, 401/403, 5xx). When
// Tradier is unavailable the client reports hasToken = false for a short cool-off,
// so data.js falls back to recorded sr.db bars — which exist for SPY/QQQ only. Any
// other ticker then gets a plain "No live data" reply, never levels borrowed from
// SPY/QQQ.

import { TradierRO } from "../src/sr/tradier-ro.js";

export const RECORDED_SYMBOLS = ["SPY", "QQQ"];
const COOL_OFF_MS = 60_000;

// True for errors that mean "Tradier is down / not usable", not "bad request".
export function isOutage(e) {
  if (e?.name === "TypeError") return true; // fetch network failure
  const m = /^Tradier (\d{3}) /.exec(String(e?.message ?? ""));
  return !!m && (m[1] === "401" || m[1] === "403" || m[1][0] === "5");
}

export class GuardedTradier {
  constructor(ro, { now = () => Date.now() } = {}) { this.ro = ro; this.now = now; this.downUntil = 0; }
  get hasToken() { return this.ro.hasToken && this.now() >= this.downUntil; }
  get available() { return this.hasToken; }
  async #call(fn) {
    try { return await fn(); } catch (e) {
      if (isOutage(e)) this.downUntil = this.now() + COOL_OFF_MS;
      throw e;
    }
  }
  quotes(s) { return this.#call(() => this.ro.quotes(s)); }
  daily(s, o) { return this.#call(() => this.ro.daily(s, o)); }
  timesales(s, o) { return this.#call(() => this.ro.timesales(s, o)); }
}

export function tradierFromEnv(env = process.env) {
  const token = String(env.TRADIER_TOKEN ?? "").trim();
  return new GuardedTradier(new TradierRO({ token, ...(env.TRADIER_BASE ? { base: env.TRADIER_BASE } : {}) }));
}
