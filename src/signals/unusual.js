// unusual.js — triple-filter unusual options activity detector.
// v1 thresholds (from research, conservative):
//   V/OI  >= 1.5   (volume vs open interest)
//   V/ADV >= 2.0   (volume vs per-contract 20-day average daily volume from the
//                   vault's contract_daily table; skipped while < 5 days recorded)
//   PREMIUM >= $100K (volume * mid * 100)
// Plus: 0-2 DTE quarantine, repeat-appearance bonus, OI-change confirmation,
// spread/multi-leg trap filter, time-of-day weighting, S/A/B/C tier scoring.
// Tier S is the "sniper" tier: score 90+ AND every conviction gate in
// sniperMisses() must hold, otherwise the signal tops out at A.
//
// No sweep / aggressor-side detection: that needs a trade tape (OPRA prints
// with exchange + price vs NBBO). Tradier's options timesales returns
// `series: null`, and chain snapshots carry only cumulative volume, OI,
// bid/ask and greeks. Add it back only with a real tape feed.

import { premiumBarFor } from "../config.js";

export const THRESHOLDS = {
  vOi: 1.5,
  vAdv: 2.0,
  premiumMin: 100_000,
  minDte: 3, // 0-2 DTE quarantined out of standard scans
  minAdvDays: 5, // ADV is only trusted with >= 5 recorded days
  lotteryDelta: 0.15, // |delta| below this = lottery ticket, tier capped at C
  // Spread trap: only legs that look freshly opened (volume >= OI) can pair up.
  // 0 = consider every traded contract (literal spec; flags most liquid chains).
  spreadPartnerMinVOi: 1.0,
  straddleMinRatio: 0.25, // smaller leg >= 25% of the larger leg
  verticalMaxRatio: 2.0, // volumes within 2x
  sniper: {
    minScore: 90,
    vOi: 3.0,
    minPriorAppearances: 2,
    deltaMin: 0.2,
    deltaMax: 0.6,
    minDte: 7,
  },
};

const TIER_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4 };
const capTier = (tier, cap) => (TIER_RANK[tier] < TIER_RANK[cap] ? cap : tier);

// mid price from bid/ask; falls back to last
export function midOf(q) {
  const bid = Number(q.bid ?? NaN);
  const ask = Number(q.ask ?? NaN);
  if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0) return (bid + ask) / 2;
  const last = Number(q.last ?? NaN);
  return Number.isFinite(last) ? last : 0;
}

export function premiumOf(contract) {
  const vol = Number(contract.volume ?? 0);
  return vol * midOf(contract) * 100;
}

// Underlying ticker: Tradier chain rows carry `underlying`; else the OCC root.
export function underlyingOf(c) {
  return c.underlying || String(c.symbol ?? "").match(/^[A-Z.]+/)?.[0] || "";
}

// Whole days to expiry, floored: 2.2 days out is 2 DTE (quarantined), not 3.
export function dteOf(expiration, now = new Date()) {
  const exp = new Date(expiration + "T16:00:00-04:00"); // equity options expire at ET close
  return Math.max(0, Math.floor((exp - now) / 86400000));
}

// Wall-clock parts in New York time.
export function etParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hour = Number(get("hour")) % 24;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: hour * 60 + Number(get("minute")) };
}

// "open" 09:30-10:00 ET, "power" 15:00-16:00 ET, else null.
export function sessionWindowET(now) {
  if (!now) return null;
  const m = etParts(now).minutes;
  if (m >= 9 * 60 + 30 && m < 10 * 60) return "open";
  if (m >= 15 * 60 && m < 16 * 60) return "power";
  return null;
}

// Sniper conviction gates. Returns the list of gates that FAILED (empty = all pass).
export function sniperMisses({ vOi, oiRising, priorAppearances, premium, underlying, delta, dte, spreadSuspect }) {
  const g = THRESHOLDS.sniper;
  const misses = [];
  if (!(vOi >= g.vOi)) misses.push(`V/OI < ${g.vOi}`);
  if (oiRising !== true) misses.push("OI not rising");
  if (!(priorAppearances >= g.minPriorAppearances)) misses.push(`< ${g.minPriorAppearances} prior appearances`);
  const bar = premiumBarFor(underlying);
  if (!(premium >= bar)) misses.push(`premium < $${Math.round(bar / 1000)}K bar`);
  const ad = Math.abs(delta);
  if (!(ad >= g.deltaMin && ad <= g.deltaMax)) misses.push(`|delta| outside ${g.deltaMin}-${g.deltaMax}`);
  if (!(dte >= g.minDte)) misses.push(`DTE < ${g.minDte}`);
  if (spreadSuspect) misses.push("possible spread leg");
  return misses;
}

// Score 0-100 from combined factors. Returns { score, tier, factors[], ... }.
// `now` (scan time) drives the time-of-day factor; omit it for neutral.
export function score(
  contract,
  { adv = null, advDays = null, priorAppearances = 0, oiRising = false, dte = null, spreadSuspect = false, spreadNote = "", now = null } = {}
) {
  const volume = Number(contract.volume ?? 0);
  const oi = Number(contract.open_interest ?? 0);
  const vOi = oi > 0 ? volume / oi : 0;
  const vAdv = adv && adv > 0 ? volume / adv : null;
  const premium = premiumOf(contract);
  const delta = Number(contract.greeks?.delta ?? NaN);
  const factors = [];
  let score = 0;

  if (vOi >= THRESHOLDS.vOi) {
    const s = Math.min(30, 10 + (vOi - THRESHOLDS.vOi) * 8);
    score += s;
    factors.push(`V/OI ${vOi.toFixed(1)}x (+${s.toFixed(0)})`);
  }
  const advTag = advDays ? ` (${advDays}d)` : "";
  if (vAdv !== null && vAdv >= THRESHOLDS.vAdv) {
    const s = Math.min(25, 8 + (vAdv - THRESHOLDS.vAdv) * 6);
    score += s;
    factors.push(`V/ADV ${vAdv.toFixed(1)}x${advTag} (+${s.toFixed(0)})`);
  } else if (vAdv === null) {
    factors.push(advDays
      ? `V/ADV unknown (${advDays}d history, need ${THRESHOLDS.minAdvDays})`
      : "V/ADV unknown (no history yet)");
  }
  if (premium >= THRESHOLDS.premiumMin) {
    const s = Math.min(20, 8 + Math.log10(premium / THRESHOLDS.premiumMin) * 10);
    score += s;
    factors.push(`premium $${Math.round(premium / 1000)}K (+${s.toFixed(0)})`);
  }
  if (priorAppearances > 0) {
    const s = Math.min(10, priorAppearances * 5);
    score += s;
    factors.push(`repeat appearance x${priorAppearances + 1} (+${s})`);
  }
  if (oiRising) {
    score += 5;
    factors.push("OI rising — position being built (+5)");
  }

  const tod = sessionWindowET(now);
  if (tod === "open") {
    score *= 0.8;
    factors.push("open noise 09:30-10:00 ET (x0.8)");
  } else if (tod === "power") {
    score += 5;
    factors.push("power hour 15:00-16:00 ET (+5)");
  }

  score = Math.round(score);
  const misses = sniperMisses({
    vOi, oiRising, priorAppearances, premium, underlying: underlyingOf(contract), delta, dte, spreadSuspect,
  });
  let tier = score >= 75 ? "A" : score >= 60 ? "B" : score >= 45 ? "C" : "D";
  if (score >= THRESHOLDS.sniper.minScore) {
    if (!misses.length) tier = "S";
    else factors.push(`score 90+ but not sniper: ${misses.join(", ")}`);
  }
  if (tier === "S") factors.unshift("SNIPER: all conviction gates passed");

  const lottery = Number.isFinite(delta) && Math.abs(delta) < THRESHOLDS.lotteryDelta;
  if (lottery) {
    tier = capTier(tier, "C");
    factors.push(`lottery delta ${delta.toFixed(2)} — capped at C`);
  }
  if (spreadSuspect) {
    tier = capTier(tier, "C");
    factors.push(`possible spread leg — not directional${spreadNote ? ` (${spreadNote})` : ""}`);
  }

  return { score, tier, factors, vOi, vAdv, premium, sniper: tier === "S", lottery, spreadSuspect, sniperMisses: misses };
}

// Spread / multi-leg trap: pairs on the same underlying + expiration.
//   call + put, same strike, smaller leg >= 25% of larger  -> straddle/strangle
//   same type, two strikes, volumes within 2x              -> vertical
// Returns Map(OCC symbol -> note). Legs are flagged, never dropped.
export function detectSpreadLegs(chain, { partnerMinVOi = THRESHOLDS.spreadPartnerMinVOi } = {}) {
  const groups = new Map();
  for (const c of chain) {
    const volume = Number(c.volume ?? 0);
    if (volume <= 0) continue;
    const oi = Number(c.open_interest ?? 0);
    const vOi = oi > 0 ? volume / oi : Infinity; // no OI + volume = opened today
    if (vOi < partnerMinVOi) continue;
    const k = `${underlyingOf(c)}|${c.expiration}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out = new Map();
  const mark = (c, note) => { if (!out.has(c.symbol)) out.set(c.symbol, note); };
  const legName = (c) => `${Number(c.strike)}${c.option_type === "put" ? "P" : "C"}`;
  for (const legs of groups.values()) {
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        const a = legs[i], b = legs[j];
        const va = Number(a.volume), vb = Number(b.volume);
        const ratio = Math.min(va, vb) / Math.max(va, vb);
        const sameStrike = Number(a.strike) === Number(b.strike);
        if (a.option_type !== b.option_type && sameStrike && ratio >= THRESHOLDS.straddleMinRatio) {
          mark(a, `straddle/strangle with ${legName(b)}`);
          mark(b, `straddle/strangle with ${legName(a)}`);
        } else if (a.option_type === b.option_type && !sameStrike && ratio >= 1 / THRESHOLDS.verticalMaxRatio) {
          mark(a, `vertical with ${legName(b)}`);
          mark(b, `vertical with ${legName(a)}`);
        }
      }
    }
  }
  return out;
}

// Main scan: contracts[] from Tradier chain (with volume, open_interest, bid, ask, greeks).
// history[OCC] = { appearances, oiRising, adv, advDays } (tracker.historyFor);
// advMap[OCC] = ADV (falls back to history[OCC].adv).
// Returns ranked signals, strongest tier first. Quarantines 0-2 DTE separately.
export function scan(chain, { advMap = {}, history = {}, now = new Date() } = {}) {
  const signals = [];
  const quarantined = [];
  const spreadLegs = detectSpreadLegs(chain);
  for (const c of chain) {
    const volume = Number(c.volume ?? 0);
    if (volume <= 0) continue;
    const dte = dteOf(c.expiration, now);
    if (dte < THRESHOLDS.minDte) {
      quarantined.push({ contract: c, reason: `${dte} DTE — quarantined (theta risk)` });
      continue;
    }
    const oi = Number(c.open_interest ?? 0);
    const vOi = oi > 0 ? volume / oi : 0;
    const h = history[c.symbol] ?? {};
    const adv = advMap[c.symbol] ?? h.adv ?? null;
    const vAdv = adv ? volume / adv : null;
    const premium = premiumOf(c);
    const passes =
      vOi >= THRESHOLDS.vOi &&
      (vAdv === null || vAdv >= THRESHOLDS.vAdv) &&
      premium >= THRESHOLDS.premiumMin;
    if (!passes) continue;
    const spreadNote = spreadLegs.get(c.symbol) ?? "";
    const s = score(c, {
      adv,
      advDays: h.advDays ?? null,
      priorAppearances: h.appearances ?? 0,
      oiRising: h.oiRising ?? false,
      dte,
      spreadSuspect: Boolean(spreadNote),
      spreadNote,
      now,
    });
    if (s.tier === "D") continue;
    signals.push({
      symbol: c.symbol, // OCC symbol
      underlying: c.underlying ?? null,
      optionType: c.option_type, // 'call' | 'put'
      strike: Number(c.strike),
      expiration: c.expiration,
      dte,
      volume,
      openInterest: oi,
      bid: Number(c.bid ?? 0),
      ask: Number(c.ask ?? 0),
      mid: midOf(c),
      delta: Number(c.greeks?.delta ?? NaN),
      iv: Number(c.greeks?.iv ?? NaN),
      ...s,
    });
  }
  // Tier first so capped (spread/lottery) legs don't crowd sniper/A out of top-5.
  signals.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score);
  return { signals, quarantined, scanned: chain.length };
}
