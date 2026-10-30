// sr/calendar.js — manual macro/event calendar (spec §9: no Tradier calendar endpoint).
//
// SPY/QQQ have no single-name earnings; macro events are what override levels.
// Sources: FOMC 2026 meeting dates as published by the Fed (decision = day 2);
// NFP by the BLS first-Friday convention; monthly opex = third Friday (computed).
// CPI dates are NOT filled in: the BLS 2026 schedule was not verified from here.
// Fill MANUAL_EVENTS before trusting the event penalty. Labelled as unverified
// in every report.

export const MANUAL_EVENTS = {
  "2026-09-16": ["FOMC"],
  "2026-10-28": ["FOMC"],
  "2026-12-09": ["FOMC"],
  "2026-09-04": ["NFP"],
  "2026-10-02": ["NFP"],
  "2026-11-06": ["NFP"],
  // CPI: TODO — add verified 2026 BLS release dates.
};

const HORIZON_BDAYS = { L0: 0, L1: 2, L2: 5, L3: 10, L4: 15 };

function isThirdFriday(d) {
  return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
}

// Macro events (penalty: -10 level, alert capped at B) from `day` through the
// lane horizon (business days). Opex is NOT a penalty: spec §9 handles opex
// pinning as its own row, so it is returned only with { includeOpex: true } as a label.
export function eventsInWindow(day, lane, { includeOpex = false } = {}) {
  const n = HORIZON_BDAYS[lane] ?? 5;
  const out = [];
  let d = new Date(day + "T12:00:00Z");
  let b = 0;
  while (b <= n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const k = d.toISOString().slice(0, 10);
      for (const e of MANUAL_EVENTS[k] ?? []) out.push(`${e} ${k}`);
      if (includeOpex && isThirdFriday(d)) out.push(`opex ${k}`);
      b++;
    }
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}
