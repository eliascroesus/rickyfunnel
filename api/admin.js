/* Data for the /admin dashboard (admin.html). Everything except "login" needs the token that login gives.
   Set the password in Vercel → Project → Settings → Environment Variables: ADMIN_PASSWORD.
     POST ?a=login   { password }                → { token }   (valid 30 days; changing the password logs everyone out)
     GET  ?a=stats&from=YYYY-MM-DD&to=YYYY-MM-DD  → counters for the range, the range before it, links, feed, live
     GET  ?a=stats&all=1                          → the same for all time (by month)
     GET  ?a=live                                 → today's counters, live visitors and the feed (the 30-second refresh)
     POST ?a=link    { slug, name, channel, dest, note }  → save a short link
     POST ?a=unlink  { slug }                     → remove a short link (its numbers stay)
     POST ?a=reset   { confirm: "RESET" }         → delete all numbers (links stay), e.g. after testing */
const crypto = require("crypto");
const zlib = require("zlib");
const { PREFIX, key, redis, pipeline, hash, redisEnv, TZ, when, liveSlot, cleanSlug, readBody, send } = require("./_lib/store");

const CHANNELS = ["youtube", "instagram", "tiktok", "facebook", "x", "threads", "snapchat", "discord", "email", "sms", "google", "other"];
const DAY_MS = 864e5;
const LIVE_MS = 5 * 60e3;

const secret = () => process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || "";
const sign = exp => crypto.createHmac("sha256", secret()).update("rt-admin:" + exp).digest("base64url");
function makeToken() {
  const exp = Date.now() + 30 * DAY_MS;
  return exp + "." + sign(exp);
}
function validToken(req) {
  const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const [exp, sig] = t.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now()) || !secret()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function samePassword(given) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD || "").digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------- Dates ---------- */
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
function daysFrom(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
function addMonths(m, n) {
  const [y, mo] = m.split("-").map(Number), t = y * 12 + (mo - 1) + n;
  return Math.floor(t / 12) + "-" + String((t % 12) + 1).padStart(2, "0");
}
function monthsFrom(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

function numbers(flat) {
  const o = hash(flat);
  Object.keys(o).forEach(k => { o[k] = Number(o[k]) || 0; });
  return o;
}
function sumInto(total, part) {
  Object.entries(part).forEach(([k, v]) => { total[k] = (total[k] || 0) + v; });
  return total;
}
const parseList = list => (list || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
function parseLinks(flat) {
  const o = {};
  Object.entries(hash(flat)).forEach(([slug, json]) => { try { o[slug] = JSON.parse(json); } catch {} });
  return o;
}

// Visitors with an event in the last 5 minutes, per page (their latest page). Reads this 5-minute
// bucket and the one before it; old buckets delete themselves.
const liveCmds = () => [["HGETALL", key.live(liveSlot())], ["HGETALL", key.live(liveSlot() - 1)]];
function liveNow(cur, before) {
  const now = Date.now(), latest = {}, pages = {};
  [before, cur].forEach(flat => Object.entries(hash(flat)).forEach(([vid, v]) => {
    const [page, ts] = String(v).split("|");
    if (!latest[vid] || Number(ts) > latest[vid][1]) latest[vid] = [page, Number(ts)];
  }));
  Object.values(latest).forEach(([page, ts]) => { if (now - ts < LIVE_MS) pages[page] = (pages[page] || 0) + 1; });
  return { total: Object.values(pages).reduce((a, b) => a + b, 0), pages };
}

async function allMonths() {
  const months = new Set();
  let cursor = "0";
  do {
    const [next, keys] = await redis("SCAN", cursor, "MATCH", PREFIX + "m:*", "COUNT", 1000);
    keys.forEach(k => months.add(k.slice((PREFIX + "m:").length)));
    cursor = String(next);
  } while (cursor !== "0");
  return [...months].filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
}

async function stats(q) {
  const today = when().day;
  let gran, labels, prevLabels, from, to;
  if (q.all) {
    const months = await allMonths();
    gran = "month";
    labels = months.length ? monthsFrom(months[0], today.slice(0, 7)) : [today.slice(0, 7)];
    prevLabels = [];
    from = labels[0] + "-01";
    to = today;
  } else {
    from = isDay(q.from) ? q.from : addDays(today, -6);
    to = isDay(q.to) ? q.to : today;
    if (to < from) [from, to] = [to, from];
    if (dayDiff(from, to) > 1100) from = addDays(to, -1100);
    const n = dayDiff(from, to) + 1;
    if (n <= 120) {
      gran = "day";
      labels = daysFrom(from, to);
      prevLabels = daysFrom(addDays(from, -n), addDays(from, -1));
    } else {
      gran = "month";
      labels = monthsFrom(from.slice(0, 7), to.slice(0, 7));
      prevLabels = monthsFrom(addMonths(labels[0], -labels.length), addMonths(labels[0], -1));
    }
  }
  const k = gran === "day" ? key.day : key.month;
  const single = gran === "day" && labels.length === 1;
  const cmds = [
    ...labels.map(l => ["HGETALL", k(l)]),
    ...prevLabels.map(l => ["HGETALL", k(l)]),
    ["HGETALL", single ? key.hour(labels[0]) : PREFIX + "none"],
    ["HGETALL", key.links],
    ["HGETALL", key.vlen],
    ["LRANGE", key.feed, 0, 99],
    ...liveCmds(),
  ];
  const out = await pipeline(cmds);
  const data = {};
  labels.forEach((l, i) => { data[l] = numbers(out[i]); });
  const prev = {};
  prevLabels.forEach((l, i) => sumInto(prev, numbers(out[labels.length + i])));
  const [hours, links, vlen, feed, liveA, liveB] = out.slice(labels.length + prevLabels.length);
  return {
    tz: TZ, today, now: Date.now(), gran, from, to, labels, data,
    prev: prevLabels.length ? { from: prevLabels[0], to: prevLabels[prevLabels.length - 1], data: prev } : null,
    hours: single ? numbers(hours) : null,
    links: parseLinks(links), vlen: numbers(vlen), feed: parseList(feed), live: liveNow(liveA, liveB),
  };
}

async function live() {
  const t = when();
  const [day, hours, feed, liveA, liveB] = await pipeline([
    ["HGETALL", key.day(t.day)], ["HGETALL", key.hour(t.day)], ["LRANGE", key.feed, 0, 99], ...liveCmds(),
  ]);
  return { tz: TZ, today: t.day, now: Date.now(), day: numbers(day), hours: numbers(hours), feed: parseList(feed), live: liveNow(liveA, liveB) };
}

async function saveLink(body) {
  const slug = cleanSlug(body.slug);
  if (!slug) return [400, { error: "The link name can only use a–z, 0–9 and dashes (up to 40)." }];
  const name = String(body.name || "").trim().slice(0, 80) || slug;
  const channel = CHANNELS.includes(body.channel) ? body.channel : "other";
  let dest = String(body.dest || "/discord").trim().slice(0, 500);
  if (!/^\/[a-z0-9\-/]*(\?[^\s]*)?$/i.test(dest) && !/^https:\/\/[^\s]+$/i.test(dest)) {
    return [400, { error: "The destination must be a page on the site (like /discord) or a full https:// link." }];
  }
  const existing = await redis("HGET", key.links, slug);
  const before = existing ? JSON.parse(existing) : {};
  const link = { slug, name, channel, dest, note: String(body.note || "").trim().slice(0, 200), created: before.created || Date.now(), updated: Date.now() };
  await redis("HSET", key.links, slug, JSON.stringify(link));
  return [200, { ok: true, link, links: parseLinks(await redis("HGETALL", key.links)) }];
}

async function reset() {
  let cursor = "0", removed = 0;
  do {
    const [next, keys] = await redis("SCAN", cursor, "MATCH", PREFIX + "*", "COUNT", 500);
    const drop = keys.filter(k => k !== key.links && !k.startsWith(PREFIX + "login:"));
    for (let i = 0; i < drop.length; i += 200) {
      await redis("DEL", ...drop.slice(i, i + 200));
      removed += drop.slice(i, i + 200).length;
    }
    cursor = String(next);
  } while (cursor !== "0");
  return removed;
}

function sendJson(req, res, status, body) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex");
  if (json.length > 2048 && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    return res.end(zlib.gzipSync(json));
  }
  res.end(json);
}

module.exports = async (req, res) => {
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  const action = String(q.a || "");
  try {
    if (!process.env.ADMIN_PASSWORD) return sendJson(req, res, 503, { error: "no_password", db: !!redisEnv() });
    if (!redisEnv()) return sendJson(req, res, 503, { error: "no_db" });

    if (action === "login") {
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      const ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "?").split(",")[0].trim();
      const [tries] = await pipeline([["INCR", PREFIX + "login:" + ip], ["EXPIRE", PREFIX + "login:" + ip, 900]]);
      if (Number(tries) > 20) return sendJson(req, res, 429, { error: "Too many tries. Wait 15 minutes." });
      const body = await readBody(req);
      if (!samePassword(body.password)) return sendJson(req, res, 401, { error: "Wrong password." });
      await redis("DEL", PREFIX + "login:" + ip);
      return sendJson(req, res, 200, { token: makeToken(), tz: TZ });
    }

    if (!validToken(req)) return sendJson(req, res, 401, { error: "login" });

    if (action === "check") return sendJson(req, res, 200, { ok: true, tz: TZ, today: when().day });
    if (action === "stats") return sendJson(req, res, 200, await stats(q));
    if (action === "live") return sendJson(req, res, 200, await live());

    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    const body = await readBody(req);
    if (action === "link") {
      const [status, out] = await saveLink(body);
      return sendJson(req, res, status, out);
    }
    if (action === "unlink") {
      const slug = cleanSlug(body.slug);
      if (slug) await redis("HDEL", key.links, slug);
      return sendJson(req, res, 200, { ok: true, links: parseLinks(await redis("HGETALL", key.links)) });
    }
    if (action === "reset") {
      if (body.confirm !== "RESET") return sendJson(req, res, 400, { error: 'Type RESET to confirm.' });
      return sendJson(req, res, 200, { ok: true, removed: await reset() });
    }
    return sendJson(req, res, 404, { error: "Unknown action" });
  } catch (err) {
    console.error(err);
    return sendJson(req, res, 500, { error: String(err.message || err) });
  }
};
