# Lead Outreach Pipeline

Turn a CSV of target leads into reviewed, personalized outreach drafts:

1. **Enrich** — find each lead's email, LinkedIn, and verified title via the
   [Apollo](https://apollo.io) API (cached so you never spend credits twice).
2. **Generate** — write a short, personalized email per lead with Claude,
   using a different angle per segment.
3. **Draft** — create a Gmail draft per lead (never auto-sends) for you to
   review and send.

It's content-free and generalizable: an interactive setup wizard reads your
CSV, detects its columns and segments, and asks for your pitch — so it works
for any list, not one hardcoded campaign.

## Two ways to run it

| | Python CLI | Google Sheets |
|---|---|---|
| **For** | technical user, bulk/scheduled runs | non-technical user, self-serve |
| **Install** | venv + pip | none |
| **Where data lives** | CSV files | a Google Sheet |
| **How** | terminal commands | an "Outreach" menu in the Sheet |
| **Setup** | this README, below | [`apps_script/`](apps_script/) + "Google Sheets edition" below |

Both do the same three stages and both create Gmail drafts (never auto-send).
Pick one — the rest of this section is the **Python CLI**; the Sheets setup is
at the end.

## Requirements

- Python 3.10+
- Apollo.io API key (Professional plan or higher — lower tiers have no API).
  The **Find people** step needs a **master API key** (enable master access when
  creating the key); enrichment alone works with a regular key.
- Anthropic API key
- A Google account for Gmail drafts

## Install

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Configure

### 1. Keys

```bash
cp .env.example .env
# Paste APOLLO_API_KEY and ANTHROPIC_API_KEY into .env
```

- Apollo key: Apollo web app → **Settings → Integrations → API**.
- Anthropic key: <https://console.anthropic.com/settings/keys>.

### 2. Your data + pitch

Put your lead CSV somewhere (default `data/input.csv`), then run the wizard:

```bash
python -m src.setup
```

It detects your columns (`name / company / role / category / linkedin`) and the
distinct segments in your category column, then asks for your product
description, sender identity, and one outreach angle per segment. It writes
`config.yaml` (gitignored). You can re-run it anytime, or edit `config.yaml`
by hand — see `config.example.yaml` for the full shape.

### 3. Gmail setup (one time)

The pipeline creates drafts via the Gmail API, which needs an OAuth client:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create (or pick) a project.
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   application type **Desktop app**.
4. Download the JSON and save it as `credentials.json` in this folder.
5. The first run that creates a draft opens a browser for consent and caches
   the token in `token.json`.

Both `credentials.json` and `token.json` are gitignored.

## Run

```bash
# Cheap test on the first 5 leads, enrichment only:
python -m src.pipeline --enrich --limit 5

# Full run (all stages):
python -m src.pipeline

# Or one stage at a time, reviewing data/enriched.csv between each:
python -m src.pipeline --find       # only if your list has companies+roles but no names
python -m src.pipeline --enrich
python -m src.pipeline --generate
python -m src.pipeline --draft
```

Flags: `--force` redoes completed steps, `--limit N` processes only the first
N leads.

**`--find` (discovery):** for lists that name target companies + roles but not
people. It resolves each company to its Apollo org, searches for the top few
people matching the role (credit-free), and **appends them as new rows**
capturing each person's Apollo id; `--enrich` then reveals the full name,
email, and LinkedIn. Skip it if your CSV already has names. Found rows persist
in `data/enriched.csv` across runs, and re-running `--find` won't duplicate them.

## How it stays safe and cheap

- **Drafts only** — nothing is sent automatically. Review in Gmail first.
- **Apollo cache** (`data/cache/`) — re-runs reuse prior matches, no extra
  credits.
- **Resumable** — `data/enriched.csv` is the source of truth; each stage skips
  work that's already done unless you pass `--force`.
- **Prompt caching** — the shared pitch/instructions are cached across the
  per-lead Claude calls.

## Output

`data/enriched.csv` = your original columns plus: `enriched_email`,
`enriched_linkedin`, `enriched_title`, `enriched_company`, `apollo_status`,
`email_subject`, `email_body`, `gen_status`, `draft_id`.

---

## Google Sheets edition (for a non-technical user)

Everything above, driven from a Google Sheet — no install, no terminal. The
code lives in [`apps_script/Code.gs`](apps_script/Code.gs). A technical person
does the one-time setup below; after that, anyone can run campaigns from the
sheet's **Outreach** menu.

### One-time setup

1. Create a new Google Sheet and paste your leads into a tab named **`Leads`**
   (row 1 = headers like `Name, Company, Role, Category, Linkedin`).
2. **Extensions → Apps Script.** Delete the placeholder, paste the contents of
   `apps_script/Code.gs`, and save. (Optional: in Project Settings enable
   "Show appsscript.json", then paste `apps_script/appsscript.json`.)
3. Reload the Sheet. An **Outreach** menu appears.
4. **Outreach → Set up workspace** — creates `Config` and `Segments` tabs and
   adds the output columns to `Leads`.
5. **Outreach → Set API keys** — paste the Apollo and Anthropic keys (stored in
   Script Properties, not in the sheet).
6. Fill in the **Config** tab (product, sender name/email, signature, booking
   link) and the **Segments** tab (one angle per segment — pre-filled from the
   categories found in your data).

> Note: the first run of any step asks for Google permission (Gmail + Sheets).
> Click through the "unverified app" screen — it's your own script.

### Running a campaign

From the **Outreach** menu, in order:

1. **Find people (Apollo search)** — *only needed if your list has companies +
   target roles but no people named yet.* For each company+role row it finds the
   top few matching people and appends them as new rows. (Apollo search returns
   a partial name + a person id; the Enrich step then reveals the full name,
   email, and LinkedIn.) Skip this step if your sheet already has names.
2. **Enrich emails (Apollo)** — reveals Email (and fills Enriched Title /
   LinkedIn) for each named lead.
3. **Generate emails** — writes Subject + Body per lead.
4. **Create Gmail drafts** — one draft per lead; review in Gmail → Drafts.

Or **Run all**. Every step skips rows already done, so if a run hits Apps
Script's 6-minute limit you just click it again to continue. Nothing is ever
sent automatically.

> **Find vs. Enrich:** *Find* answers "who are the people in this role at this
> company?" (search by company + title — free, returns names + LinkedIn).
> *Enrich* answers "what's this known person's email?" (match by name — costs
> credits, reveals the email). A name-less target list needs Find first; a list
> that already has names goes straight to Enrich.
