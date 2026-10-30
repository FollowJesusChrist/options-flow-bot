// chart-webhook/build.mjs — chart + card for one parsed webhook /chart request.
//   mode "default" (no interval, no lookback) → chart-cmd/handler.js buildChart,
//                  unchanged: nearest levels across lanes, or the dte lane.
//   mode "frame"   → one frame's levels over the lookback window (frames.mjs).
// Same data loading, liquidity guards, chart renderer and card as chart-cmd.
// Read-only Tradier. Paper mode. Levels are informational, not a proven edge.

import { buildChart } from "../chart-cmd/handler.js";
import { checkTicker, liquidity, loadSymbolBars } from "../chart-cmd/data.js";
import { buildSvg, renderPng } from "../chart-cmd/chart.js";
import { buildCard, FOOTER } from "../chart-cmd/card.js";
import { dayOf } from "../src/sr/bars.js";
import { INTERVALS, LOOKBACKS, MIN_FRAME_BARS } from "./command.mjs";
import { frameBars, windowOf, frameZones, pickLevels, latestStatus } from "./frames.mjs";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (day) => `${MON[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const zoneLog = (z) => (z ? { lo: +z.lo.toFixed(2), hi: +z.hi.toFixed(2), label: z.label, visits: z.visits, turns: z.turns } : null);

export function attachmentNameFor(req) {
  if (req.mode !== "frame") return `chart-${req.ticker}.png`;
  const asked = req.fallback ? req.fallback.from : req.frame;
  return `chart-${req.ticker}-${asked}-${req.lookback}${req.fallback ? "-fallback-daily" : ""}.png`;
}

// The card line that says which frame and window were actually used.
export function frameLine(req, { first, last, sessions }) {
  const used = `Levels from **${INTERVALS[req.frame].label}** bars, last **${LOOKBACKS[req.lookback].label}** (${md(first)}–${md(last)}, ${sessions} session${sessions === 1 ? "" : "s"})`;
  const why = [];
  if (req.fallback) why.push(`you asked for ${req.fallback.from}, but ${req.fallback.why}`);
  else if (req.intervalSource !== "given") why.push(`interval ${req.intervalSource}`);
  if (!req.fallback && req.lookbackSource !== "given") why.push(`lookback ${req.lookbackSource}`);
  const horizon = req.horizon ? ` Trade horizon ${req.horizon}: label only, the interval sets the frame.` : "";
  return `${used}${why.length ? `: ${why.join("; ")}` : ""}.${horizon}`;
}

export async function buildWebhookChart(tradier, req, { now = new Date(), dbPath } = {}) {
  if (req.mode !== "frame") {
    const r = await buildChart(tradier, req, { now, dbPath });
    return r.ok ? { ...r, logExtra: { mode: "default" } } : r;
  }
  const chk = await checkTicker(tradier, req.ticker);
  if (!chk.ok) return chk;
  const data = await loadSymbolBars(tradier, req.ticker, { now, dbPath });
  if (!data.ok) return data;
  const liq = liquidity(data.engine.daily, chk.quote);
  if (!liq.ok) return { ok: false, reason: `${req.ticker} is too thin for S/R levels: ${liq.why.join("; ")}.` };

  const all = frameBars(data.engine, req.frame, data.nowT);
  const { from } = windowOf(all, data.today, req.lookback);
  const fz = frameZones(all, from, req.frame);
  if (fz.tooFew) {
    return { ok: false, reason: `Too little data for ${req.ticker} ${INTERVALS[req.frame].label} levels over ${LOOKBACKS[req.lookback].label}: ${fz.bars.length} bars (need ${MIN_FRAME_BARS}). Try a longer lookback or a smaller interval.` };
  }
  const last = Number(chk.quote?.last) > 0 ? Number(chk.quote.last) : fz.bars[fz.bars.length - 1].close;
  const picked = pickLevels(fz.zones, last);
  if (!picked.support && !picked.resistance) return { ok: false, reason: `No support/resistance levels in range for ${req.ticker} right now.` };
  const st = latestStatus(fz.bars, req.frame, picked);
  const a = { ...picked, status: st.status, event: st.event };

  const first = dayOf(fz.bars[0].t), lastDay = dayOf(fz.bars[fz.bars.length - 1].t);
  const sessions = new Set(fz.bars.map((b) => dayOf(b.t))).size;
  const attachmentName = attachmentNameFor(req);
  const span = `${md(first)}–${md(lastDay)}`;
  const series = { bars: fz.bars, kind: req.frame === "daily" ? "daily" : "multiday", span };
  const title = `${req.ticker} — ${req.view} — ${span}`;
  const png = renderPng(buildSvg({ symbol: req.ticker, title, series, support: a.support, resistance: a.resistance, last, footer: `${FOOTER} · Levels are informational` }));
  const card = buildCard(a, { symbol: req.ticker, view: req.view, last, today: data.today, attachmentName });
  const embed = { ...card, description: `${card.description}\n${frameLine(req, { first, last: lastDay, sessions })}` };
  const used = { frame: req.frame, lookback: req.lookback, requestedInterval: req.requestedInterval, fallback: !!req.fallback, from: first, to: lastDay, bars: fz.bars.length, sessions, horizon: req.horizon };
  return {
    ok: true, png, embed, attachmentName, analysis: a, last, sources: data.sources, used,
    logExtra: { mode: "frame", used, support: zoneLog(a.support), resistance: zoneLog(a.resistance), status: a.status.key },
  };
}
