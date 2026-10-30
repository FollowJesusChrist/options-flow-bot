// sr-levels-poller/discord-rest.js — minimal Discord REST client (no gateway).
// Only three calls: who am I, read channel messages, post a reply.
// Token comes from the constructor (the poller passes DISCORD_BOT_TOKEN from env).
// It is never logged: errors report method, route and status only.

const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://discord.com, 1.0) sr-levels-poller"; // no secrets, stable UA

export class DiscordRest {
  constructor({ token, fetchImpl = fetch } = {}) {
    if (!token) throw new Error("DiscordRest: no token (set DISCORD_BOT_TOKEN)");
    this.auth = `Bot ${token}`;
    this.fetch = fetchImpl;
  }

  async #req(method, route, { query, json, form } = {}, attempt = 0) {
    const url = new URL(API + route);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, String(v));
    const headers = { Authorization: this.auth, "User-Agent": UA };
    let body;
    if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await this.fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429 && attempt < 3) {
      const j = await res.json().catch(() => ({}));
      const wait = Math.min(30, Number(j.retry_after) || 2);
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
      return this.#req(method, route, { query, json, form }, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`Discord ${method} ${route} → ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  me() { return this.#req("GET", "/users/@me"); }

  // Newest-first from Discord; caller sorts. `after` = snowflake cursor.
  messages(channelId, { after, limit = 100 } = {}) {
    return this.#req("GET", `/channels/${channelId}/messages`, { query: { after, limit } });
  }

  // Reply to a message (message_reference). With a PNG: multipart with payload_json.
  // No pings: allowed_mentions parse [] and replied_user false.
  reply(channelId, messageId, { content, embed, png, filename }) {
    const payload = {
      content: content ?? undefined,
      embeds: embed ? [embed] : undefined,
      message_reference: { message_id: messageId, channel_id: channelId, fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
    };
    if (!png) return this.#req("POST", `/channels/${channelId}/messages`, { json: payload });
    payload.attachments = [{ id: 0, filename }];
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", new Blob([png], { type: "image/png" }), filename);
    return this.#req("POST", `/channels/${channelId}/messages`, { form });
  }
}
