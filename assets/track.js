/* Funnel analytics for the /admin dashboard. Plain script, loaded before the page's own.
   Counts, per visitor (no names, emails or cookies, just a random id in this browser):
     - page views, and which link brought them (a /go/<name> short link, ?utm_source=, the site they came
       from, or the app they're in), remembered for 30 days like the UTMs for the sheet
     - funnel steps (opt-in, application, booking…), each counted once per person
     - video watching: who pressed play (with sound) and which 5% slices of each video they watched
   and posts them in small batches to /api/e. Your own browser: open any page with ?rt=off once and it
   stops being counted (logging in to /admin does that too); ?rt=on counts it again; ?rt=debug logs
   what's sent in the browser console.
   Used by index.html and embed.html through window.rt:
     rt.start({ page, ver, link })   once per page load
     rt.set({ ver })                 the A/B version, once it's known
     rt.once("s:optin", { now })     a step, counted once per visitor (now: send straight away)
     rt.video(name)                  → { view(), time(seconds, percent, duration, audible), ended(audible) } */
(function () {
  "use strict";
  var ENDPOINT = "/api/e";
  var KEEP_DAYS = 30;
  var get = function (k) { try { return localStorage.getItem("rt_" + k); } catch (e) { return null; } };
  var put = function (k, v) { try { localStorage.setItem("rt_" + k, v); } catch (e) {} };
  var drop = function (k) { try { localStorage.removeItem("rt_" + k); } catch (e) {} };

  var qs = new URLSearchParams(location.search);
  if (qs.get("rt") === "off") put("ignore", "1");
  if (qs.get("rt") === "on") drop("ignore");
  var debug = qs.get("rt") === "debug";
  var ignored = get("ignore") === "1" || location.protocol === "file:";

  var vid = get("vid");
  if (!/^[a-z0-9]{8,32}$/.test(vid || "")) {
    vid = "";
    var bytes = new Uint8Array(12);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(bytes) : bytes.forEach(function (_, i) { bytes[i] = Math.random() * 256; });
    bytes.forEach(function (b) { vid += (b % 36).toString(36); });
    put("vid", vid);
  }
  var sent = {};
  try { sent = JSON.parse(get("sent") || "{}") || {}; } catch (e) {}

  /* ---------- Where they came from ---------- */
  var slug = function (s) { return String(s || "").toLowerCase().trim().replace(/[^a-z0-9._~\/+-]+/g, "-").replace(/^-+|-+$/g, ""); };
  var HOSTS = [
    [/(^|\.)(mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com|mail\.aol\.com)$/, "email"],
    [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
    [/(^|\.)instagram\.com$/, "instagram"],
    [/(^|\.)tiktok\.com$/, "tiktok"],
    [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, "facebook"],
    [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "x"],
    [/(^|\.)threads\.(net|com)$/, "threads"],
    [/(^|\.)snapchat\.com$/, "snapchat"],
    [/(^|\.)(discord\.com|discordapp\.com|discord\.gg)$/, "discord"],
    [/(^|\.)reddit\.com$/, "reddit"],
    [/(^|\.)(linkedin\.com|lnkd\.in)$/, "linkedin"],
    [/(^|\.)google\.[a-z.]+$/, "google"],
    [/(^|\.)(bing\.com|duckduckgo\.com|search\.yahoo\.com|search\.brave\.com)$/, "search"],
    [/(^|\.)(linktr\.ee|beacons\.ai|stan\.store|linkin\.bio|hoo\.be)$/, "linkinbio"]
  ];
  // Android apps open links with the app as the referrer: android-app://com.instagram.android/
  var APPS = {
    "com.google.android.youtube": "youtube", "com.instagram.android": "instagram", "com.zhiliaoapp.musically": "tiktok",
    "com.ss.android.ugc.trill": "tiktok", "com.facebook.katana": "facebook", "com.facebook.orca": "facebook",
    "com.twitter.android": "x", "com.google.android.gm": "email", "com.google.android.googlequicksearchbox": "google",
    "com.snapchat.android": "snapchat", "com.discord": "discord", "org.telegram.messenger": "telegram", "com.whatsapp": "whatsapp"
  };
  function fromReferrer() {
    var r = document.referrer;
    if (!r) return "";
    var m = /^android-app:\/\/([^/]+)/.exec(r);
    if (m) return APPS[m[1]] || "app:" + slug(m[1]).slice(0, 36);
    var host;
    try { host = new URL(r).hostname.toLowerCase(); } catch (e) { return ""; }
    if (!host || host === location.hostname) return "";
    for (var i = 0; i < HOSTS.length; i++) if (HOSTS[i][0].test(host)) return HOSTS[i][1];
    return "site:" + host.replace(/^www\./, "").slice(0, 40);
  }
  // In-app browsers often send no referrer, but say which app they are.
  function fromApp() {
    var ua = navigator.userAgent;
    if (/Instagram/.test(ua)) return "instagram";
    if (/musical_ly|BytedanceWebview|TikTok|trill_/i.test(ua)) return "tiktok";
    if (/FBAN|FBAV|FB_IAB|FBIOS/.test(ua)) return "facebook";
    if (/Snapchat/i.test(ua)) return "snapchat";
    if (/Twitter/i.test(ua)) return "x";
    return "";
  }
  // Last link that brought them wins (a short link, then UTMs, then the site they came from); a plain
  // visit keeps the one before, for 30 days. The app they're in is the last resort.
  function attribution() {
    var touch = "";
    if (slug(qs.get("ref"))) touch = slug(qs.get("ref")).slice(0, 40);
    else if (qs.get("utm_source")) touch = ("utm:" + slug(qs.get("utm_source")) + (qs.get("utm_campaign") ? "/" + slug(qs.get("utm_campaign")) : "")).slice(0, 60);
    else if (fromReferrer()) touch = "~" + fromReferrer();
    var saved = null;
    try { saved = JSON.parse(get("link") || "null"); } catch (e) {}
    if (touch) { put("link", JSON.stringify({ k: touch, at: Date.now() })); return touch; }
    if (saved && saved.k && Date.now() - saved.at < KEEP_DAYS * 864e5) return saved.k;
    var app = fromApp();
    return app ? "~" + app : "~direct";
  }

  /* ---------- Sending ---------- */
  var ctx = { page: "", ver: "", link: attribution() };
  var queue = {}, order = [], vlen = {}, pendingSec = {}, timer = null;

  function add(metric, n) {
    if (ignored) return;
    if (!(metric in queue)) order.push(metric);
    queue[metric] = (queue[metric] || 0) + (n || 1);
    schedule();
  }
  function schedule(now) {
    clearTimeout(timer);
    if (now) flush(); else timer = setTimeout(flush, 1200);
  }
  function flush() {
    clearTimeout(timer);
    Object.keys(pendingSec).forEach(function (name) {
      var s = Math.floor(pendingSec[name]);
      if (s >= 1) { pendingSec[name] -= s; if (!ignored) { if (!(("v:" + name + ":sec") in queue)) order.push("v:" + name + ":sec"); queue["v:" + name + ":sec"] = (queue["v:" + name + ":sec"] || 0) + s; } }
    });
    if (!order.length && !Object.keys(vlen).length) return;
    var body = { v: vid, l: ctx.link, r: ctx.ver, p: ctx.page, e: order.map(function (m) { return queue[m] === 1 ? m : [m, queue[m]]; }) };
    if (Object.keys(vlen).length) body.vl = vlen;
    queue = {}; order = []; vlen = {};
    if (ignored) return;
    var json = JSON.stringify(body);
    if (debug) console.log("[rt]", body);
    var ok = false;
    try { ok = navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([json], { type: "text/plain" })); } catch (e) {}
    if (!ok) { try { fetch(ENDPOINT, { method: "POST", body: json, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(function () {}); } catch (e) {} }
  }
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(); });

  // Counted once per visitor, ever (the key can differ from the metric, e.g. one "visit" per link).
  function once(metric, opts, dedupe) {
    var k = dedupe || metric;
    if (ignored || sent[k]) return false;
    sent[k] = 1;
    put("sent", JSON.stringify(sent));
    add(metric);
    if (opts && opts.now) schedule(true);
    return true;
  }

  function video(name) {
    var last = null;
    return {
      view: function () { once("v:" + name + ":view"); },
      // Called on every time update. Only steady playback with sound counts as watching, so skipping
      // ahead, or a muted video playing on its own, never fills in the sections in between.
      time: function (seconds, percent, duration, audible) {
        if (audible && last !== null && seconds > last && seconds - last < 3) {
          once("v:" + name + ":play");
          once("v:" + name + ":b" + Math.min(19, Math.max(0, Math.floor((percent || 0) * 20))));
          pendingSec[name] = (pendingSec[name] || 0) + (seconds - last);
          if (duration && !sent["len:" + name]) { sent["len:" + name] = 1; vlen[name] = Math.round(duration); }
          if (pendingSec[name] >= 30) schedule();
        }
        last = seconds;
      },
      ended: function (audible) { if (audible) once("v:" + name + ":end"); schedule(); }
    };
  }

  window.rt = {
    get link() { return ctx.link; },
    // For the lead sheet: "yt-bio", "utm:youtube/launch", "instagram" (no tracked link) or "direct".
    label: function () { return ctx.link.charAt(0) === "~" ? ctx.link.slice(1) : ctx.link; },
    start: function (o) {
      o = o || {};
      if (o.link) ctx.link = o.link;
      ctx.page = o.page || "";
      ctx.ver = o.ver || "";
      once("new");
      once("visit", null, "visit:" + ctx.link);
      add("pv:" + ctx.page);
      once("upv:" + ctx.page);
      schedule(true);
    },
    // Anything still waiting to be sent goes first, under the version it happened in.
    set: function (o) {
      if (!o || !("ver" in o) || (o.ver || "") === ctx.ver) return;
      flush();
      ctx.ver = o.ver || "";
    },
    once: once,
    hit: function (metric) { add(metric); },
    video: video,
    flush: flush
  };
})();
