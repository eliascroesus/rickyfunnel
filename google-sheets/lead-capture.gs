/**
 * Lead capture for Ricky's YouTube Shorts dropshipping funnel.
 *   - Page 1 opt-in        → adds a new row (name, email, phone, tracking, A/B version).
 *   - Page 2 application   → fills that person's answers into their row (matched by email).
 *                            V1 (/apply) fills Experience, Main Goal, Investment, Main Problem,
 *                            Ready To Fix, Instagram;
 *                            V2 (/apply-2) fills Situation, Biggest Goal, Obstacles, Instagram, Investment.
 *   - Calendly booking     → stamps "Call Booked At" on their row.
 *   - GoHighLevel (optional) → the same lead also goes to GoHighLevel; see the bottom of this file.
 *
 * Setup (once):
 *   1. Open the "Ricky - Master Lead Sheet" spreadsheet:
 *      https://docs.google.com/spreadsheets/d/16ACa5J4MNBxN3pr0cU4GiUe4iNlTlCqDVhJcg37h_Uk/edit
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
  ['Version', 'version'],
  ['Situation', 'situation'],
  ['Biggest Goal', 'goal'],
  ['Obstacles', 'obstacles'],
  ['Main Goal', 'motivation'],
  ['Ready To Fix', 'ready'],
];
const HEADERS = COLUMNS.map(([header]) => header);
const EMAIL_COL = COLUMNS.findIndex(([, field]) => field === 'email');

function setup() {
  ensureHeaders_(getSheet_());
}

function doPost(e) {
  const params = (e && e.parameter) || {};
  const type = params.type || 'optin';
  let result;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    result = saveToSheet_(type, params);
  } catch (err) {
    result = { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
  // GoHighLevel goes after the sheet is saved and unlocked, so it can never hold up or break the sheet.
  try {
    syncToGhl_(type, params);
  } catch (err) {
    console.error('GoHighLevel: ' + err);
  }
  return json_(result);
}

function saveToSheet_(type, params) {
  const sheet = getSheet_();
  ensureHeaders_(sheet);
  const now = new Date();

  if (type === 'optin') {
    sheet.appendRow(COLUMNS.map(([, field]) => (field === '@created' ? now : field[0] === '@' ? '' : clean_(params[field]))));
    return { ok: true, row: sheet.getLastRow() };
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
  return { ok: true, row: rowNum };
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

/* ---------- GoHighLevel (optional) ----------
 * Every lead also goes to GoHighLevel through its API, which is free (the Inbound Webhook trigger is a
 * paid premium trigger). It stays off until both Script properties are set
 * (Project Settings, the gear icon → Script properties):
 *   GHL_TOKEN        the sub-account's Private Integration token
 *   GHL_LOCATION_ID  the sub-account's Location ID
 * Then pick "checkGhl" in the function dropdown and Run it: the log shows what it found and what's missing.
 *
 * On every event it creates or updates the contact (GHL matches by email/phone): name, email, phone,
 * country, and any contact custom field whose name matches a sheet column header ("Instagram",
 * "Investment", "Main Problem"…). On the funnel steps in GHL_STEPS it also adds that step's tag and puts
 * their opportunity in that stage of the GHL_PIPELINE pipeline. Opportunities only move forward: a stage
 * you add yourself (e.g. "Showed" or "Won") counts as further along than all of these.
 */
const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_PIPELINE = 'Ricky Mentorship';   // must match the pipeline's name in GHL
// Funnel step → pipeline stage name (must match GHL, capitals aside), tag, and how far along it is.
const GHL_STEPS = {
  optin:         { stage: 'Opted In',      tag: 'ricky-optin',         rank: 1 },
  not_qualified: { stage: 'Not Qualified', tag: 'ricky-not-qualified', rank: 2 },
  applied:       { stage: 'Applied',       tag: 'ricky-applied',       rank: 2 },
  booked:        { stage: 'Call Booked',   tag: 'ricky-booked',        rank: 3 },
};
// Sheet fields that go into GHL's own contact fields rather than custom fields.
const GHL_STANDARD = ['name', 'email', 'phone', 'country'];

function syncToGhl_(type, params) {
  const ghl = ghlConfig_();
  if (!ghl || !params.email) return;
  // The page marks a finished application with "stage"; an answer on its own only updates fields.
  const step = type === 'optin' || type === 'booked' ? type : GHL_STEPS[params.stage] ? params.stage : '';
  const setup = ghlSetup_(ghl);
  const contactId = ghlUpsertContact_(ghl, setup, params);
  if (!step) return;
  ghl_(ghl, 'post', '/contacts/' + contactId + '/tags', { tags: [GHL_STEPS[step].tag] });
  ghlMoveOpportunity_(ghl, setup, contactId, params, step);
}

// Run this from the editor after adding the Script properties: checks the connection and lists what it matched.
function checkGhl() {
  const ghl = ghlConfig_();
  if (!ghl) return console.log('Add GHL_TOKEN and GHL_LOCATION_ID under Project Settings → Script properties first.');
  const setup = ghlSetup_(ghl, true);
  console.log(setup.errors.length ? 'Problems above. A 401 means a wrong token or Location ID; a 403 means the token is missing a scope.' : 'Connected.');
  console.log('Pipeline "' + GHL_PIPELINE + '": ' + (setup.pipelineId ? 'found' : 'NOT FOUND (create it under Opportunities → Pipelines)'));
  Object.keys(GHL_STEPS).forEach(step => {
    const name = GHL_STEPS[step].stage;
    console.log('  stage "' + name + '": ' + (setup.stages.some(s => norm_(s.name) === norm_(name)) ? 'found' : 'MISSING'));
  });
  const filled = [], skipped = [];
  COLUMNS.forEach(([header, field]) => {
    if (field[0] === '@' || GHL_STANDARD.indexOf(field) >= 0) return;
    (setup.fields[norm_(header)] ? filled : skipped).push(header);
  });
  console.log('Custom fields that will be filled: ' + (filled.join(', ') || 'none yet'));
  console.log('Sheet columns with no matching custom field (skipped): ' + (skipped.join(', ') || 'none'));
}

function ghlConfig_() {
  const props = PropertiesService.getScriptProperties();
  const token = String(props.getProperty('GHL_TOKEN') || '').trim();
  const locationId = String(props.getProperty('GHL_LOCATION_ID') || '').trim();
  return token && locationId ? { token: token, locationId: locationId } : null;
}

// One API call. Throws with GHL's own error message, which shows under Executions.
function ghl_(ghl, method, path, body) {
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ghl.token, Version: '2021-07-28', Accept: 'application/json' },
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  const res = UrlFetchApp.fetch(GHL_API + path, options);
  const code = res.getResponseCode(), text = res.getContentText();
  if (code >= 300) throw new Error(method.toUpperCase() + ' ' + path.split('?')[0] + ' → ' + code + ' ' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

// The pipeline and its stages, and the contact custom fields by name. Cached for 10 minutes.
// Each lookup can fail on its own (e.g. a missing token scope) without stopping the contact itself.
function ghlSetup_(ghl, fresh) {
  const cache = CacheService.getScriptCache(), cacheKey = 'ghl-setup-' + ghl.locationId;
  const cached = !fresh && cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const loc = encodeURIComponent(ghl.locationId), errors = [];
  const get = path => {
    try { return ghl_(ghl, 'get', path); } catch (err) { errors.push(String(err)); return {}; }
  };
  const pipeline = (get('/opportunities/pipelines?locationId=' + loc).pipelines || [])
    .find(p => norm_(p.name) === norm_(GHL_PIPELINE));
  const fields = {};
  (get('/locations/' + loc + '/customFields?model=contact').customFields || [])
    .forEach(f => { fields[norm_(f.name)] = f.id; });
  const setup = {
    pipelineId: pipeline ? pipeline.id : '',
    stages: pipeline ? (pipeline.stages || []).map(s => ({ id: s.id, name: s.name })) : [],
    fields: fields,
    errors: errors,
  };
  if (errors.length) errors.forEach(e => console.error('GoHighLevel: ' + e));
  else cache.put(cacheKey, JSON.stringify(setup), 600);
  return setup;
}

function ghlUpsertContact_(ghl, setup, params) {
  const body = { locationId: ghl.locationId, email: String(params.email).trim() };
  const [firstName, ...rest] = String(params.name || '').trim().split(/\s+/);
  if (firstName) body.firstName = firstName;
  if (rest.length) body.lastName = rest.join(' ');
  const phone = e164_(params.phone);
  if (phone) body.phone = phone;
  if (/^[A-Z]{2}$/.test(params.country || '')) body.country = params.country;
  if (params.version) body.source = 'Ricky funnel ' + params.version;
  const customFields = [];
  COLUMNS.forEach(([header, field]) => {
    const id = setup.fields[norm_(header)], value = String(params[field] || '').trim();
    if (id && value && field[0] !== '@' && GHL_STANDARD.indexOf(field) < 0) customFields.push({ id: id, field_value: value });
  });
  if (customFields.length) body.customFields = customFields;
  return ghl_(ghl, 'post', '/contacts/upsert', body).contact.id;
}

// Creates their opportunity in the pipeline, or moves it to this step's stage if that's further along.
function ghlMoveOpportunity_(ghl, setup, contactId, params, step) {
  const target = GHL_STEPS[step];
  const stage = setup.stages.find(s => norm_(s.name) === norm_(target.stage));
  if (!setup.pipelineId || !stage) return console.warn('GoHighLevel: no "' + target.stage + '" stage in the "' + GHL_PIPELINE + '" pipeline');
  const found = ghl_(ghl, 'get', '/opportunities/search?location_id=' + encodeURIComponent(ghl.locationId)
    + '&pipeline_id=' + encodeURIComponent(setup.pipelineId) + '&contact_id=' + encodeURIComponent(contactId)).opportunities || [];
  const current = found.find(o => o.contactId === contactId || (o.contact && o.contact.id === contactId));
  if (!current) {
    ghl_(ghl, 'post', '/opportunities/', {
      locationId: ghl.locationId, pipelineId: setup.pipelineId, pipelineStageId: stage.id,
      contactId: contactId, name: String(params.name || params.email).trim(), status: 'open',
    });
    return;
  }
  if (current.pipelineStageId === stage.id) return;
  const currentStage = setup.stages.find(s => s.id === current.pipelineStageId);
  const currentStep = currentStage && Object.keys(GHL_STEPS).find(k => norm_(GHL_STEPS[k].stage) === norm_(currentStage.name));
  if (target.rank >= (currentStep ? GHL_STEPS[currentStep].rank : 99)) {
    ghl_(ghl, 'put', '/opportunities/' + current.id, { pipelineId: setup.pipelineId, pipelineStageId: stage.id });
  }
}

// "+1 5551234567" → "+15551234567". If they typed their own "+44…" in the number box, that one wins.
// With no "+" at all, the digits go as they are.
function e164_(phone) {
  const text = String(phone || '');
  const plus = text.lastIndexOf('+');
  const digits = (plus < 0 ? text : text.slice(plus)).replace(/\D/g, '');
  if (digits.length < 7) return '';
  return plus < 0 ? digits : '+' + digits;
}

function norm_(text) {
  return String(text || '').trim().toLowerCase();
}
