// context.js — market-environment snapshot captured at the moment of a signal
// or paper-trade entry/exit. This is the "why" layer: not just what the flow
// did, but what the world looked like when it did it.
//
// Dependency-injected (quoteFn / historyFn) so it runs offline in tests with
// fakes and live against Tradier in production. Never throws — a missing
// context field is recorded as null, never blocks a signal.

// Sector ETF for common underlyings (default: SPY = the market itself).
const SECTOR_ETF = {
  AAPL: "XLK", MSFT: "XLK", NVDA: "XLK", AMD: "XLK", AVGO: "XLK", CRM: "XLK",
  META: "XLC", GOOGL: "XLC", NFLX: "XLC", DIS: "XLC",
  AMZN: "XLY", TSLA: "XLY", HD: "XLY", MCD: "XLY",
  JPM: "XLF", BAC: "XLF", GS: "XLF", V: "XLF", MA: "XLF",
  XOM: "XLE", CVX: "XLE",
  UNH: "XLV", LLY: "XLV", JNJ: "XLV",
  WMT: "XLP", PG: "XLP", COST: "XLP",
  CAT: "XLI", BA: "XLI",
  SPY: "SPY", QQQ: "QQQ", IWM: "SPY", DIA: "SPY",
};

export function sectorEtfFor(underlying) {
  return SECTOR_ETF[String(underlying || "").toUpperCase()] || "SPY";
}

export function vixTag(vix) {
  if (!Number.isFinite(vix)) return "unknown";
  if (vix < 15) return "calm";
  if (vix < 20) return "normal";
  if (vix < 30) return "elevated";
  return "fear";
}

// Market session by Eastern clock: premarket / regular / after-hours / closed.
export function sessionFor(date = new Date()) {
  const et = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  const day = et.getDay();
  if (day === 0 || day === 6) return "closed-weekend";
  if (mins >= 570 && mins < 960) return "regular"; // 9:30–16:00 ET
  if (mins >= 240 && mins < 570) return "premarket"; // 4:00–9:30 ET
  if (mins >= 960 && mins < 1200) return "after-hours"; // 16:00–20:00 ET
  return "closed";
}

function pctChange(q) {
  if (!q || !Number.isFinite(q.last) || !Number.isFinite(q.prevclose) || q.prevclose === 0) return null;
  return ((q.last - q.prevclose) / q.prevclose) * 100;
}

function dayRangePosition(q) {
  if (!q || !Number.isFinite(q.last) || !Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high === q.low) return null;
  return ((q.last - q.low) / (q.high - q.low)) * 100; // 0 = at day low, 100 = at day high
}

// quoteFn(symbols: string[]) -> Promise<Map|object of symbol -> quote>
// Quote shape (Tradier): { symbol, last, prevclose, high, low, volume, average_volume }
// historyFn(symbol) -> Promise<array of { close }> oldest→newest (optional, for 50-day MA)
export async function captureContext({ underlying, quoteFn, historyFn = null, catalyst = "", now = new Date() }) {
  const sym = String(underlying || "").toUpperCase();
  const sectorEtf = sectorEtfFor(sym);
  const wanted = [...new Set(["SPY", "QQQ", "VIX", sectorEtf, sym])];

  let quotes = {};
  try {
    const res = await quoteFn(wanted);
    quotes = res instanceof Map ? Object.fromEntries(res) : (res || {});
  } catch {
    quotes = {}; // context is best-effort; never block the signal
  }

  const uq = quotes[sym];
  const sq = quotes[sectorEtf];

  let vs50d = null;
  if (historyFn && uq && Number.isFinite(uq.last)) {
    try {
      const hist = await historyFn(sym);
      const closes = (hist || []).map((d) => d.close).filter(Number.isFinite).slice(-50);
      if (closes.length >= 20) {
        const ma = closes.reduce((a, b) => a + b, 0) / closes.length;
        vs50d = ((uq.last - ma) / ma) * 100; // % above (+) or below (−) the 50-day MA
      }
    } catch { /* best-effort */ }
  }

  const vix = quotes.VIX && Number.isFinite(quotes.VIX.last) ? quotes.VIX.last : null;

  return {
    capturedAt: now.toISOString(),
    session: sessionFor(now),
    spyChangePct: pctChange(quotes.SPY),
    qqqChangePct: pctChange(quotes.QQQ),
    vix,
    vixTag: vixTag(vix),
    sectorEtf,
    sectorChangePct: pctChange(sq),
    underlyingPrice: uq && Number.isFinite(uq.last) ? uq.last : null,
    underlyingChangePct: pctChange(uq),
    underlyingRangePosPct: dayRangePosition(uq),
    underlyingVs50dPct: vs50d,
    underlyingVolume: uq && Number.isFinite(uq.volume) ? uq.volume : null,
    underlyingAvgVolume: uq && Number.isFinite(uq.average_volume) ? uq.average_volume : null,
    catalyst: catalyst || "",
  };
}

// One-line human summary of a context snapshot — used in Discord + journal.
export function summarizeContext(c) {
  if (!c) return "no context captured";
  const f = (v, suffix = "%") => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}${suffix}` : "n/a");
  const parts = [
    `SPY ${f(c.spyChangePct)}`,
    `QQQ ${f(c.qqqChangePct)}`,
    `VIX ${Number.isFinite(c.vix) ? c.vix.toFixed(1) : "n/a"} (${c.vixTag})`,
    `${c.sectorEtf} ${f(c.sectorChangePct)}`,
  ];
  if (Number.isFinite(c.underlyingChangePct)) parts.push(`underlying ${f(c.underlyingChangePct)} today`);
  if (Number.isFinite(c.underlyingVs50dPct)) parts.push(`${f(c.underlyingVs50dPct)} vs 50-day MA`);
  return parts.join(" · ");
}
