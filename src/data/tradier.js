// tradier.js — Tradier REST client (primary real-time data source).
// Docs: https://docs.tradier.com/docs/getting-started
// Auth: Authorization: Bearer <token>. Sandbox: https://sandbox.tradier.com/v1 (dummy data).
// Production: https://api.tradier.com/v1 (real-time OPRA, needs approved account + token).

export class TradierClient {
  constructor({ base, token }) {
    if (!base) throw new Error("TradierClient: base URL required");
    this.base = base.replace(/\/$/, "");
    this.token = token || "";
  }

  get hasToken() {
    return this.token.length > 0;
  }

  async #get(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Tradier ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  // Option expirations for a symbol. Returns string[] of YYYY-MM-DD.
  async expirations(symbol) {
    const data = await this.#get("/markets/options/expirations", { symbol });
    const dates = data?.expirations?.date;
    return Array.isArray(dates) ? dates : dates ? [dates] : [];
  }

  // Full option chain for symbol+expiration, with Greeks. Returns array of option objects.
  async chain(symbol, expiration, greeks = true) {
    const data = await this.#get("/markets/options/chains", { symbol, expiration, greeks });
    const options = data?.options?.option;
    if (!options) return [];
    const list = Array.isArray(options) ? options : [options];
    // Tradier names the field expiration_date; the detector expects expiration.
    return list.map((o) => ({ ...o, expiration: o.expiration ?? o.expiration_date }));
  }

  // Quotes (with Greeks) for one or more symbols, e.g. ["SPY", "SPY_261121C00585000"].
  async quotes(symbols, greeks = true) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    const data = await this.#get("/markets/quotes", { symbols: list.join(","), greeks });
    const q = data?.quotes?.quote;
    if (!q) return [];
    return Array.isArray(q) ? q : [q];
  }

  // Daily price history for a symbol. Returns array of { date, open, high, low, close, volume }.
  async history(symbol, interval = "daily") {
    const data = await this.#get("/markets/history", { symbol, interval });
    const days = data?.history?.day;
    if (!days) return [];
    return Array.isArray(days) ? days : [days];
  }

  // Time & sales for an option OCC symbol, e.g. SPY_261121C00585000.
  async timeSales(occSymbol, { interval = "1min", start, end } = {}) {
    const data = await this.#get("/markets/timesales", {
      symbol: occSymbol,
      interval,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
    });
    const series = data?.series?.data;
    if (!series) return [];
    return Array.isArray(series) ? series : [series];
  }

  // Convenience: nearest N expirations with chains, for scanner warm-up.
  async warmup(symbol, count = 3) {
    const exps = await this.expirations(symbol);
    const out = [];
    for (const exp of exps.slice(0, count)) {
      out.push({ expiration: exp, chain: await this.chain(symbol, exp) });
    }
    return out;
  }
}
