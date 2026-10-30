// chart-cmd/card.js — the clean card under the chart: title + 2 lines + paper footer.
// Informational only: no trade call, no sizing, no "buy" framing.

import { ptHm } from "./chart.js";

export const FOOTER = "Paper mode · Not financial advice";
const money = (p) => `$${p.toFixed(p < 10 ? 3 : 2)}`;
const zone = (z) => (z ? `${money(z.lo)}–${money(z.hi)}` : "none in range");
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function when(ev, today) {
  if (!ev) return "";
  if (ev.lane === "L4") return ` at the ${ev.t} close`;
  const day = ev.closeT.slice(0, 10);
  const time = `${ptHm(ev.closeT)} PT`;
  if (day === today) return ` at ${time}`;
  return ` ${DOW[new Date(day + "T12:00:00Z").getUTCDay()]} at ${time}`;
}

// a: analyze() result; meta: { symbol, view, last, today, attachmentName }
export function buildCard(a, { symbol, view, last, today, attachmentName }) {
  const s = a.status;
  const line1 = `Price **${money(last)}** · Support below ${zone(a.support)} · Resistance above ${zone(a.resistance)}`;
  const line2 = s.key === "none"
    ? "No held / broke / failed test of these levels in the latest session. Levels are informational, not a proven edge."
    : `${s.title}${when(a.event, today)}: ${s.text}. Levels are informational, not a proven edge.`;
  return {
    title: `${symbol} — ${s.title}${view && view !== "Nearest levels" ? ` · ${view}` : ""}`,
    description: `${line1}\n${line2}`,
    color: 0x5865f2,
    image: { url: `attachment://${attachmentName}` },
    footer: { text: FOOTER },
    timestamp: new Date().toISOString(),
  };
}
