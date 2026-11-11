# Ricky funnel

YouTube Shorts dropshipping funnel. Each page is a folder with an `index.html`; they share
`assets/site/style.css` and `assets/site/funnel.js` (settings, questions and results at the top of funnel.js):

1. **Opt-in** (`/discord`; the bare domain redirects there): headline, Discord sign-up form and Ricky's results.
2. **Application**, A/B tested. Each new opt-in is sent to one of two versions at random (50/50, set by
   `abSplitApply` in `CONFIG`) and keeps that version if they come back:
   - **V1** (`/apply`): main video, a short form beside the GoHighLevel calendar (locked until it's filled in).
   - **V2** (`/apply-2`): main video, then one question at a time, then the calendar.
   - Add `?v=1` or `?v=2` to a link to see a specific version (`?v=reset` forgets it).
   - Answers in `CONFIG.disqualify` show a "you don't qualify" box with the free Discord and YouTube instead of
     the calendar. Their answers still go to the sheet.
3. **Booked** (`/booked`): next-steps video, the three steps to confirm the call, FAQ videos and results.

The previous design of these pages is kept, unlinked and out of search results, at `/old/discord`, `/old/apply`,
`/old/apply-2`, `/old/booked` and `/old/not-qualified` (all one file, `old/index.html`). Its leads are marked
"Old V1" / "Old V2" in the sheet and it isn't counted on /admin. Images and clips live in `assets/ricky/`.
It also serves the analytics dashboard at `/admin` and the tracked short links at `/ref/<name>` (see below; links made earlier as `/go/<name>` still work).

## Hosting

It's a static site with no build step. On Vercel, import this repo with the default settings
(Framework: Other). Every push to `main` redeploys.

## Leads to Google Sheets

Every opt-in on page 1 (/discord; the bare domain redirects there) is added as a row to the "Ricky - Master Lead Sheet" spreadsheet through
the Apps Script in `google-sheets/lead-capture.gs`. The page 2 answers (experience, goal, investment,
main problem, ready to fix, Instagram on V1; situation, goal, obstacles, Instagram, investment on V2) and the Calendly booking time are then filled into that person's row,
matched by email. The "Version" column shows which page 2 (V1 or V2) each lead got, so the two can be
compared. Setup steps are at the top of that file. The
Web app URL is set in `leadSheetUrl` in the `CONFIG` block near the end of `index.html`.

## Leads to GoHighLevel

The same Apps Script also sends every lead to GoHighLevel through its API (free, unlike the premium
Inbound Webhook trigger). It's off until the script has two Script properties, `GHL_TOKEN` (a sub-account
Private Integration token) and `GHL_LOCATION_ID`; run `checkGhl` in the script editor to see what it found.

- Every event creates or updates the contact (name, email, phone, country) and fills any contact custom
  field whose name matches a sheet column header, e.g. "Instagram", "Investment", "Main Problem".
- Opportunity custom fields with the same names are filled too. Lead cards in a pipeline can only show
  opportunity fields, so create the ones you want on cards (e.g. Instagram, Investment, Situation) as Opportunity fields.
- These funnel steps also add a tag and put the lead's opportunity in a pipeline. It's one opportunity per
  lead: opt-ins land in **Discord** (first stage) for the setters, and booking a call moves that same
  opportunity into **1:1 Mentorship** (first stage). It only ever moves forward, so stages a setter or closer
  moved someone to by hand are never undone.

| Funnel step | Pipeline / stage | Tag |
| --- | --- | --- |
| Opt-in on page 1 | Discord / first stage | `ricky-optin` |
| Finished an application (`/apply` or `/apply-2`) | Discord / Applied, plus a note with every answer | `ricky-applied` |
| "Don't qualify" investment answer | Discord / Not Qualified, plus a note with every answer | `ricky-not-qualified` |
| Calendly booking | 1:1 Mentorship / first stage | `ricky-booked` |

The page marks a finished application with a `stage` field; single answers only update the contact's fields.
Pipeline names, stages and tags live in `GHL_PIPELINES` and `GHL_STEPS` in `lead-capture.gs`; a step can be
sent to a named stage instead of the first one.

## Analytics dashboard (/admin)

`/admin` shows, for any date range, traffic source and A/B version:

- **Link clicks** on your tracked short links, per place you posted them (YouTube bio, IG story, TikTok bio…),
  and how many of those clicks turned into visitors, opt-ins, applications and booked calls.
- **The funnel step by step**: visited → started the opt-in form → opted in → reached page 2 → played the VSL →
  started the application → finished it → qualified → booked. Each person is counted once per step, and the
  biggest drop-off is pointed out.
- **Videos**: who saw each video, who pressed play with sound, and a drop-off curve showing what share are
  still watching at every 5% of the video (with the exact minute:second), the average watched, halfway and
  to-the-end rates.
- **A/B test**: V1 (`/apply`) against V2 (`/apply-2`) at every step, with a plain-English verdict on whether
  the difference in booked calls is real yet (95% confidence) or still luck.
- **Application questions**: how many people answered each question on both versions.
- **Pages & buttons**, **audience** (iPhone/Android/computer, Instagram/TikTok in-app browser vs Safari,
  country), **over time** charts (by hour for a single day), and a **live** list of new visitors, opt-ins and
  bookings, refreshed every 30 seconds.

### Setup (once, about 5 minutes on Vercel)

1. **Database**: Vercel → this project → **Storage** → **Create Database** → **Upstash for Redis** (free plan) →
   connect it to this project for all environments. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. **Password**: **Settings → Environment Variables** → add `ADMIN_PASSWORD` (whatever you want to log in with).
   Optional: `TRACK_TIMEZONE` (default `America/New_York`) sets which time zone "today" uses.
3. **Redeploy** (Deployments → ⋯ → Redeploy), then open `https://rickyshoffner.com/admin`.

Until the database is connected, the pages work exactly as before and simply don't count anything.

### Tracked links

Make one link per place you post, in **/admin → Tracked links** (there are one-click presets for YouTube bio,
video description, pinned comment, Instagram bio/story/DMs, TikTok bio…). Each looks like
`https://rickyshoffner.com/ref/ig-story`: it counts the tap, then sends the person straight on to the opt-in
page (or `/apply`, `/apply-2`, or any other link you choose) with `?ref=ig-story` added, so every page after it
knows where they came from. You can change where a link goes later without changing the link.

- Bots and link previews (Instagram/iMessage/WhatsApp/Discord previews, crawlers) aren't counted.
- "Clicks" vs "Visitors": the gap is people who tapped but left before the page loaded (common in in-app browsers).
- Links without a tracked link still show up, worked out from the site or app they came from ("Instagram (no
  tracked link)", "Google", "Direct / unknown"), and `?utm_source=` links work too.
- A visitor keeps the last link that brought them for 30 days, so a booking two days later still counts for it.
- The link also goes to the Google Sheet in a new **Source Link** column (and to a GoHighLevel field named
  "Source Link" if you make one). To get the column: paste the updated `google-sheets/lead-capture.gs`, run
  `setup`, then Deploy → Manage deployments → New version.

### Your own visits

Testing the funnel from your own browser adds to the numbers. In **/admin → Settings**, tick "Don't count my
visits on this browser"; on your phone, open any funnel page with `?rt=off` at the end once (`?rt=on` undoes it).
**Settings → Delete all numbers** starts the counts from zero (e.g. after testing); tracked links stay.

### How it works

- `assets/track.js` (loaded by `index.html` and `embed.html`) gives each browser a random id (no names, emails
  or cookies), and sends small batches of events to `/api/e`: page views, funnel steps (each once per person),
  and which 5% parts of each video were watched with sound. The VSL autoplays muted, so only watching after
  "Click to listen" (or play) counts; skipping ahead doesn't count the part skipped.
- `api/go.js` handles `/ref/<name>` (and the older `/go/<name>`); `api/admin.js` serves the dashboard's data behind `ADMIN_PASSWORD`;
  `api/_lib/store.js` holds the shared database code (Upstash's REST API, no packages to install).
- Counts are stored per day, link and A/B version (plus per month for long ranges), so the dashboard stays fast
  for any date range. Upstash's free plan (256 MB, 500K commands a month) covers a lot of traffic; each event batch
  is one request. If you outgrow it, pay-as-you-go is about $0.20 per 100K commands.

## Editing

Brand name, videos, call times and the sheet URL are all in the `CONFIG` block. To swap a video
placeholder for a real video, paste its embed link into `CONFIG.videos`.

Vimeo videos play with Vimeo's own controls switched off (no title, name, picture, logo or share
buttons). The page draws its own play button, progress bar, sound and full-screen buttons on top, using
Vimeo's player library in `assets/vimeo-player.min.js`. Videos listed in `AUTOPLAY_VIDEOS` (the VSL)
start on their own, muted, with a "Click to listen" box that restarts them with sound.
