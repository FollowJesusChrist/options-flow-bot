// chart-cmd/chart.js — S/R chart PNG: price line, green support zone, red
// resistance zone, Pacific-time axis, last-price dot. Same clean style as the SPY
// test chart. Built as SVG and rasterised by resvg with the bundled DejaVu font,
// so it renders the same on macOS, a bare VPS, or here.

import { Resvg } from "@resvg/resvg-js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "fonts");
const W = 1500, H = 750;
const M = { l: 110, r: 150, t: 78, b: 92 };
const C = { line: "#1f3a93", grid: "#e6e6e6", axis: "#222", res: "#f4c7c3", resText: "#c0392b", sup: "#c9f0d9", supText: "#1e8449", muted: "#777" };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dec = (p) => (p < 10 ? 3 : 2);
const fmt = (p) => p.toFixed(dec(p));

function niceStep(span, n) {
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw);
}

// ET wall clock 'YYYY-MM-DDTHH:MM:SS' → 'HH:MM' Pacific (ET−3h; both zones share DST dates).
export function ptHm(t) {
  const h = (Number(t.slice(11, 13)) + 21) % 24;
  return `${String(h).padStart(2, "0")}:${t.slice(14, 16)}`;
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (t) => `${MON[Number(t.slice(5, 7)) - 1]} ${Number(t.slice(8, 10))}`;

// Which bars to draw for a lane. Returns { bars, kind, span }.
export function chartSeries(chart, lane) {
  if (lane === "L4") return { bars: chart.daily.slice(-90), kind: "daily", span: "90 days, daily" };
  if (lane === "L2") {
    const days = [...new Set(chart.m15.map((b) => b.t.slice(0, 10)))].slice(-5);
    return { bars: chart.m15.filter((b) => days.includes(b.t.slice(0, 10))), kind: "multiday", span: "last 5 sessions, 15m" };
  }
  const day = chart.lastDay;
  let bars = chart.all15.filter((b) => b.t.startsWith(day));
  if (bars.length < 8) bars = chart.all5.filter((b) => b.t.startsWith(day));
  return { bars, kind: "intraday", span: "latest session" };
}

// opts: { symbol, title, series: {bars, kind}, support, resistance, last, footer }
export function buildSvg({ symbol, title, series, support, resistance, last, footer = "Paper mode · Levels are informational" }) {
  const bars = series.bars;
  const ys = bars.map((b) => b.close);
  for (const z of [support, resistance]) if (z) ys.push(z.lo, z.hi);
  if (Number.isFinite(last)) ys.push(last);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = Math.max((hi - lo) * 0.06, hi * 0.001);
  lo -= pad; hi += pad;
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const n = Math.max(1, bars.length - 1);
  const x = (i) => M.l + 12 + (i / n) * (pw - 24);
  const y = (p) => M.t + ((hi - p) / (hi - lo)) * ph;
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans">`);
  o.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  o.push(`<text x="${W / 2}" y="46" text-anchor="middle" font-size="30" font-weight="bold" fill="#111">${esc(title)}</text>`);

  // y grid + ticks
  const step = niceStep(hi - lo, 7);
  const tdec = (String(+step.toPrecision(3)).split(".")[1] || "").length;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    o.push(`<line x1="${M.l}" x2="${W - M.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`);
    o.push(`<text x="${M.l - 12}" y="${(y(v) + 6).toFixed(1)}" text-anchor="end" font-size="17" fill="${C.axis}">${v.toFixed(tdec)}</text>`);
  }
  // x ticks
  const nt = Math.min(8, bars.length);
  const tickIdx = [...new Set(Array.from({ length: nt }, (_, k) => Math.round((k * n) / Math.max(1, nt - 1))))];
  for (const i of tickIdx) {
    const b = bars[i];
    if (!b) continue;
    const lab = series.kind === "daily" ? md(b.t) : series.kind === "multiday" ? `${md(b.t)} ${ptHm(b.t)}` : ptHm(b.t);
    o.push(`<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${M.t}" y2="${H - M.b}" stroke="${C.grid}" stroke-width="1"/>`);
    o.push(`<text x="${x(i).toFixed(1)}" y="${H - M.b + 28}" text-anchor="middle" font-size="17" fill="${C.axis}">${esc(lab)}</text>`);
  }

  // zones (drawn under the price line)
  const labels = [];
  for (const [z, name, fill, tc] of [[resistance, "Resistance", C.res, C.resText], [support, "Support", C.sup, C.supText]]) {
    if (!z) continue;
    const y1 = y(z.hi), y2 = y(z.lo);
    o.push(`<rect x="${M.l}" y="${y1.toFixed(1)}" width="${pw}" height="${Math.max(2, y2 - y1).toFixed(1)}" fill="${fill}" fill-opacity="0.75" stroke="${tc}" stroke-opacity="0.18"/>`);
    labels.push({ name, z, tc, yc: (y1 + y2) / 2 });
  }
  if (labels.length === 2 && Math.abs(labels[0].yc - labels[1].yc) < 30) { // keep labels apart on tight zones
    const mid = (labels[0].yc + labels[1].yc) / 2;
    labels[0].yc = mid - 16; labels[1].yc = mid + 16;
  }
  for (const L of labels) {
    o.push(`<text x="${M.l + 70}" y="${(L.yc + 7).toFixed(1)}" font-size="20" fill="${L.tc}" stroke="#ffffff" stroke-width="4" stroke-opacity="0.9" stroke-linejoin="round" paint-order="stroke"><tspan font-weight="bold">${L.name}</tspan>  ${fmt(L.z.lo)}–<tspan font-weight="bold">${fmt(L.z.hi)}</tspan></text>`);
  }

  // price line + last price
  const pts = bars.map((b, i) => `${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join(" ");
  o.push(`<polyline points="${pts}" fill="none" stroke="${C.line}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
  const lp = Number.isFinite(last) ? last : ys[bars.length - 1];
  const lx = x(bars.length - 1), ly = y(lp);
  o.push(`<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="7" fill="${C.line}"/>`);
  o.push(`<text x="${(lx + 14).toFixed(1)}" y="${(ly - 14).toFixed(1)}" font-size="22" font-weight="bold" fill="#111" stroke="#ffffff" stroke-width="4" stroke-opacity="0.9" stroke-linejoin="round" paint-order="stroke">$${fmt(lp)}</text>`);

  // frame + axis titles + footer
  o.push(`<rect x="${M.l}" y="${M.t}" width="${pw}" height="${ph}" fill="none" stroke="${C.axis}" stroke-width="1.2"/>`);
  o.push(`<text x="${M.l + pw / 2}" y="${H - 22}" text-anchor="middle" font-size="19" fill="${C.axis}">${series.kind === "daily" ? "Date" : "Time (PT)"}</text>`);
  o.push(`<text transform="translate(34 ${M.t + ph / 2}) rotate(-90)" text-anchor="middle" font-size="19" fill="${C.axis}">Price ($)</text>`);
  o.push(`<text x="${W - 16}" y="${H - 14}" text-anchor="end" font-size="14" fill="${C.muted}">${esc(footer)}</text>`);
  o.push(`</svg>`);
  return o.join("\n");
}

export function renderPng(svg) {
  const r = new Resvg(svg, {
    font: { fontFiles: [join(FONT_DIR, "DejaVuSans.ttf"), join(FONT_DIR, "DejaVuSans-Bold.ttf")], loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" },
    fitTo: { mode: "width", value: W },
  });
  return r.render().asPng();
}
