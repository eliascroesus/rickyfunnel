/* Tracked short links: rickyshoffner.com/<name> (vercel.json sends any one-part address that isn't a page here as
   ?slug=<name>&root=1). Links made earlier as /go/<name> or /ref/<name> keep working the same way.
   Counts the click, then sends the person on to the link's destination (the /discord opt-in unless the
   link says otherwise) with ?ref=<name> added, so every page after it knows which link they came from.
   Make and name links on /admin → Links. Through /go/ or /ref/, a name that was never set up still works and is
   counted, and shows on /admin as "not set up". Straight on the domain, only names made on /admin are counted:
   anything else (a typo, a bot trying addresses) just goes to /discord, so it can't fill /admin with junk.
   Link previews and bots are sent on without being counted. */
const { key, pipeline, redisEnv, countCommand, visitorInfo, cleanSlug, send } = require("./_lib/store");

const DEFAULT_DEST = "/discord";
const RESERVED = new Set(["discord", "apply", "apply-2", "booked", "booking", "not-qualified", "embed", "privacy", "terms", "disclaimer", "admin", "old", "redesign", "api", "assets", "go", "ref", "index", "favicon", "robots", "sitemap"]);

module.exports = async (req, res) => {
  const slug = cleanSlug(req.query && req.query.slug);
  const root = String(req.query && req.query.root) === "1";   // rickyshoffner.com/<name>
  const who = visitorInfo(req);
  const h = req.headers;
  // Browsers that load a link ahead of time (before it's tapped) say so; that's not a click.
  const prefetch = /prefetch|preview/i.test(String(h["sec-purpose"] || h["purpose"] || h["x-purpose"] || h["x-moz"] || ""));
  const count = slug && req.method === "GET" && !who.bot && !prefetch;
  const cookie = "rc_" + slug;
  const repeat = new RegExp("(^|;\\s*)" + cookie + "=").test(String(h.cookie || ""));

  let link = null, known = !root;
  const countCmd = () => countCommand({
    link: slug,
    metrics: [["click", 1, "h"], ...(repeat ? [] : [["uclick", 1, ""]])],
    feed: repeat ? [] : [{ t: Date.now(), m: "click", l: slug, c: who.country, city: who.city, d: who.device, a: who.app }],
  });
  if (slug && redisEnv() && !(root && RESERVED.has(slug))) {
    try {
      // /go/ and /ref/: look the link up and count the click in one go. On the bare domain, count only a link that exists.
      const cmds = [["HGET", key.links, slug]];
      if (count && !root) cmds.push(countCmd());
      const [def] = await pipeline(cmds);
      link = def ? JSON.parse(def) : null;
      if (root && link) {
        known = true;
        if (count) await pipeline([countCmd()]);
      }
    } catch (err) {
      console.error(err);   // never let a database hiccup break the link
      known = true;
    }
  } else if (!root || !redisEnv()) known = true;
  const counted = count && known;

  const host = String(h["x-forwarded-host"] || h.host || "");
  let dest = (link && link.dest) || DEFAULT_DEST;
  let url;
  try {
    url = new URL(dest, "https://" + (host || "localhost"));
  } catch {
    url = new URL(DEFAULT_DEST, "https://" + (host || "localhost"));
  }
  const sameSite = url.host === host || dest.startsWith("/");
  if (sameSite && slug && known) {
    // Pass along anything else on the link (e.g. ?utm_content=…), then mark which link it was.
    Object.entries(req.query || {}).forEach(([k, v]) => { if (k !== "slug" && k !== "root" && !url.searchParams.has(k)) url.searchParams.set(k, String(v)); });
    url.searchParams.set("ref", slug);
  }
  const location = sameSite ? url.pathname + url.search + url.hash : url.toString();

  const headers = { Location: location, "X-Robots-Tag": "noindex" };
  if (counted && !repeat) headers["Set-Cookie"] = `${cookie}=1; Max-Age=2592000; Path=/; SameSite=Lax; Secure; HttpOnly`;
  send(res, 302, undefined, headers);
};
