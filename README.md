# Ricky funnel

YouTube Shorts dropshipping funnel. All pages live in one file, `index.html`; the URL picks the page:

1. **Opt-in** (`/`): headline, Discord sign-up form and Ricky's results.
2. **Application**, A/B tested. Each new opt-in is sent to one of two versions at random (50/50, set by
   `abSplitV1` in `CONFIG`) and keeps that version if they come back:
   - **V1** (`/apply`): main video, a short form beside Calendly.
   - **V2** (`/apply-2`): main video, then one question at a time (Typeform style; the questions are in
     `APPLY2_QUESTIONS`). Calendly loads in the background and appears after the last answer.
   - Add `?v=1` or `?v=2` to a link to see a specific version.
3. **Booked** (`/booked`): next-steps video, FAQ videos and more results.
4. **Not qualified** (`/not-qualified`): where applicants land instead of the calendar when their investment
   answer is in `CONFIG.disqualify` ("Under $500" on V1, "don't have the resources" on V2). Their answers still
   go to the sheet. Put the Discord invite in `CONFIG.discordUrl` to show a "Join The Free Discord" button.

`vercel.json` serves `index.html` at `/apply`, `/apply-2`, `/booked` and `/not-qualified`. Images and clips live in `assets/ricky/`.

## Hosting

It's a static site with no build step. On Vercel, import this repo with the default settings
(Framework: Other). Every push to `main` redeploys.

## Leads to Google Sheets

Every opt-in on page 1 is added as a row to the "Ricky - Master Lead Sheet" spreadsheet through
the Apps Script in `google-sheets/lead-capture.gs`. The page 2 answers (Instagram, experience, main
problem, investment) and the Calendly booking time are then filled into that person's row,
matched by email. The "Version" column shows which page 2 (V1 or V2) each lead got, so the two can be
compared. Setup steps are at the top of that file. The
Web app URL is set in `leadSheetUrl` in the `CONFIG` block near the end of `index.html`.

## Editing

Brand name, videos, call times and the sheet URL are all in the `CONFIG` block. To swap a video
placeholder for a real video, paste its embed link into `CONFIG.videos`.
