// sr-levels-poller/tradier-token.js — read-only Tradier client.
// Token comes from the TRADIER_TOKEN environment variable only.
// Never printed, never logged.

import { TradierRO } from "../src/sr/tradier-ro.js";

export class TradierProvider {
  constructor({ env = process.env } = {}) {
    this.token = (env.TRADIER_TOKEN || "").trim();
    this.client = null;
  }

  get() {
    if (!this.token) throw new Error("Missing TRADIER_TOKEN — see .env.example");
    return (this.client ??= new TradierRO({ token: this.token }));
  }
}
