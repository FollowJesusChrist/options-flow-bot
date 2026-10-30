// sr/fit.js — contract-fit score (spec §4 fit_score, 0–100) with Greeks
// recomputed from the LIVE mid (Tradier Greeks lag ~1h). Paper analysis only:
// nothing here is a trade call. Sizing, when shown, is 1–2% paper of $1,000.

const R = 0.04; // risk-free approximation; q ignored (SPY/QQQ yields are small vs the ATR scale here)

function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
const npdf = (x) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);

export function bs(type, S, K, T, iv) {
  const sq = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (R + (iv * iv) / 2) * T) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-R * T);
  if (type === "call") {
    const price = S * ncdf(d1) - K * df * ncdf(d2);
    const theta = (-(S * npdf(d1) * iv) / (2 * Math.sqrt(T)) - R * K * df * ncdf(d2)) / 365;
    return { price, delta: ncdf(d1), theta };
  }
  const price = K * df * ncdf(-d2) - S * ncdf(-d1);
  const theta = (-(S * npdf(d1) * iv) / (2 * Math.sqrt(T)) + R * K * df * ncdf(-d2)) / 365;
  return { price, delta: ncdf(d1) - 1, theta };
}

export function impliedVol(type, S, K, T, mid) {
  let lo = 0.01, hi = 3;
  if (!(mid > 0) || !(T > 0)) return NaN;
  for (let k = 0; k < 80; k++) {
    const m = (lo + hi) / 2;
    if (bs(type, S, K, T, m).price > mid) hi = m; else lo = m;
  }
  return (lo + hi) / 2;
}

// Years to the 16:00 ET close on the expiration date.
export function yearsTo(expiration, now = new Date()) {
  const exp = new Date(`${expiration}T16:00:00-04:00`); // EDT through Nov 1 2026; EST after
  const off = exp.getTime() > Date.parse("2026-11-01T06:00:00Z") ? 3600000 : 0;
  return Math.max(1 / 365 / 24, (exp.getTime() + off - now.getTime()) / (365 * 86400000));
}

const lin = (x, full, zero) => (full < zero
  ? (x <= full ? 1 : x >= zero ? 0 : (zero - x) / (zero - full))
  : (x >= full ? 1 : x <= zero ? 0 : (x - zero) / (full - zero)));

// contract: Tradier chain row; spot: live underlying; opposing: price of the next
// opposing level edge (or null); dailyAtr; hv20 (annualised); atmIv (recomputed).
export function fitScore({ contract, spot, opposing, dailyAtr, hv20, atmIv, now = new Date() }) {
  const type = contract.option_type;
  const K = Number(contract.strike);
  const bid = Number(contract.bid), ask = Number(contract.ask);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(contract.last);
  const T = yearsTo(contract.expiration_date ?? contract.expiration, now);
  const dte = Math.round(T * 365 * 10) / 10;
  const iv = impliedVol(type, spot, K, T, mid);
  const g = Number.isFinite(iv) ? bs(type, spot, K, T, iv) : { delta: NaN, theta: NaN };
  const labels = [];
  const caps = [];
  const parts = {};

  const be = type === "call" ? K + mid : K - mid;
  if (opposing == null) { parts.breakeven = 30; labels.push("no opposing level in range"); }
  else if (type === "call" ? be < opposing : be > opposing) parts.breakeven = 30;
  else { parts.breakeven = 0; labels.push(`breakeven requires breaking $${opposing.toFixed(2)}`); }

  const target = opposing ?? be;
  const ratio = Math.abs(target - spot) / dailyAtr;
  parts.timeToReach = Math.round(20 * lin(ratio, 0.5 * dte, 1.0 * dte));

  const ad = Math.abs(g.delta);
  if (!Number.isFinite(ad)) parts.delta = 0;
  else if (ad >= 0.3 && ad <= 0.7) parts.delta = 15;
  else if (ad < 0.2) { parts.delta = 0; caps.push("lottery-ticket delta < 0.20 (cap C)"); }
  else parts.delta = 8;

  const ivRatio = atmIv / hv20;
  parts.iv = Number.isFinite(ivRatio) ? Math.round(15 * lin(ivRatio, 1.2, 1.5)) : 0;
  if (ivRatio > 1.5) labels.push("paying up for vol");

  const spreadPct = mid > 0 ? (ask - bid) / mid : Infinity;
  const oi = Number(contract.open_interest ?? 0), vol = Number(contract.volume ?? 0);
  parts.liquidity = Math.round(((spreadPct <= 0.1) + (oi >= 500) + (vol >= 500)) * (10 / 3));

  const thetaPct = Math.abs(g.theta) / mid;
  parts.theta = Number.isFinite(thetaPct) ? Math.round(10 * lin(thetaPct, 0.03, 0.1)) : 0;

  // Expected move (ATM straddle ≈ 0.8·σ·S·√T) vs target distance — label only (§10.3)
  const em = 0.8 * atmIv * spot * Math.sqrt(T);
  if (Number.isFinite(em) && Math.abs(target - spot) > em) labels.push(`expected move ±$${em.toFixed(2)} does not reach target`);

  const stale = contract.greeks?.updated_at ? contract.greeks.updated_at : null;
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  const perContract = mid * 100;
  return {
    score,
    parts, labels, caps,
    contract: {
      symbol: contract.symbol, type, strike: K, expiration: contract.expiration_date ?? contract.expiration, dte,
      bid, ask, mid: +mid.toFixed(2), breakeven: +be.toFixed(2),
      deltaLive: +g.delta.toFixed(3), ivLive: +iv.toFixed(4), thetaLiveDay: +g.theta.toFixed(3),
      deltaTradier: Number(contract.greeks?.delta ?? NaN), ivTradier: Number(contract.greeks?.mid_iv ?? NaN), greeksUpdatedAt: stale,
      atmIv: +atmIv.toFixed(4), hv20: +hv20.toFixed(4), spreadPct: +spreadPct.toFixed(3), oi, volume: vol,
      paperSizing: `1–2% paper of $1,000 = $10–$20 → ${Math.floor(20 / perContract)} contract(s) at mid $${mid.toFixed(2)} (max loss = premium paid)`,
    },
  };
}
