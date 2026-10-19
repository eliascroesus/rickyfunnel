/**
 * Lead capture for Ricky's funnel.
 *   - Page 1 opt-in        → adds a new row (name, email, phone, tracking).
 *   - Page 2 application   → fills that person's answers into their row (matched by email).
 *   - Calendly booking     → stamps "Call Booked At" on their row.
 *
 * Setup (once):
 *   1. Open the "Ricky - Master Lead Sheet" spreadsheet.
 *   2. Extensions → Apps Script. Delete what's there, paste this whole file, save.
 *   3. Pick "setup" in the function dropdown and click Run. Allow access when asked.
 *      This writes the column headers into row 1.
 *   4. Deploy → New deployment → type "Web app".
 *      Execute as: Me. Who has access: Anyone. Click Deploy.
 *   5. Copy the Web app URL (ends in /exec) and paste it into
 *      leadSheetUrl in the CONFIG block of index.html.
 *
 * Updating this script later: paste the new code, save, run "setup" once (adds any new
 * column headers), then Deploy → Manage deployments → pencil icon → Version: New version
 * → Deploy. The Web app URL stays the same.
 */

const SHEET_NAME = 'Sheet1';

// [column header, form field name]. Names starting with "@" are filled by this script.
// New columns only ever go on the end, so existing rows stay lined up.
const COLUMNS = [
  ['Submitted At', '@created'],
  ['Full Name', 'name'],
  ['Email', 'email'],
  ['Phone', 'phone'],
  ['Country', 'country'],
  ['Funnel', 'funnel'],
  ['Page URL', 'page_url'],
  ['UTM Source', 'utm_source'],
  ['UTM Medium', 'utm_medium'],
  ['UTM Campaign', 'utm_campaign'],
  ['UTM Content', 'utm_content'],
  ['UTM Term', 'utm_term'],
  ['Referrer', 'referrer'],
  ['Device', 'device'],
  ['Time Zone', 'timezone'],
  ['Instagram', 'instagram'],
  ['Experience', 'experience'],
  ['Main Problem', 'reason'],
  ['Investment', 'investment'],
  ['Application At', '@application'],
  ['Call Booked At', '@booked'],
];
const HEADERS = COLUMNS.map(([header]) => header);
const EMAIL_COL = COLUMNS.findIndex(([, field]) => field === 'email');

function setup() {
  ensureHeaders_(getSheet_());
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_();
    ensureHeaders_(sheet);
    const params = (e && e.parameter) || {};
    const type = params.type || 'optin';
    const now = new Date();

    if (type === 'optin') {
      sheet.appendRow(COLUMNS.map(([, field]) => (field === '@created' ? now : field[0] === '@' ? '' : clean_(params[field]))));
      return json_({ ok: true, row: sheet.getLastRow() });
    }

    // "application" or "booked": update the person's latest row, or add one if we never saw their opt-in.
    let rowNum = findRowByEmail_(sheet, params.email);
    // Existing text is re-protected so "+1 555…" or "@handle" isn't read back in as a formula.
    const row = rowNum
      ? sheet.getRange(rowNum, 1, 1, COLUMNS.length).getValues()[0].map(v => (typeof v === 'string' ? clean_(v) : v))
      : COLUMNS.map(([, field]) => (field === '@created' ? now : ''));
    if (!rowNum) rowNum = sheet.getLastRow() + 1;

    COLUMNS.forEach(([, field], i) => {
      if (field[0] === '@') return;
      const value = clean_(params[field]);
      if (value !== '') row[i] = value;   // never wipe what the opt-in already saved
    });
    if (type === 'application') row[COLUMNS.findIndex(([, f]) => f === '@application')] = now;
    if (type === 'booked') row[COLUMNS.findIndex(([, f]) => f === '@booked')] = now;

    sheet.getRange(rowNum, 1, 1, COLUMNS.length).setValues([row]);
    return json_({ ok: true, row: rowNum });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Open the Web app URL in a browser to check the deployment is live.
function doGet() {
  return ContentService.createTextOutput('Lead capture is running.');
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
}

// Writes the header row if it's missing or out of date (e.g. after new columns were added).
function ensureHeaders_(sheet) {
  if (sheet.getLastRow() > 0) {
    const current = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    if (current.join('|') === HEADERS.join('|')) return;
    if (current[0] !== HEADERS[0]) sheet.insertRowBefore(1);   // row 1 is data, not headers
  }
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const dataRows = Math.max(sheet.getMaxRows() - 1, 1);
  COLUMNS.forEach(([, field], i) => {
    if (field[0] === '@') sheet.getRange(2, i + 1, dataRows, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  });
}

// Latest row whose Email matches (case-insensitive), or 0.
function findRowByEmail_(sheet, email) {
  const wanted = String(email || '').trim().toLowerCase();
  const last = sheet.getLastRow();
  if (!wanted || last < 2) return 0;
  const emails = sheet.getRange(2, EMAIL_COL + 1, last - 1, 1).getValues();
  for (let i = emails.length - 1; i >= 0; i--) {
    if (String(emails[i][0]).trim().toLowerCase() === wanted) return i + 2;
  }
  return 0;
}

// Keep values as plain text: cap the length and stop "=", "+", "-" or "@" at the
// start from being read as a formula (phone numbers start with "+", handles with "@").
function clean_(value) {
  const text = value == null ? '' : String(value).trim().slice(0, 500);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
