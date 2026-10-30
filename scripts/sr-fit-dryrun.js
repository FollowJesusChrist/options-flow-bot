// sr-fit-dryrun.js — exercises the step-4 path (flow join → live contract fit →
// alert score/caps → delivery → gate verdict) on today's live chain, using a
// SYNTHETIC flow stub because no SPY/QQQ flow signal fell inside today's session.
// Writes nothing to the vault and posts nothing. Paper analysis only, not a trade call.
// Run: ./run-sr.sh is not needed; use the same surrogate env:  TRADIER_TOKEN=... node scripts/sr-fit-dryrun.js
import { openSrDb } from "../src/sr/store.js";
import { loadCtx } from "../src/sr/replay.js";
import { LANES, levelsAt, atrOf } from "../src/sr/levels.js";
import { runLane } from "../src/sr/events.js";
import { fitScore, impliedVol, yearsTo } from "../src/sr/fit.js";
import { scoreAlert } from "../src/sr/alert.js";
import { quietGate, loudGate } from "../src/sr/post.js";
import { TradierRO } from "../src/sr/tradier-ro.js";
import { dayOf, hv } from "../src/sr/bars.js";

const c = new TradierRO();
const db = openSrDb();
const mid = (o) => (o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.last);
for (const sym of ["SPY", "QQQ"]) {
  const ctx = loadCtx(db, sym);
  const bars = ctx.frames["15min"];
  const days = ctx.sessions["15min"];
  const start = bars.findIndex((b) => dayOf(b.t) === days[days.length - 2]);
  const ev = runLane(ctx, "L2", start, bars.length - 1).filter((e) => dayOf(e.t) === days[days.length - 1]).sort((a, b) => b.level.score - a.level.score)[0];
  if (!ev) { console.log(`${sym}: no L2 transition today`); continue; }
  const spot = Number((await c.quotes([sym]))[0].last);
  const exps = (await c.get("/markets/options/expirations", { symbol: sym })).expirations.date;
  const exp = exps.find((e) => { const d = yearsTo(e) * 365; return d >= 3 && d <= 7.99; });
  const chain = await c.chain(sym, exp);
  const type = ev.direction === "up" ? "call" : "put";
  const sameType = chain.filter((o) => o.option_type === type);
  const contract = sameType.reduce((b, o) => (Math.abs(o.strike - spot) < Math.abs(b.strike - spot) ? o : b));
  const T = yearsTo(exp);
  const atm = chain.filter((o) => o.strike === contract.strike).map((o) => impliedVol(o.option_type, spot, o.strike, T, mid(o)));
  const levels = levelsAt(ctx, "L2", ev.closeT, ev.spot);
  const opp = ev.direction === "up"
    ? levels.filter((l) => l.key !== ev.level.key && l.lo > ev.spot).sort((a, b) => a.lo - b.lo)[0]?.lo ?? null
    : levels.filter((l) => l.key !== ev.level.key && l.hi < ev.spot).sort((a, b) => b.hi - a.hi)[0]?.hi ?? null;
  const fit = fitScore({ contract, spot, opposing: opp, dailyAtr: atrOf(ctx, "daily", `${dayOf(ev.t)}T09:30:00`), hv20: hv(ctx.frames.daily.map((b) => b.close)), atmIv: atm.reduce((a, b) => a + b, 0) / atm.length });
  const stub = { ref_id: `SYNTHETIC-${contract.symbol}`, score: 50, option_type: type }; // typical live flow score (C/50)
  const a = scoreAlert({ lane: "L2", watchOnly: false, levelScore: ev.level.score, setup: ev.setup, direction: ev.direction, flow: stub, fit, tags: ev.tags, eventRisk: ev.level.eventRisk });
  const gate = a.delivery === "loud" ? loudGate(db, process.env, "L2", a.tier) : quietGate(process.env);
  console.log(JSON.stringify({ sym, event: { t: ev.t, level: ev.level.label, zone: [ev.level.lo.toFixed(2), ev.level.hi.toFixed(2)], levelScore: ev.level.score, transition: ev.transition, direction: ev.direction },
    spot, expiration: exp, fit: { score: fit.score, parts: fit.parts, labels: fit.labels, caps: fit.caps, contract: fit.contract },
    alert: a, gate: { open: gate.open, why: gate.why } }, null, 1));
}
