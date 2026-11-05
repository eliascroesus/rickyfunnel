/* Shared by the tracking functions (api/e.js, api/go.js, api/admin.js):
   - the Upstash Redis database, over its REST API (plain fetch, no packages to install)
   - dates in the business time zone (TRACK_TIMEZONE), so "today" on /admin matches Ricky's day
   - reading the visitor's device, app and bot-ness from the user agent
   Files in api/_lib are helpers, not pages: Vercel doesn't serve anything starting with "_". */

const PREFIX = "rt:";   // every key starts with this, so the database can be shared with other things

// Vercel → Storage → Upstash for Redis adds KV_REST_API_URL / KV_REST_API_TOKEN to the project;
// Upstash's own dashboard calls them UPSTASH_REDIS_REST_URL / _TOKEN. A custom prefix picked while
// connecting (e.g. FUNNEL_KV_REST_API_URL) is found too.
function redisEnv() {
  const env = process.env;
  const pairs = [["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"], ["KV_REST_API_URL", "KV_REST_API_TOKEN"]];
  Object.keys(env).forEach(k => {
    if (/(REST_API|REDIS_REST)_URL$/.test(k)) pairs.push([k, k.replace(/URL$/, "TOKEN")]);
  });
  for (const [u, t] of pairs) if (env[u] && env[t]) return { url: env[u].replace(/\/+$/, ""), token: env[t] };
  return null;
}

async function call(path, body) {
  const db = redisEnv();
  if (!db) throw Object.assign(new Error("No database connected"), { code: "no_db" });
  const r = await fetch(db.url + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + db.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const out = await r.json().catch(() => ({ error: "HTTP " + r.status }));
  if (out.error) throw new Error("Redis: " + out.error);
  return out;
}
// One command: redis("HGET", "rt:links", "yt-bio")
const redis = async (...cmd) => (await call("", cmd.map(String))).result;
// Several commands in one request: pipeline([["HGETALL", k1], ["HGETALL", k2]]) → [result1, result2]
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const out = await call("/pipeline", cmds.map(c => c.map(String)));
  return out.map(x => {
    if (x.error) throw new Error("Redis: " + x.error);
    return x.result;
  });
}
// HGETALL comes back as [field, value, field, value, …]
function hash(flat) {
  const o = {};
  for (let i = 0; flat && i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
}

const key = {
  day: d => PREFIX + "d:" + d,        // counters for one day     field: "link|version|metric"
  month: m => PREFIX + "m:" + m,      // the same, for a month (long date ranges)
  hour: d => PREFIX + "h:" + d,       // the same, per hour       field: "HH|link|version|metric"
  feed: PREFIX + "feed",              // latest notable events (newest first)
  live: slot => PREFIX + "live:" + slot,   // visitor → "page|time", per 5 minutes (deletes itself after 15)
  vlen: PREFIX + "vlen",              // video → length in seconds
  links: PREFIX + "links",            // short link → its settings (JSON)
};

/* ---------- Dates in the business time zone ---------- */
const TZ = (() => {
  const tz = process.env.TRACK_TIMEZONE || "America/New_York";
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return tz; } catch { return "UTC"; }
})();
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function when(ms = Date.now()) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}`, hour: p.hour === "24" ? "00" : p.hour };
}

/* ---------- Counting script ----------
   One round trip per event batch. Adds each metric to the day and month counters (and the hour
   counters when flagged "h"), adds the device/country/app breakdown when flagged "x", and keeps the
   live list and the activity feed. Counters only ever go up, so a lost request never corrupts anything.
   KEYS: day, month, hour, feed, live, vlen
   ARGV: field prefix, hour, live visitor, live value, extras ("x|c:US|;x|d:iphone|;…"),
         feed count, feed entries…, video-length count, (video, seconds)…, then (metric, n, flags)… */
const COUNT_SCRIPT = `
local day, month, hour, feed, live, vlen = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]
local prefix, hh = ARGV[1], ARGV[2]
if ARGV[3] ~= '' then
  redis.call('HSET', live, ARGV[3], ARGV[4])
  redis.call('EXPIRE', live, 900)
end
local extras = {}
for x in string.gmatch(ARGV[5], '[^;]+') do extras[#extras + 1] = x end
local i = 6
local nfeed = tonumber(ARGV[i]); i = i + 1
for k = 1, nfeed do redis.call('LPUSH', feed, ARGV[i]); i = i + 1 end
if nfeed > 0 then redis.call('LTRIM', feed, 0, 299) end
local nvid = tonumber(ARGV[i]); i = i + 1
for k = 1, nvid do redis.call('HSET', vlen, ARGV[i], ARGV[i + 1]); i = i + 2 end
while i + 2 <= #ARGV do
  local m, n, flags = ARGV[i], tonumber(ARGV[i + 1]), ARGV[i + 2]
  redis.call('HINCRBY', day, prefix .. m, n)
  redis.call('HINCRBY', month, prefix .. m, n)
  if string.find(flags, 'h', 1, true) then redis.call('HINCRBY', hour, hh .. '|' .. prefix .. m, n) end
  if string.find(flags, 'x', 1, true) then
    for _, x in ipairs(extras) do
      redis.call('HINCRBY', day, x .. m, n)
      redis.call('HINCRBY', month, x .. m, n)
    end
  end
  i = i + 3
end
return 1`;

const LIVE_SLOT_MS = 5 * 60e3;
const liveSlot = (ms = Date.now()) => Math.floor(ms / LIVE_SLOT_MS);

// metrics: [[name, n, flags]] · feed: [object] · vlen: {video: seconds} · live: [visitor, page] or null
function countCommand({ link, ver = "", metrics, feed = [], vlen = {}, live = null, extras = [], at = Date.now() }) {
  const t = when(at);
  const args = [link + "|" + ver + "|", t.hour, live ? live[0] : "", live ? live[1] + "|" + at : "", extras.join(";")];
  args.push(feed.length, ...feed.map(f => JSON.stringify(f)));
  const v = Object.entries(vlen);
  args.push(v.length, ...v.flat());
  metrics.forEach(([m, n, flags]) => args.push(m, n, flags || "-"));
  return ["EVAL", COUNT_SCRIPT, 6, key.day(t.day), key.month(t.month), key.hour(t.day), key.feed, key.live(liveSlot(at)), key.vlen, ...args];
}

/* ---------- Visitors ---------- */
// Link previews (Instagram/iMessage/WhatsApp/Discord…), search engines, uptime checks and scripts.
// Real people in Instagram/TikTok/Facebook's in-app browsers are NOT bots and are counted.
const BOT = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebot|embedly|preview|whatsapp|telegrambot|discordbot|slackbot|twitterbot|linkedinbot|skypeuri|pinterest|vkshare|w3c_|lighthouse|pagespeed|gtmetrix|headless|phantomjs|python|curl\/|wget|go-http|axios|node-fetch|undici|okhttp|java\/|libwww|httpclient|scrapy|ahrefs|semrush|mj12|dotbot|petalbot|bytespider|yandex|baidu|applebot|bingpreview|google-|googleother|feedfetcher|uptime|pingdom|statuscake|validator|bitlybot|iframely|quora link/i;
const isBot = ua => !ua || ua.length < 20 || BOT.test(ua);

// The app the link was opened in (in-app browsers say so in their user agent), else the browser.
function appOf(ua = "") {
  if (/Instagram/.test(ua)) return "instagram";
  if (/musical_ly|BytedanceWebview|TikTok|trill_|ByteLocale/i.test(ua)) return "tiktok";
  if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A|FBDV/.test(ua)) return "facebook";
  if (/Snapchat/i.test(ua)) return "snapchat";
  if (/Twitter/i.test(ua)) return "x";
  if (/YouTube|com\.google\.ios\.youtube/i.test(ua)) return "youtube";
  if (/LinkedInApp/i.test(ua)) return "linkedin";
  if (/\bGSA\//.test(ua)) return "google";
  if (/SamsungBrowser/.test(ua)) return "samsung";
  if (/EdgA?\/|EdgiOS|Edge\//.test(ua)) return "edge";
  if (/FxiOS|Firefox\//.test(ua)) return "firefox";
  if (/CriOS|Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}
function deviceOf(ua = "") {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/Android/.test(ua)) return "android";
  if (/Mobi/i.test(ua)) return "mobile";
  return "desktop";
}
function visitorInfo(req) {
  const h = req.headers, ua = String(h["user-agent"] || "");
  const country = String(h["x-vercel-ip-country"] || "").toUpperCase();
  let city = "";
  try { city = decodeURIComponent(String(h["x-vercel-ip-city"] || "")).slice(0, 40); } catch {}
  return { ua, bot: isBot(ua), app: appOf(ua), device: deviceOf(ua), country: /^[A-Z]{2}$/.test(country) ? country : "XX", city };
}
const extrasFor = v => ["x|c:" + v.country + "|", "x|d:" + v.device + "|", "x|b:" + v.app + "|"];

// Link keys: a short link's name ("yt-bio"), "utm:source/campaign", "~instagram" (no tracked link),
// "embed:SaaS". Never contains "|", which separates the parts of a counter's name.
function cleanLink(s) {
  const k = String(s || "").toLowerCase().trim().slice(0, 60);
  return /^[a-z0-9~][a-z0-9._~:\/+-]*$/.test(k) ? k : "";
}
const cleanSlug = s => {
  const k = String(s || "").toLowerCase().trim();
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(k) ? k : "";
};

async function readBody(req) {
  let b;
  try { b = req.body; } catch { b = undefined; }   // Vercel parses it already (and throws on bad JSON)
  if (b === undefined || b === null) {
    b = await new Promise(resolve => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(""));
    });
  }
  if (Buffer.isBuffer(b)) b = b.toString("utf8");
  if (typeof b === "string") {
    try { return JSON.parse(b || "{}"); } catch { return {}; }
  }
  return b && typeof b === "object" ? b : {};
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  if (body === undefined) return res.end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

module.exports = {
  PREFIX, key, redis, pipeline, hash, redisEnv, TZ, when, countCommand, liveSlot,
  isBot, appOf, deviceOf, visitorInfo, extrasFor, cleanLink, cleanSlug, readBody, send,
};
