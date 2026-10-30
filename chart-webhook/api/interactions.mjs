// chart-webhook/api/interactions.mjs — Vercel route (/api/interactions). NOT deployed.
// Thin re-export of the shared fetch handler in ../worker.mjs.
import worker from "../worker.mjs";

export const POST = (request) => worker.fetch(request);
export const GET = (request) => worker.fetch(request); // → 405
