/* Tracked short links: rickyshoffner.com/go/<name> (vercel.json sends /go/<name> here as ?slug=<name>).
   Counts the click, then sends the person on to the link's destination (the /discord opt-in unless the
   link says otherwise) with ?ref=<name> added, so every page after it knows which link they came from.
   Make and name links on /admin → Links. A name that was never set up still works and is counted, and
   shows on /admin as "not set up". Link previews and bots are sent on without being counted. */
const { key, pipeline, redisEnv, countCommand, visitorInfo, cleanSlug, send } = require("./_lib/store");

const DEFAULT_DEST = "/discord";

module.exports = async (req, res) => {
  const slug = cleanSlug(req.query && req.query.slug);
  const who = visitorInfo(req);
  const h = req.headers;
  // Browsers that load a link ahead of time (before it's tapped) say so; that's not a click.
  const prefetch = /prefetch|preview/i.test(String(h["sec-purpose"] || h["purpose"] || h["x-purpose"] || h["x-moz"] || ""));
  const count = slug && req.method === "GET" && !who.bot && !prefetch;
  const cookie = "rc_" + slug;
  const repeat = new RegExp("(^|;\\s*)" + cookie + "=").test(String(h.cookie || ""));

  let link = null;
  if (slug && redisEnv()) {
    try {
      const cmds = [["HGET", key.links, slug]];
      if (count) {
        cmds.push(countCommand({
          link: slug,
          metrics: [["click", 1, "h"], ...(repeat ? [] : [["uclick", 1, ""]])],
          feed: repeat ? [] : [{ t: Date.now(), m: "click", l: slug, c: who.country, city: who.city, d: who.device, a: who.app }],
        }));
      }
      const [def] = await pipeline(cmds);
      link = def ? JSON.parse(def) : null;
    } catch (err) {
      console.error(err);   // never let a database hiccup break the link
    }
  }

  const host = String(h["x-forwarded-host"] || h.host || "");
  let dest = (link && link.dest) || DEFAULT_DEST;
  let url;
  try {
    url = new URL(dest, "https://" + (host || "localhost"));
  } catch {
    url = new URL(DEFAULT_DEST, "https://" + (host || "localhost"));
  }
  const sameSite = url.host === host || dest.startsWith("/");
  if (sameSite && slug) {
    // Pass along anything else on the link (e.g. ?utm_content=…), then mark which link it was.
    Object.entries(req.query || {}).forEach(([k, v]) => { if (k !== "slug" && !url.searchParams.has(k)) url.searchParams.set(k, String(v)); });
    url.searchParams.set("ref", slug);
  }
  const location = sameSite ? url.pathname + url.search + url.hash : url.toString();

  const headers = { Location: location, "X-Robots-Tag": "noindex" };
  if (count && !repeat) headers["Set-Cookie"] = `${cookie}=1; Max-Age=2592000; Path=/; SameSite=Lax; Secure; HttpOnly`;
  send(res, 302, undefined, headers);
};
