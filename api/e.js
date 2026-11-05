/* Event collector for the funnel pages (assets/track.js posts here).
   A short name on purpose: ad blockers' lists block addresses with "track", "analytics" or "collect" in them.
   Body (JSON, sent as text so there's no extra pre-flight request):
     { v: visitor id, l: link key, r: "V1" | "V2" | "", p: page, e: [metric | [metric, n]], vl: { video: seconds } }
   Each metric adds n (default 1) to that day's counters for this link + A/B version. The page already
   makes sure each "once" metric (a funnel step, a video section) is sent once per visitor. */
const { countCommand, redis, redisEnv, visitorInfo, extrasFor, cleanLink, readBody, send } = require("./_lib/store");

const METRIC = /^(new|visit|pv:[a-z0-9]{1,16}|upv:[a-z0-9]{1,16}|s:[a-z0-9_]{1,24}|q:[a-z0-9]{1,6}:[a-z0-9_]{1,24}|v:[a-z0-9]{1,24}:(view|play|end|sec|b1?[0-9]))$/i;
const PAGE = /^[a-z0-9]{1,16}$/;
// Also counted per hour (the "Today" chart) …
const HOURLY = new Set(["new", "visit", "click", "s:optin", "s:applied", "s:not_qualified", "s:booked", "s:embed_optin", "v:vsl:play"]);
// … and split by country, device and app (the Audience section).
const EXTRAS = new Set(["new", "s:optin", "s:applied", "s:booked"]);
// Shown in the live activity list on /admin.
const FEED = new Set(["new", "s:optin", "s:applied", "s:not_qualified", "s:booked", "s:embed_optin"]);

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204);
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (!redisEnv()) return send(res, 204);   // no database yet: the pages work as before

  const body = await readBody(req);
  const who = visitorInfo(req);
  if (who.bot) return send(res, 204);

  const vid = String(body.v || "");
  if (!/^[a-z0-9]{8,32}$/i.test(vid)) return send(res, 400, { error: "bad visitor" });
  const link = cleanLink(body.l) || "~direct";
  const ver = body.r === "V1" || body.r === "V2" ? body.r : "";
  const page = PAGE.test(String(body.p || "")) ? String(body.p) : "";

  const metrics = [], feed = [], seen = new Set();
  (Array.isArray(body.e) ? body.e.slice(0, 60) : []).forEach(item => {
    const [m, raw] = Array.isArray(item) ? item : [item, 1];
    if (typeof m !== "string" || !METRIC.test(m) || seen.has(m)) return;
    const max = m.endsWith(":sec") ? 3600 : 1;   // seconds of video watched add up; everything else is +1
    const n = Math.min(max, Math.max(0, Math.round(Number(raw) || 0)));
    if (!n) return;
    seen.add(m);
    metrics.push([m, n, (HOURLY.has(m) ? "h" : "") + (EXTRAS.has(m) ? "x" : "")]);
    if (FEED.has(m)) feed.push({ t: Date.now(), m, l: link, r: ver, p: page, c: who.country, city: who.city, d: who.device, a: who.app });
  });

  const vlen = {};
  if (body.vl && typeof body.vl === "object") {
    Object.entries(body.vl).slice(0, 10).forEach(([name, s]) => {
      const sec = Math.round(Number(s));
      if (/^[a-z0-9]{1,24}$/i.test(name) && sec > 0 && sec < 36000) vlen[name] = sec;
    });
  }

  try {
    await redis(...countCommand({ link, ver, metrics, feed, vlen, live: page ? [vid, page] : null, extras: extrasFor(who) }));
  } catch (err) {
    console.error(err);
    return send(res, 502, { error: "not saved" });
  }
  send(res, 204);
};
