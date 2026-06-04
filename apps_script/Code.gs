/**
 * Lead Outreach — Google Sheets edition.
 *
 * Same pipeline as the Python CLI, but driven from a Google Sheet so a
 * non-technical user can run it: Enrich (Apollo) -> Generate (Claude) ->
 * create Gmail drafts. Every step is idempotent (skips rows already done) and
 * time-guarded (Apps Script caps runs at 6 min — just re-run to continue).
 *
 * Tabs:
 *   Leads     your list (any of the recognized header names below)
 *   Config    key/value settings (product, sender, signature, model)
 *   Segments  one outreach angle per segment value
 *
 * API keys (Apollo, Anthropic) live in Script Properties — set once via
 * "Outreach > Set API keys", never in the sheet.
 */

// ---- Constants --------------------------------------------------------------

var LEADS_SHEET = 'Leads';
var CONFIG_SHEET = 'Config';
var SEGMENTS_SHEET = 'Segments';

var APOLLO_URL = 'https://api.apollo.io/api/v1/people/bulk_match';
var APOLLO_PEOPLE_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';
var APOLLO_ORG_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';

var BATCH_SIZE = 10;                 // Apollo bulk_match max per call
var FIND_PER_COMPANY = 3;            // how many people to pull per company+title
var TIME_LIMIT_MS = 5 * 60 * 1000;   // stop before the 6-min Apps Script cap

var OUTPUT_COLUMNS = [
  'Email', 'Enriched Title', 'Enriched LinkedIn', 'Status',
  'Subject', 'Body', 'Draft'
];

var COLUMN_ALIASES = {
  name: ['name', 'full name', 'full_name', 'contact', 'contact name'],
  company: ['company', 'organization', 'organisation', 'employer', 'account'],
  role: ['role', 'job title', 'position', 'job title/position', 'title/position', 'title'],
  category: ['category', 'segment', 'type', 'list', 'group'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin_url', 'li', 'profile']
};

// ---- Menu -------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Outreach')
    .addItem('Set up workspace', 'setupWorkspace')
    .addItem('Set API keys…', 'setApiKeys')
    .addSeparator()
    .addItem('1. Find people (Apollo search)', 'findPeople')
    .addItem('2. Enrich emails (Apollo)', 'enrichLeads')
    .addItem('3. Generate emails', 'generateEmails')
    .addItem('4. Create Gmail drafts', 'createDrafts')
    .addSeparator()
    .addItem('Run all (1 → 2 → 3 → 4)', 'runAll')
    .addToUi();
}

function runAll() {
  findPeople();
  enrichLeads();
  generateEmails();
  createDrafts();
}

// ---- Setup ------------------------------------------------------------------

function setupWorkspace() {
  var book = ss_();

  if (!book.getSheetByName(CONFIG_SHEET)) {
    var cfg = book.insertSheet(CONFIG_SHEET);
    var rows = [
      ['Setting', 'Value'],
      ['Product', ''],
      ['Sender Name', ''],
      ['Sender Email', ''],
      ['Booking Link', ''],
      ['Signature', ''],
      ['Default Angle', ''],
      ['Model', 'claude-sonnet-4-6'],
      ['Tone', 'warm, concise, professional, not salesy'],
      ['Word Limit', 120],
      ['Max Tokens', 1024]
    ];
    cfg.getRange(1, 1, rows.length, 2).setValues(rows);
    cfg.getRange(1, 1, 1, 2).setFontWeight('bold');
    cfg.setColumnWidth(2, 520);
  }

  if (!book.getSheetByName(SEGMENTS_SHEET)) {
    var seg = book.insertSheet(SEGMENTS_SHEET);
    seg.getRange(1, 1, 1, 2).setValues([['Segment', 'Angle']]).setFontWeight('bold');
    var cats = distinctCategories_();
    if (cats.length) seg.getRange(2, 1, cats.length, 1).setValues(cats.map(function (c) { return [c]; }));
    seg.setColumnWidth(2, 520);
  }

  ensureOutputColumns_(getLeadsSheet_());
  toast_('Workspace ready. Fill in the Config and Segments tabs, then "Set API keys".');
}

function setApiKeys() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('Apollo API key', 'Paste your Apollo API key:', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() === ui.Button.OK && a.getResponseText().trim()) {
    props_().setProperty('APOLLO_API_KEY', a.getResponseText().trim());
  }
  var b = ui.prompt('Anthropic API key', 'Paste your Anthropic API key:', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() === ui.Button.OK && b.getResponseText().trim()) {
    props_().setProperty('ANTHROPIC_API_KEY', b.getResponseText().trim());
  }
  toast_('API keys saved.');
}

// ---- Stage 0: Find people ---------------------------------------------------

/**
 * For rows that have a company + target role but no person name, search Apollo
 * for the top matching people and append them as new rows (one per person).
 * Search is credit-free and returns name + LinkedIn + title but a masked email
 * — the Enrich step reveals the real email afterward. Rows that already have a
 * name are left untouched.
 */
function findPeople() {
  var sheet = getLeadsSheet_();
  var cols = detectColumns_(sheet);
  var out = ensureOutputColumns_(sheet);
  if (!cols.company || !cols.role) {
    toast_('Find people needs a Company column and a Job Title / Role column.');
    return;
  }

  var key = getApiKey_('APOLLO_API_KEY');
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  var orgCache = {};
  var newRows = [];
  var start = Date.now();

  for (var r = 2; r <= lastRow; r++) {
    if (timeUp_(start)) { break; }
    if (cellStr_(sheet, r, cols.name)) continue;                 // already has a person
    if (cellStr_(sheet, r, out.Status).indexOf('expanded') === 0) continue;  // already searched
    var company = cellStr_(sheet, r, cols.company);
    var title = cellStr_(sheet, r, cols.role);
    if (!company || !title) continue;

    var org = resolveOrg_(company, key, orgCache);
    var people = searchPeople_(org, title, key);
    var srcRow = sheet.getRange(r, 1, 1, lastCol).getValues()[0];
    people.forEach(function (p) {
      var row = srcRow.slice();
      row[cols.name - 1] = p.name;
      row[out['Enriched Title'] - 1] = p.title || title;
      row[out['Enriched LinkedIn'] - 1] = p.linkedin_url || '';
      row[out.Email - 1] = '';        // let Enrich reveal it
      row[out.Subject - 1] = '';
      row[out.Body - 1] = '';
      row[out.Draft - 1] = '';
      row[out.Status - 1] = 'found';
      newRows.push(row);
    });
    sheet.getRange(r, out.Status).setValue('expanded (' + people.length + ')');
    SpreadsheetApp.flush();
  }

  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, lastCol).setValues(newRows);
  }
  toast_('Found ' + newRows.length + ' people. Next: Enrich emails.');
}

/** Build a clear error, flagging the master-key requirement on 401/403. */
function apolloError_(action, code, body) {
  var hint = (code === 401 || code === 403)
    ? " Apollo's People/Company Search API requires a MASTER API key — generate one in" +
      " Apollo (Settings > Integrations > API, create a key with master access) and re-run" +
      ' "Set API keys".'
    : '';
  return new Error('Apollo ' + action + ' failed (' + code + ').' + hint + ' ' + String(body).slice(0, 200));
}

/**
 * Resolve a company name to an Apollo org {id, domain}; cached per run.
 * Returns null only on a genuine no-match (HTTP 200); HTTP errors are thrown so
 * auth/plan problems surface instead of silently yielding zero results.
 */
function resolveOrg_(name, key, cache) {
  if (cache[name] !== undefined) return cache[name];
  var resp = UrlFetchApp.fetch(APOLLO_ORG_SEARCH_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Api-Key': key, 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
    payload: JSON.stringify({ q_organization_name: name, per_page: 1 }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code >= 300) throw apolloError_('company search', code, resp.getContentText());
  var data = JSON.parse(resp.getContentText());
  var list = data.organizations || data.accounts || [];
  var org = list.length ? { id: list[0].id || '', domain: list[0].primary_domain || '' } : null;
  cache[name] = org;
  return org;
}

/** Search people by title within an org. Returns [{name, title, linkedin_url}]. */
function searchPeople_(org, title, key) {
  var body = {
    person_titles: [title],
    include_similar_titles: true,
    page: 1,
    per_page: FIND_PER_COMPANY
  };
  if (org && org.id) body.organization_ids = [org.id];
  else if (org && org.domain) body.q_organization_domains_list = [org.domain];
  else return [];   // couldn't identify the company — skip rather than search the whole world

  var resp = UrlFetchApp.fetch(APOLLO_PEOPLE_SEARCH_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Api-Key': key, 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) {
    throw apolloError_('people search', resp.getResponseCode(), resp.getContentText());
  }
  var people = JSON.parse(resp.getContentText()).people || [];
  return people.map(function (p) {
    return {
      name: p.name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim(),
      title: p.title || '',
      linkedin_url: p.linkedin_url || ''
    };
  }).filter(function (p) { return p.name; });
}

// ---- Stage 1: Enrich --------------------------------------------------------

function enrichLeads() {
  var sheet = getLeadsSheet_();
  var cols = detectColumns_(sheet);
  var out = ensureOutputColumns_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { toast_('No leads found in the "' + sheet.getName() + '" tab.'); return; }

  var pending = [];
  for (var r = 2; r <= lastRow; r++) {
    if (cellStr_(sheet, r, out.Email)) continue;            // already enriched
    var name = cellStr_(sheet, r, cols.name);
    if (!name) continue;
    pending.push({
      row: r,
      detail: buildDetail_(
        name,
        cols.company ? cellStr_(sheet, r, cols.company) : '',
        cols.linkedin ? cellStr_(sheet, r, cols.linkedin) : cellStr_(sheet, r, out['Enriched LinkedIn'])
      )
    });
  }

  var key = getApiKey_('APOLLO_API_KEY');
  var start = Date.now();
  for (var i = 0; i < pending.length; i += BATCH_SIZE) {
    if (timeUp_(start)) { toast_('Time limit — run Enrich again to finish.'); return; }
    var chunk = pending.slice(i, i + BATCH_SIZE);
    var people = apolloBulkMatch_(chunk.map(function (c) { return c.detail; }), key);
    for (var j = 0; j < chunk.length; j++) {
      var row = chunk[j].row, p = people[j];
      if (p) {
        sheet.getRange(row, out.Email).setValue(p.email);
        sheet.getRange(row, out['Enriched Title']).setValue(p.title);
        sheet.getRange(row, out['Enriched LinkedIn']).setValue(p.linkedin_url);
        sheet.getRange(row, out.Status).setValue(p.email ? 'matched' : 'no_email');
      } else {
        sheet.getRange(row, out.Status).setValue('no_match');
      }
    }
    SpreadsheetApp.flush();
  }
  toast_('Enrichment done.');
}

function apolloBulkMatch_(details, key) {
  var resp = UrlFetchApp.fetch(APOLLO_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Api-Key': key, 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
    payload: JSON.stringify({ details: details, reveal_personal_emails: true }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code >= 300) throw new Error('Apollo error ' + code + ': ' + resp.getContentText().slice(0, 300));
  var data = JSON.parse(resp.getContentText());
  var people = data.matches || data.contacts || data.people || [];
  var out = [];
  for (var i = 0; i < details.length; i++) {
    var p = people[i];
    if (p) {
      var org = p.organization || {};
      var email = p.email || '';
      if (/email_not_unlocked/i.test(email)) email = '';   // Apollo placeholder
      out.push({
        email: email,
        title: p.title || '',
        linkedin_url: p.linkedin_url || '',
        company: p.organization_name || org.name || ''
      });
    } else {
      out.push(null);
    }
  }
  return out;
}

// ---- Stage 2: Generate ------------------------------------------------------

function generateEmails() {
  var sheet = getLeadsSheet_();
  var cols = detectColumns_(sheet);
  var out = ensureOutputColumns_(sheet);
  var config = readConfig_();
  var segments = readSegments_();
  var system = buildSystemPrompt_(config);
  var model = config['Model'] || 'claude-sonnet-4-6';
  var key = getApiKey_('ANTHROPIC_API_KEY');
  var lastRow = sheet.getLastRow();

  var start = Date.now(), done = 0;
  for (var r = 2; r <= lastRow; r++) {
    if (timeUp_(start)) { toast_('Time limit — run Generate again to finish. Wrote ' + done + '.'); return; }
    if (!cellStr_(sheet, r, out.Email)) continue;     // no one to write to
    if (cellStr_(sheet, r, out.Body)) continue;       // already written

    var name = cellStr_(sheet, r, cols.name);
    var company = cols.company ? cellStr_(sheet, r, cols.company) : '';
    var category = cols.category ? cellStr_(sheet, r, cols.category) : '';
    var title = cellStr_(sheet, r, out['Enriched Title']) ||
      (cols.role ? cellStr_(sheet, r, cols.role) : '');
    var angle = angleFor_(category, segments, config);

    var userMsg =
      'Recipient: ' + name + '\n' +
      'Title: ' + title + '\n' +
      'Company: ' + company + '\n' +
      'Segment: ' + (category || 'general') + '\n' +
      'Segment angle to use: ' + angle + '\n\n' +
      'Write the email.';

    var parsed = parseEmail_(callClaude_(system, userMsg, model, config, key));
    sheet.getRange(r, out.Subject).setValue(parsed.subject || '');
    sheet.getRange(r, out.Body).setValue(withSignature_(parsed.body || '', config));
    done++;
    SpreadsheetApp.flush();
  }
  toast_('Generated ' + done + ' emails.');
}

function callClaude_(system, userMsg, model, config, key) {
  var resp = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    payload: JSON.stringify({
      model: model,
      max_tokens: Number(config['Max Tokens'] || 1024),
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMsg }]
    }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code >= 300) throw new Error('Anthropic error ' + code + ': ' + resp.getContentText().slice(0, 300));
  var data = JSON.parse(resp.getContentText());
  return (data.content && data.content[0] && data.content[0].text) || '';
}

// ---- Stage 3: Drafts --------------------------------------------------------

function createDrafts() {
  var sheet = getLeadsSheet_();
  var out = ensureOutputColumns_(sheet);
  var config = readConfig_();
  var senderEmail = config['Sender Email'] || '';
  var useFrom = senderEmail && GmailApp.getAliases().indexOf(senderEmail) >= 0;
  var lastRow = sheet.getLastRow();

  var start = Date.now(), made = 0;
  for (var r = 2; r <= lastRow; r++) {
    if (timeUp_(start)) { toast_('Time limit — run drafts again to finish. Created ' + made + '.'); return; }
    if (cellStr_(sheet, r, out.Draft)) continue;        // already drafted
    var email = cellStr_(sheet, r, out.Email);
    var body = cellStr_(sheet, r, out.Body);
    if (!email || !body) continue;

    var options = useFrom ? { from: senderEmail } : {};
    var draft = GmailApp.createDraft(email, cellStr_(sheet, r, out.Subject), body, options);
    sheet.getRange(r, out.Draft).setValue('Created ' + draft.getId());
    made++;
    SpreadsheetApp.flush();
  }
  toast_('Created ' + made + ' drafts. Review them in Gmail → Drafts.');
}

// ---- Config + segments ------------------------------------------------------

function readConfig_() {
  var sh = ss_().getSheetByName(CONFIG_SHEET);
  if (!sh) throw new Error('No "Config" tab. Run Outreach > Set up workspace first.');
  var values = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
  var map = {};
  values.forEach(function (row) { if (row[0]) map[String(row[0]).trim()] = row[1]; });
  return map;
}

function readSegments_() {
  var sh = ss_().getSheetByName(SEGMENTS_SHEET);
  var out = {};
  if (!sh || sh.getLastRow() < 1) return out;
  var values = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  values.forEach(function (row, i) {
    var seg = String(row[0] || '').trim();
    if (!seg) return;
    if (i === 0 && seg.toLowerCase() === 'segment') return;   // header
    out[seg] = String(row[1] || '').trim();
  });
  return out;
}

function angleFor_(category, segments, config) {
  if (category && segments[category]) return segments[category];
  return String(config['Default Angle'] || '').trim();
}

function buildSystemPrompt_(c) {
  var booking = c['Booking Link']
    ? '\n- If proposing a call, you may offer this link: ' + c['Booking Link'] : '';
  return [
    'You write short, personalized B2B cold outreach emails.', '',
    'WHAT WE OFFER:', String(c['Product'] || '').trim(), '',
    'SENDER: ' + (c['Sender Name'] || '') + ' <' + (c['Sender Email'] || '') + '>', '',
    'RULES:',
    '- Tone: ' + (c['Tone'] || 'warm, concise, professional') + '.',
    '- Hard limit: ' + (c['Word Limit'] || 120) + ' words in the body. Shorter is better.',
    '- Open with a specific, genuine reason for reaching out to THIS person given their role and company. No flattery.',
    '- One clear value proposition tied to the segment angle you are given.',
    '- One soft call to action.' + booking,
    '- Do NOT include a signature or sign-off; it is appended automatically.',
    '- No placeholders like [Name] or [Company]; use the real values provided.', '',
    'Respond with ONLY a JSON object: {"subject":"...","body":"..."}'
  ].join('\n');
}

function parseEmail_(text) {
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  var m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ } }
  return { subject: '', body: String(text).trim() };
}

function withSignature_(body, c) {
  var sig = String(c['Signature'] || '').trim();
  body = String(body).trim();
  return sig ? body + '\n\n' + sig : body;
}

// ---- Columns ----------------------------------------------------------------

function detectColumns_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var lower = {};
  headers.forEach(function (h, i) { if (h !== '') lower[String(h).toLowerCase().trim()] = i + 1; });
  var out = {};
  Object.keys(COLUMN_ALIASES).forEach(function (concept) {
    var aliases = COLUMN_ALIASES[concept];
    for (var k = 0; k < aliases.length; k++) {
      if (lower[aliases[k]]) { out[concept] = lower[aliases[k]]; break; }
    }
  });
  // Fallback for role: match any header mentioning title/position/role (handles
  // decorated headers like "Job Title / Position").
  if (!out.role) {
    Object.keys(lower).forEach(function (h) {
      if (!out.role && /\b(title|position|role)\b/.test(h)) out.role = lower[h];
    });
  }
  if (!out.name) throw new Error('Could not find a Name column in the "' + sheet.getName() + '" tab.');
  return out;
}

function ensureOutputColumns_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var map = {}, next = lastCol + 1;
  OUTPUT_COLUMNS.forEach(function (name) {
    var idx = headers.indexOf(name);
    if (idx >= 0) {
      map[name] = idx + 1;
    } else {
      sheet.getRange(1, next).setValue(name).setFontWeight('bold');
      map[name] = next;
      headers.push(name);
      next++;
    }
  });
  return map;
}

// ---- Helpers ----------------------------------------------------------------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function props_() { return PropertiesService.getScriptProperties(); }

function getApiKey_(name) {
  var v = props_().getProperty(name);
  if (!v) throw new Error('Missing ' + name + '. Use Outreach > Set API keys.');
  return v;
}

function getLeadsSheet_() {
  return ss_().getSheetByName(LEADS_SHEET) || ss_().getSheets()[0];
}

function cellStr_(sheet, row, col) {
  if (!col) return '';
  return String(sheet.getRange(row, col).getValue()).trim();
}

function buildDetail_(name, company, linkedin) {
  var parts = name.split(/\s+/);
  var d = { name: name };
  if (parts.length) {
    d.first_name = parts[0];
    if (parts.length > 1) d.last_name = parts.slice(1).join(' ');
  }
  if (company) d.organization_name = company;
  if (linkedin) d.linkedin_url = linkedin;
  return d;
}

function distinctCategories_() {
  var sheet = getLeadsSheet_();
  var cols;
  try { cols = detectColumns_(sheet); } catch (e) { return []; }
  if (!cols.category || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, cols.category, sheet.getLastRow() - 1, 1).getValues();
  var seen = {}, out = [];
  values.forEach(function (row) {
    var v = String(row[0] || '').trim();
    if (v && !seen[v]) { seen[v] = true; out.push(v); }
  });
  return out;
}

function timeUp_(start) { return Date.now() - start > TIME_LIMIT_MS; }
function toast_(msg) { ss_().toast(msg, 'Outreach', 8); }
