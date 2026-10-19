# Ricky funnel

YouTube Shorts dropshipping funnel in one page, `index.html`:

1. **Opt-in** (`/`): headline, Discord sign-up form and Ricky's results.
2. **Application** (`/#apply`): main video and the strategy call form with a booking calendar.
3. **Booked** (`/#booked`): next-steps video, FAQ videos and more results.

Images and clips live in `assets/ricky/`.

## Hosting

It's a static site with no build step. On Vercel, import this repo with the default settings
(Framework: Other). Every push to `main` redeploys.

## Leads to Google Sheets

Every opt-in on page 1 is added as a row to the "Ricky - Master Lead Sheet" spreadsheet through
the Apps Script in `google-sheets/lead-capture.gs`. The page 2 answers (Instagram, experience, main
problem, investment) and the Calendly booking time are then filled into that person's row,
matched by email. Setup steps are at the top of that file. The
Web app URL is set in `leadSheetUrl` in the `CONFIG` block near the end of `index.html`.

## Editing

Brand name, videos, call times and the sheet URL are all in the `CONFIG` block. To swap a video
placeholder for a real video, paste its embed link into `CONFIG.videos`.
