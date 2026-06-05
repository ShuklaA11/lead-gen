/**
 * Master Lead List — Google Sheets edition.
 *
 * Same pipeline as the Python CLI: Find people (Apollo search) -> Enrich
 * (Apollo) -> Research (Claude web_search) -> build a clean Master List tab.
 * Every step is idempotent (skips rows already done) and time-guarded (Apps
 * Script caps runs at 6 min — just re-run to continue).
 *
 * Tabs:
 *   Leads        your input list + working enrichment columns
 *   Profiles     one row per person_id holding the full research profile JSON
 *   Master List  the 15-column output (rebuilt from Leads on demand)
 *   Config       key/value settings (campaign brief, optional email pitch)
 *
 * API keys (Apollo, Anthropic) live in Script Properties — set once via
 * "Master List > Set API keys", never in the sheet.
 */

// ---- Constants --------------------------------------------------------------

var LEADS_SHEET = 'Leads';
var CONFIG_SHEET = 'Config';
var MASTER_SHEET = 'Master List';
var PROFILES_SHEET = 'Profiles';

var APOLLO_URL = 'https://api.apollo.io/api/v1/people/bulk_match';
var APOLLO_PEOPLE_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';
var APOLLO_ORG_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';
var WEB_SEARCH_TOOL = 'web_search_20250305';

var BATCH_SIZE = 10;                 // Apollo bulk_match max per call
var FIND_PER_COMPANY = 3;            // how many people to pull per company+title
var TIME_LIMIT_MS = 5 * 60 * 1000;   // stop before the 6-min Apps Script cap

// The 15-column master list, in order. Company comes from the input column; the
// rest are working columns appended to the Leads tab (so the names match and the
// Master List tab is a straight reorder/copy).
var MASTER_COLUMNS = [
  'Company', 'Full Name', 'First Name', 'Last Name', 'LinkedIn URL',
  'Work Email', 'person_id', 'company_id', 'Apollo Title', 'Apollo Seniority',
  'Email Status (Apollo)', 'Work Phone (Company)', 'Source Note',
  'Apollo Person ID', 'Info dump'
];

// Working columns appended to Leads (everything master needs except the input
// Company column), plus an internal Status used for find/enrich/resume logic.
var OUTPUT_COLUMNS = [
  'Full Name', 'First Name', 'Last Name', 'LinkedIn URL', 'Work Email',
  'person_id', 'company_id', 'Apollo Title', 'Apollo Seniority',
  'Email Status (Apollo)', 'Work Phone (Company)', 'Source Note',
  'Apollo Person ID', 'Info dump', 'Status'
];

// Optional email-outreach columns (only added if you run Generate/Draft).
var EMAIL_COLUMNS = ['Subject', 'Body', 'Draft'];

var COLUMN_ALIASES = {
  name: ['name', 'full name', 'full_name', 'contact', 'contact name'],
  company: ['company', 'organization', 'organisation', 'employer', 'account'],
  role: ['role', 'job title', 'position', 'job title/position', 'title/position', 'title'],
  category: ['category', 'segment', 'type', 'list', 'group'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin_url', 'li', 'profile']
};

// Rule-based priority fallback (research overrides this). Lowercase compares.
var DEFAULT_HIGH_KEYWORDS = ['brand', 'marketing', 'analytics', 'growth', 'digital'];
var DEFAULT_HIGH_SENIORITIES = ['c_suite', 'owner', 'founder', 'partner'];
var DEFAULT_MED_SENIORITIES = ['vp', 'director', 'head'];
var DEFAULT_RETIRED_KEYWORDS = ['retired', 'former'];

var ACRONYM_STOPWORDS = { 'of': 1, 'the': 1, 'and': 1, 'for': 1, 'a': 1, 'an': 1, '&': 1 };

// ---- Menu -------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Master List')
    .addItem('Set up workspace', 'setupWorkspace')
    .addItem('Set API keys…', 'setApiKeys')
    .addSeparator()
    .addItem('1. Find people (Apollo search)', 'findPeople')
    .addItem('2. Enrich (Apollo)', 'enrichLeads')
    .addItem('3. Research (Claude web search)', 'researchLeads')
    .addItem('4. Build Master List', 'buildMasterList')
    .addItem('Run all (1 → 2 → 3 → 4)', 'runAll')
    .addSeparator()
    .addItem('Optional: Generate emails', 'generateEmails')
    .addItem('Optional: Create Gmail drafts', 'createDrafts')
    .addToUi();
}

function runAll() {
  findPeople();
  enrichLeads();
  researchLeads();
  buildMasterList();
}

// ---- Setup ------------------------------------------------------------------

function setupWorkspace() {
  var book = ss_();

  if (!book.getSheetByName(CONFIG_SHEET)) {
    var cfg = book.insertSheet(CONFIG_SHEET);
    var rows = [
      ['Setting', 'Value'],
      ['Campaign Brief', 'Who you are targeting and what makes a contact High vs Med vs Low priority (the researcher judges fit against this).'],
      ['Company Prefixes', 'Navy Federal Credit Union=NFCU'],
      ['Research Model', 'claude-opus-4-8'],
      ['Max Searches', 5],
      ['Research Max Tokens', 4096],
      ['Product', ''],
      ['Sender Name', ''],
      ['Sender Email', ''],
      ['Booking Link', ''],
      ['Signature', ''],
      ['Default Angle', ''],
      ['Email Model', 'claude-sonnet-4-6'],
      ['Tone', 'warm, concise, professional, not salesy'],
      ['Word Limit', 120],
      ['Max Tokens', 1024]
    ];
    cfg.getRange(1, 1, rows.length, 2).setValues(rows);
    cfg.getRange(1, 1, 1, 2).setFontWeight('bold');
    cfg.setColumnWidth(2, 560);
  }

  ensureOutputColumns_(getLeadsSheet_());
  toast_('Workspace ready. Fill in the Campaign Brief in Config, then "Set API keys".');
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
 * for the top matching people and append them as new rows. Search is credit-free
 * and returns name + LinkedIn + title but a masked email — Enrich reveals the
 * real email afterward. Rows that already have a name are left untouched.
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
    if (cellStr_(sheet, r, cols.name)) continue;                            // already has a person
    if (cellStr_(sheet, r, out.Status).indexOf('expanded') === 0) continue; // already searched
    var company = cellStr_(sheet, r, cols.company);
    var title = cellStr_(sheet, r, cols.role);
    if (!company || !title) continue;

    var org = resolveOrg_(company, key, orgCache);
    var people = searchPeople_(org, title, key);
    var srcRow = sheet.getRange(r, 1, 1, lastCol).getValues()[0];
    people.forEach(function (p) {
      var row = srcRow.slice();
      row[cols.name - 1] = p.name;                          // first name; Enrich upgrades to full
      row[out['Apollo Person ID'] - 1] = p.id;
      row[out['Apollo Title'] - 1] = p.title || title;
      row[out['LinkedIn URL'] - 1] = p.linkedin_url || '';
      row[out['Work Email'] - 1] = '';                      // let Enrich reveal it
      row[out.Status - 1] = 'found';
      newRows.push(row);
    });
    sheet.getRange(r, out.Status).setValue('expanded (' + people.length + ')');
    SpreadsheetApp.flush();
  }

  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, lastCol).setValues(newRows);
  }
  toast_('Found ' + newRows.length + ' people. Next: Enrich.');
}

/** Build a clear error, flagging the master-key requirement on 401/403. */
function apolloError_(action, code, body) {
  var hint = (code === 401 || code === 403)
    ? ' Access denied. The Apollo search/enrich APIs require a PAID plan (Professional+)' +
      ' — free plans return API_INACCESSIBLE — and People Search additionally needs a' +
      ' MASTER API key. Check your plan at app.apollo.io, then recreate the key (master' +
      ' access) in the paid workspace and re-run "Set API keys".'
    : '';
  return new Error('Apollo ' + action + ' failed (' + code + ').' + hint + ' ' + String(body).slice(0, 200));
}

/**
 * Resolve a company name to an Apollo org {id, domain}; cached per run. Returns
 * null only on a genuine no-match (HTTP 200); HTTP errors are thrown so auth/plan
 * problems surface instead of silently yielding zero results.
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

/** Search people by title within an org. Returns [{id, name, title, linkedin_url}]. */
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
      id: p.id || '',
      name: p.name || p.first_name || '',   // first name only; Enrich fills the full name
      title: p.title || '',
      linkedin_url: p.linkedin_url || ''
    };
  }).filter(function (p) { return p.id; });
}

// ---- Stage 1: Enrich --------------------------------------------------------

function enrichLeads() {
  var sheet = getLeadsSheet_();
  var cols = detectColumns_(sheet);
  var out = ensureOutputColumns_(sheet);
  var config = readConfig_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { toast_('No leads found in the "' + sheet.getName() + '" tab.'); return; }

  var pending = [];
  for (var r = 2; r <= lastRow; r++) {
    if (cellStr_(sheet, r, out['Work Email'])) continue;            // already enriched
    var apolloId = cellStr_(sheet, r, out['Apollo Person ID']);    // set by Find; exact match
    var name = cellStr_(sheet, r, cols.name);
    if (!apolloId && !name) continue;                              // nothing to match on
    pending.push({
      row: r,
      apolloId: apolloId,
      detail: buildDetail_(
        name,
        cols.company ? cellStr_(sheet, r, cols.company) : '',
        cols.linkedin ? cellStr_(sheet, r, cols.linkedin) : cellStr_(sheet, r, out['LinkedIn URL']),
        apolloId
      )
    });
  }

  var key = getApiKey_('APOLLO_API_KEY');
  var start = Date.now();
  for (var i = 0; i < pending.length; i += BATCH_SIZE) {
    if (timeUp_(start)) { toast_('Time limit — run Enrich again to finish.'); break; }
    var chunk = pending.slice(i, i + BATCH_SIZE);
    var people = apolloBulkMatch_(chunk.map(function (c) { return c.detail; }), key);
    for (var j = 0; j < chunk.length; j++) {
      var row = chunk[j].row, p = people[j];
      if (p) {
        // For found rows (matched by Apollo id), upgrade the partial first name.
        if (chunk[j].apolloId && p.name) sheet.getRange(row, cols.name).setValue(p.name);
        setCell_(sheet, row, out, 'Full Name', p.name);
        setCell_(sheet, row, out, 'First Name', p.first_name);
        setCell_(sheet, row, out, 'Last Name', p.last_name);
        setCell_(sheet, row, out, 'Work Email', p.email);
        if (p.title) setCell_(sheet, row, out, 'Apollo Title', p.title);
        setCell_(sheet, row, out, 'Apollo Seniority', p.seniority);
        setCell_(sheet, row, out, 'Email Status (Apollo)', p.email_status);
        if (p.linkedin_url) setCell_(sheet, row, out, 'LinkedIn URL', p.linkedin_url);
        setCell_(sheet, row, out, 'Work Phone (Company)', p.company_phone);
        setCell_(sheet, row, out, 'Apollo Person ID', chunk[j].apolloId || p.id);
        sheet.getRange(row, out.Status).setValue(p.email ? 'matched' : 'no_email');
        // Rule-based priority fallback + base Source Note / Info dump (research
        // overrides these later).
        var title = p.title || (cols.role ? cellStr_(sheet, row, cols.role) : '');
        var prio = targetPriority_(title, p.seniority, config);
        applyPriority_(sheet, row, out, prio, leadFlags_(title, config), '', 0, '', '');
      } else {
        sheet.getRange(row, out.Status).setValue('no_match');
      }
    }
    SpreadsheetApp.flush();
  }
  assignIds_(sheet, cols, out, config);
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
        id: p.id || '',
        email: email,
        name: p.name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim(),
        first_name: p.first_name || '',
        last_name: p.last_name || '',
        title: p.title || '',
        seniority: p.seniority || '',
        email_status: p.email_status || '',
        linkedin_url: p.linkedin_url || '',
        company: p.organization_name || org.name || '',
        company_phone: orgPhone_(org)
      });
    } else {
      out.push(null);
    }
  }
  return out;
}

/** Best-effort company phone from an Apollo organization object. */
function orgPhone_(org) {
  var primary = org.primary_phone;
  if (primary && typeof primary === 'object') primary = primary.number || '';
  return org.sanitized_phone || org.phone || (typeof primary === 'string' ? primary : '') || '';
}

// ---- Stage 2: Research (Claude web_search) ----------------------------------

function researchLeads() {
  var sheet = getLeadsSheet_();
  var cols = detectColumns_(sheet);
  var out = ensureOutputColumns_(sheet);
  var config = readConfig_();
  assignIds_(sheet, cols, out, config);

  var key = getApiKey_('ANTHROPIC_API_KEY');
  var model = config['Research Model'] || 'claude-opus-4-8';
  var maxSearches = Number(config['Max Searches'] || 5);
  var maxTokens = Number(config['Research Max Tokens'] || 4096);
  var system = researchSystem_(config);
  var lastRow = sheet.getLastRow();

  var start = Date.now(), done = 0;
  for (var r = 2; r <= lastRow; r++) {
    if (timeUp_(start)) { toast_('Time limit — run Research again to finish. Did ' + done + '.'); break; }
    if (cellStr_(sheet, r, out.Status).indexOf('expanded') === 0) continue;  // placeholder row
    var name = cellStr_(sheet, r, out['Full Name']) || cellStr_(sheet, r, cols.name);
    if (!name) continue;
    if (researched_(cellStr_(sheet, r, out['Info dump']))) continue;          // already researched

    var company = cols.company ? cellStr_(sheet, r, cols.company) : '';
    var title = cellStr_(sheet, r, out['Apollo Title']) || (cols.role ? cellStr_(sheet, r, cols.role) : '');
    var linkedin = cellStr_(sheet, r, out['LinkedIn URL']);
    var personId = cellStr_(sheet, r, out['person_id']);

    var research = claudeResearch_(name, title, company, linkedin, system, model, maxSearches, maxTokens, key);
    writeProfile_(personId, name, title, company, linkedin, research);

    // Research priority overrides the rule-based fallback written at Enrich.
    applyPriority_(
      sheet, r, out,
      research.target_priority || targetPriorityFromNote_(sheet, r, out),
      research.flags || [],
      research.top_hook || '',
      research.web_findings || 0,
      personId ? 'Profiles!' + personId : '',
      sourceSuffix_(research)
    );
    done++;
    SpreadsheetApp.flush();
  }
  toast_('Researched ' + done + ' people.');
}

function claudeResearch_(name, title, company, linkedin, system, model, maxSearches, maxTokens, key) {
  var userMsg =
    'Person: ' + name + '\nTitle: ' + title + '\nCompany: ' + company + '\n' +
    'LinkedIn: ' + (linkedin || '(unknown)') + '\n\nResearch them and respond with the JSON.';
  var resp = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    payload: JSON.stringify({
      model: model,
      max_tokens: maxTokens,
      system: system,
      tools: [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: maxSearches }],
      messages: [{ role: 'user', content: userMsg }]
    }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code >= 300) throw new Error('Anthropic error ' + code + ': ' + resp.getContentText().slice(0, 300));
  var data = JSON.parse(resp.getContentText());
  var collected = collectResearch_(data.content || []);
  var parsed = parseJson_(collected.text);
  var findings = parsed.findings || [];
  parsed.web_findings = findings.length || collected.urlCount;
  return parsed;
}

/** Walk response content blocks -> {text, urlCount} (distinct source URLs). */
function collectResearch_(content) {
  var text = '', urls = {};
  content.forEach(function (block) {
    if (block.type === 'text') {
      text += block.text || '';
    } else if (block.type === 'web_search_tool_result') {
      var items = block.content || [];
      if (items.forEach) {
        items.forEach(function (it) { if (it && it.url) urls[it.url] = 1; });
      }
    }
  });
  return { text: text, urlCount: Object.keys(urls).length };
}

function researchSystem_(config) {
  var brief = String(config['Campaign Brief'] || '').trim() ||
    String(config['Product'] || '').trim() ||
    'Judge fit by general seniority and relevance to a B2B outreach.';
  var lines = [
    'You are a meticulous B2B sales researcher. Given one person, use web search to',
    'find specific, recent, verifiable facts about them, then judge their fit for the',
    'campaign below.', '',
    'CAMPAIGN BRIEF (judge target_priority against this):', brief, '',
    'Rules:',
    '- Search by name + company + role; prefer recent, attributable facts (talks,',
    '  podcasts, posts, launches, quotes, role changes).',
    '- target_priority is High / Med / Low: fit against the brief. A retired/former or',
    '  clearly mis-targeted contact is Low.',
    '- top_hook: ONE concrete, verifiable outreach angle tied to a real finding —',
    '  specific enough it could only describe THIS person. No flattery.',
    '- flags: short tokens for caveats, e.g. "retired". [] if none.',
    '- note: optional one-line verification caveat for a human (or "").', '',
    'Respond with ONLY a JSON object:',
    '{"top_hook":"...","target_priority":"High|Med|Low","flags":[...],"summary":"...",',
    ' "note":"...","findings":[{"title":"...","url":"...","note":"..."}]}'
  ];
  return [{ type: 'text', text: lines.join('\n'), cache_control: { type: 'ephemeral' } }];
}

function researched_(infoDump) {
  if (!infoDump) return false;
  var d = parseJson_(infoDump);
  return !!(d && d.top_hook);
}

function sourceSuffix_(research) {
  var parts = [];
  var flags = research.flags || [];
  if (flags.indexOf && flags.indexOf('retired') >= 0) parts.push('[RETIRED — remove/deprioritize]');
  var note = String(research.note || '').trim();
  if (note) parts.push(note);
  return parts.join('; ');
}

function targetPriorityFromNote_(sheet, row, out) {
  var note = cellStr_(sheet, row, out['Source Note']);
  var m = note.split('Target Priority:')[1];
  return m ? m.trim().split(/[\s;\[]/)[0] : 'Unknown';
}

// ---- Priority + flags (rule-based fallback) --------------------------------

function targetPriority_(title, seniority, config) {
  var t = String(title || '').toLowerCase();
  var s = String(seniority || '').toLowerCase().trim();
  var high = csvList_(config['High Keywords'], DEFAULT_HIGH_KEYWORDS);
  var highSen = csvList_(config['High Seniorities'], DEFAULT_HIGH_SENIORITIES);
  var medSen = csvList_(config['Med Seniorities'], DEFAULT_MED_SENIORITIES);
  if (anyIn_(t, high) || highSen.indexOf(s) >= 0) return 'High';
  if (medSen.indexOf(s) >= 0) return 'Med';
  return 'Low';
}

function leadFlags_(title, config) {
  var t = String(title || '').toLowerCase();
  var words = csvList_(config['Retired Keywords'], DEFAULT_RETIRED_KEYWORDS);
  return anyIn_(t, words) ? ['retired'] : [];
}

/** Write priority-derived columns: Source Note + Info dump (with research). */
function applyPriority_(sheet, row, out, priority, flags, topHook, webFindings, profileRef, suffix) {
  var p = priority || 'Unknown';
  var note = 'Apollo org-scoped people search + people_match (' + today_() + '); Target Priority: ' + p;
  if (suffix) note += '; ' + suffix;
  sheet.getRange(row, out['Source Note']).setValue(note);
  var info = {
    profile: profileRef || '',
    target_priority: p,
    web_findings: Number(webFindings || 0),
    top_hook: topHook || '',
    flags: flags || []
  };
  sheet.getRange(row, out['Info dump']).setValue(JSON.stringify(info));
}

// ---- IDs + Master List ------------------------------------------------------

/** Assign company_id (per distinct company, first-seen) + person_id (PREFIX-NNN). */
function assignIds_(sheet, cols, out, config) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var prefixes = parsePrefixes_(config['Company Prefixes']);
  var companyIds = {}, seq = {}, nextId = 1;
  for (var r = 2; r <= lastRow; r++) {
    if (cellStr_(sheet, r, out.Status).indexOf('expanded') === 0) continue;
    var name = cellStr_(sheet, r, out['Full Name']) || cellStr_(sheet, r, cols.name);
    if (!name) continue;
    var company = cols.company ? cellStr_(sheet, r, cols.company) : '';
    var key = company.toLowerCase();
    if (companyIds[key] === undefined) { companyIds[key] = nextId++; seq[key] = 0; }
    seq[key]++;
    var prefix = prefixes[key] || acronym_(company);
    sheet.getRange(r, out['company_id']).setValue(companyIds[key]);
    sheet.getRange(r, out['person_id']).setValue(prefix + '-' + zeroPad_(seq[key], 3));
  }
  SpreadsheetApp.flush();
}

/** Rebuild the Master List tab (exactly the 15 columns) from Leads. */
function buildMasterList() {
  var sheet = getLeadsSheet_();
  var cols = detectColumns_(sheet);
  var out = ensureOutputColumns_(sheet);
  var config = readConfig_();
  assignIds_(sheet, cols, out, config);

  var lastRow = sheet.getLastRow();
  var rows = [MASTER_COLUMNS.slice()];
  for (var r = 2; r <= lastRow; r++) {
    if (cellStr_(sheet, r, out.Status).indexOf('expanded') === 0) continue;
    var fullName = cellStr_(sheet, r, out['Full Name']) || cellStr_(sheet, r, cols.name);
    var email = cellStr_(sheet, r, out['Work Email']);
    var apolloId = cellStr_(sheet, r, out['Apollo Person ID']);
    if (!fullName && !email && !apolloId) continue;   // not a real person
    rows.push([
      cols.company ? cellStr_(sheet, r, cols.company) : '',
      fullName,
      cellStr_(sheet, r, out['First Name']),
      cellStr_(sheet, r, out['Last Name']),
      cellStr_(sheet, r, out['LinkedIn URL']),
      email,
      cellStr_(sheet, r, out['person_id']),
      cellStr_(sheet, r, out['company_id']),
      cellStr_(sheet, r, out['Apollo Title']),
      cellStr_(sheet, r, out['Apollo Seniority']),
      cellStr_(sheet, r, out['Email Status (Apollo)']),
      cellStr_(sheet, r, out['Work Phone (Company)']),
      cellStr_(sheet, r, out['Source Note']),
      apolloId,
      cellStr_(sheet, r, out['Info dump'])
    ]);
  }

  var master = ss_().getSheetByName(MASTER_SHEET) || ss_().insertSheet(MASTER_SHEET);
  master.clearContents();
  master.getRange(1, 1, rows.length, MASTER_COLUMNS.length).setValues(rows);
  master.getRange(1, 1, 1, MASTER_COLUMNS.length).setFontWeight('bold');
  master.setFrozenRows(1);
  toast_('Master List built: ' + (rows.length - 1) + ' people.');
}

// ---- Profiles tab -----------------------------------------------------------

function writeProfile_(personId, name, title, company, linkedin, research) {
  if (!personId) return;
  var sheet = ss_().getSheetByName(PROFILES_SHEET);
  if (!sheet) {
    sheet = ss_().insertSheet(PROFILES_SHEET);
    sheet.getRange(1, 1, 1, 2).setValues([['person_id', 'profile']]).setFontWeight('bold');
    sheet.setColumnWidth(2, 700);
  }
  var profile = {
    name: name, title: title, company: company, linkedin: linkedin,
    generated_at: today_(),
    web_findings: research.web_findings || 0,
    target_priority: research.target_priority || '',
    top_hook: research.top_hook || '',
    flags: research.flags || [],
    summary: research.summary || '',
    findings: research.findings || []
  };
  var json = JSON.stringify(profile);
  var last = sheet.getLastRow();
  for (var r = 2; r <= last; r++) {
    if (String(sheet.getRange(r, 1).getValue()).trim() === personId) {
      sheet.getRange(r, 2).setValue(json);
      return;
    }
  }
  sheet.getRange(last + 1, 1, 1, 2).setValues([[personId, json]]);
}

// ---- Optional: email generation + drafts -----------------------------------

function generateEmails() {
  var sheet = getLeadsSheet_();
  var cols = detectColumns_(sheet);
  var out = ensureOutputColumns_(sheet);
  var em = ensureEmailColumns_(sheet);
  var config = readConfig_();
  var system = buildSystemPrompt_(config);
  var model = config['Email Model'] || 'claude-sonnet-4-6';
  var key = getApiKey_('ANTHROPIC_API_KEY');
  var lastRow = sheet.getLastRow();

  var start = Date.now(), done = 0;
  for (var r = 2; r <= lastRow; r++) {
    if (timeUp_(start)) { toast_('Time limit — run Generate again. Wrote ' + done + '.'); return; }
    if (!cellStr_(sheet, r, out['Work Email'])) continue;
    if (cellStr_(sheet, r, em.Body)) continue;

    var name = cellStr_(sheet, r, out['Full Name']) || cellStr_(sheet, r, cols.name);
    var company = cols.company ? cellStr_(sheet, r, cols.company) : '';
    var title = cellStr_(sheet, r, out['Apollo Title']) || (cols.role ? cellStr_(sheet, r, cols.role) : '');
    var info = parseJson_(cellStr_(sheet, r, out['Info dump']));
    var hook = info.top_hook || cellStr_(sheet, r, out['Source Note']);

    var userMsg =
      'Recipient: ' + name + '\nTitle: ' + title + '\nCompany: ' + company + '\n' +
      'Personalization hook to lead with: ' + hook + '\n\nWrite the email.';
    var parsed = parseJson_(callClaude_(system, userMsg, model, config, key));
    sheet.getRange(r, em.Subject).setValue(parsed.subject || '');
    sheet.getRange(r, em.Body).setValue(withSignature_(parsed.body || '', config));
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

function createDrafts() {
  var sheet = getLeadsSheet_();
  var out = ensureOutputColumns_(sheet);
  var em = ensureEmailColumns_(sheet);
  var config = readConfig_();
  var senderEmail = config['Sender Email'] || '';
  var useFrom = senderEmail && GmailApp.getAliases().indexOf(senderEmail) >= 0;
  var lastRow = sheet.getLastRow();

  var start = Date.now(), made = 0;
  for (var r = 2; r <= lastRow; r++) {
    if (timeUp_(start)) { toast_('Time limit — run drafts again. Created ' + made + '.'); return; }
    if (cellStr_(sheet, r, em.Draft)) continue;
    var email = cellStr_(sheet, r, out['Work Email']);
    var body = cellStr_(sheet, r, em.Body);
    if (!email || !body) continue;

    var options = useFrom ? { from: senderEmail } : {};
    var draft = GmailApp.createDraft(email, cellStr_(sheet, r, em.Subject), body, options);
    sheet.getRange(r, em.Draft).setValue('Created ' + draft.getId());
    made++;
    SpreadsheetApp.flush();
  }
  toast_('Created ' + made + ' drafts. Review them in Gmail → Drafts.');
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
    '- Open with the personalization hook you are given — make it specific to THIS person.',
    '- One clear value proposition and one soft call to action.' + booking,
    '- Do NOT include a signature or sign-off; it is appended automatically.',
    '- No placeholders like [Name]; use the real values provided.', '',
    'Respond with ONLY a JSON object: {"subject":"...","body":"..."}'
  ].join('\n');
}

function withSignature_(body, c) {
  var sig = String(c['Signature'] || '').trim();
  body = String(body).trim();
  return sig ? body + '\n\n' + sig : body;
}

// ---- Config -----------------------------------------------------------------

function readConfig_() {
  var sh = ss_().getSheetByName(CONFIG_SHEET);
  if (!sh) throw new Error('No "Config" tab. Run Master List > Set up workspace first.');
  var values = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
  var map = {};
  values.forEach(function (row) { if (row[0]) map[String(row[0]).trim()] = row[1]; });
  return map;
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
  if (!out.role) {
    Object.keys(lower).forEach(function (h) {
      if (!out.role && /\b(title|position|role)\b/.test(h)) out.role = lower[h];
    });
  }
  if (!out.name) throw new Error('Could not find a Name column in the "' + sheet.getName() + '" tab.');
  return out;
}

function ensureOutputColumns_(sheet) { return ensureColumns_(sheet, OUTPUT_COLUMNS); }
function ensureEmailColumns_(sheet) { return ensureColumns_(sheet, EMAIL_COLUMNS); }

function ensureColumns_(sheet, wanted) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var map = {}, next = lastCol + 1;
  wanted.forEach(function (name) {
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
  if (!v) throw new Error('Missing ' + name + '. Use Master List > Set API keys.');
  return v;
}

function getLeadsSheet_() {
  return ss_().getSheetByName(LEADS_SHEET) || ss_().getSheets()[0];
}

function cellStr_(sheet, row, col) {
  if (!col) return '';
  return String(sheet.getRange(row, col).getValue()).trim();
}

function setCell_(sheet, row, out, name, value) {
  if (out[name] && value !== '' && value != null) sheet.getRange(row, out[name]).setValue(value);
}

function buildDetail_(name, company, linkedin, id) {
  if (id) return { id: id };   // exact match by Apollo person id (from Find)
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

function parseJson_(text) {
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  var m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ } }
  return {};
}

function acronym_(company) {
  var words = String(company).replace(/&/g, ' ').split(/\s+/).filter(function (w) {
    return w && !ACRONYM_STOPWORDS[w.toLowerCase()];
  });
  var letters = words.map(function (w) { return /[a-z0-9]/i.test(w[0]) ? w[0] : ''; }).join('');
  return letters.toUpperCase() || 'CO';
}

function parsePrefixes_(raw) {
  var map = {};
  String(raw || '').split(/[;\n]/).forEach(function (line) {
    var eq = line.indexOf('=');
    if (eq > 0) map[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  });
  return map;
}

function csvList_(raw, fallback) {
  if (!raw) return fallback;
  return String(raw).split(',').map(function (s) { return s.toLowerCase().trim(); }).filter(Boolean);
}

function anyIn_(text, words) {
  for (var i = 0; i < words.length; i++) { if (text.indexOf(words[i]) >= 0) return true; }
  return false;
}

function zeroPad_(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function timeUp_(start) { return Date.now() - start > TIME_LIMIT_MS; }
function toast_(msg) { ss_().toast(msg, 'Master List', 8); }
