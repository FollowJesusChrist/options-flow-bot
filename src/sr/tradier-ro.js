// sr/tradier-ro.js — read-only Tradier GETs used by the S/R bot.
// Only GET, only /markets/* paths. No account, order, or trading paths exist here.
// The token is never logged; errors report status + path only.

const ALLOWED_PREFIX = "/markets/";

export class TradierRO {
  constructor({ base = "https://api.tradier.com/v1", token = process.env.TRADIER_TOKEN || "" } = {}) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
  }

  get hasToken() {
    return this.token.length > 0;
  }

  async get(path, params = {}) {
    if (!path.startsWith(ALLOWED_PREFIX)) throw new Error(`TradierRO: path not allowed: ${path}`);
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", "User-Agent": "options-flow-scanner/1.0" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Tradier ${res.status} on ${path}: ${body.slice(0, 160)}`);
    }
    return res.json();
  }

  async timesales(symbol, { interval, start, end, sessionFilter = "all" }) {
    const d = await this.get("/markets/timesales", { symbol, interval, start, end, session_filter: sessionFilter });
    const s = d?.series?.data;
    return !s ? [] : Array.isArray(s) ? s : [s];
  }

  async daily(symbol, { start } = {}) {
    const d = await this.get("/markets/history", { symbol, interval: "daily", start });
    const s = d?.history?.day;
    return !s ? [] : Array.isArray(s) ? s : [s];
  }

  async quotes(symbols) {
    const d = await this.get("/markets/quotes", { symbols: symbols.join(","), greeks: "false" });
    const q = d?.quotes?.quote;
    return !q ? [] : Array.isArray(q) ? q : [q];
  }

  async chain(symbol, expiration) {
    const d = await this.get("/markets/options/chains", { symbol, expiration, greeks: "true" });
    const o = d?.options?.option;
    return !o ? [] : Array.isArray(o) ? o : [o];
  }

  async clock() {
    return (await this.get("/markets/clock"))?.clock ?? null;
  }
}
