"""Master lead-list exporter — the canonical output schema.

Maps each internal pipeline record onto the fixed 15-column master list, and
synthesizes the columns that aren't raw Apollo fields:

- company_id : sequential int per distinct company (first-seen order)
- person_id  : "<PREFIX>-<NNN>" where PREFIX is the company acronym (overridable
               in config) and NNN is the per-company sequence, zero-padded
- Source Note: provenance string + target priority (+ any research suffix)
- Info dump  : compact JSON {profile, target_priority, web_findings, top_hook, flags}

`from_row` reverses the mapping so a prior master-list.csv can be re-read for
resume. The research fields (top_hook, web_findings, profile, flags) are empty
until the research stage fills them; this exporter stays pure either way.
"""
from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path

from .config import ROOT, field

COLUMNS = [
    "Company",
    "Full Name",
    "First Name",
    "Last Name",
    "LinkedIn URL",
    "Work Email",
    "person_id",
    "company_id",
    "Apollo Title",
    "Apollo Seniority",
    "Email Status (Apollo)",
    "Work Phone (Company)",
    "Source Note",
    "Apollo Person ID",
    "Info dump",
]

# Words skipped when auto-deriving a company acronym ("Navy Federal Credit
# Union" -> NFCU).
_ACRONYM_STOPWORDS = {"of", "the", "and", "for", "a", "an", "&"}


def _acronym(company: str) -> str:
    words = [w for w in company.replace("&", " ").split() if w.lower() not in _ACRONYM_STOPWORDS]
    letters = "".join(w[0] for w in words if w[:1].isalnum())
    return letters.upper() or "CO"


def _prefix(company: str, config: dict) -> str:
    overrides = {k.lower(): v for k, v in (config.get("company_prefixes") or {}).items()}
    return overrides.get(company.lower(), _acronym(company))


def _split_name(full: str) -> tuple[str, str]:
    parts = full.split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _company_of(record: dict, config: dict) -> str:
    return field(record, config, "company") or record.get("enriched_company", "")


def _full_name_of(record: dict, config: dict) -> str:
    return record.get("enriched_name") or field(record, config, "name")


def _info_dump(record: dict) -> str:
    flags = record.get("flags") or []
    if isinstance(flags, str):
        flags = [f for f in (s.strip() for s in flags.split(",")) if f]
    payload = {
        "profile": record.get("profile_path", ""),
        "target_priority": record.get("target_priority", ""),
        "web_findings": int(record.get("web_findings") or 0),
        "top_hook": record.get("top_hook", ""),
        "flags": flags,
    }
    return json.dumps(payload)


def _source_note(record: dict, run_date: str) -> str:
    priority = record.get("target_priority", "") or "Unknown"
    note = (
        f"Apollo org-scoped people search + people_match ({run_date}); "
        f"Target Priority: {priority}"
    )
    suffix = (record.get("source_note_suffix") or "").strip()
    if suffix:
        note = f"{note}; {suffix}"
    return note


def _is_person(record: dict, config: dict) -> bool:
    """Exclude company+role placeholder rows that --find fanned out."""
    if str(record.get("apollo_status", "")).startswith("expanded"):
        return False
    return bool(_full_name_of(record, config) or record.get("enriched_email") or record.get("apollo_id"))


def build_rows(records: list[dict], config: dict, run_date: str | None = None) -> list[dict]:
    """Return the master-list rows (15 columns each) for all person records."""
    run_date = run_date or date.today().isoformat()
    people = [r for r in records if _is_person(r, config)]

    company_ids: dict[str, int] = {}
    company_seq: dict[str, int] = {}
    rows: list[dict] = []
    for record in people:
        company = _company_of(record, config)
        key = company.lower()
        if key not in company_ids:
            company_ids[key] = len(company_ids) + 1
            company_seq[key] = 0
        company_seq[key] += 1

        full = _full_name_of(record, config)
        first = record.get("enriched_first_name") or _split_name(full)[0]
        last = record.get("enriched_last_name") or _split_name(full)[1]
        person_id = f"{_prefix(company, config)}-{company_seq[key]:03d}"

        rows.append(
            {
                "Company": company,
                "Full Name": full,
                "First Name": first,
                "Last Name": last,
                "LinkedIn URL": record.get("enriched_linkedin", ""),
                "Work Email": record.get("enriched_email", ""),
                "person_id": person_id,
                "company_id": company_ids[key],
                "Apollo Title": record.get("enriched_title", ""),
                "Apollo Seniority": record.get("enriched_seniority", ""),
                "Email Status (Apollo)": record.get("enriched_email_status", ""),
                "Work Phone (Company)": record.get("enriched_company_phone", ""),
                "Source Note": _source_note(record, run_date),
                "Apollo Person ID": record.get("apollo_id", ""),
                "Info dump": _info_dump(record),
            }
        )
    return rows


def export(records: list[dict], config: dict, run_date: str | None = None) -> Path:
    path = ROOT / config["output_csv"]
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = build_rows(records, config, run_date)
    with path.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return path


def from_row(row: dict) -> dict:
    """Map a master-list CSV row back to internal record fields (for resume)."""
    try:
        info = json.loads(row.get("Info dump") or "{}")
    except json.JSONDecodeError:
        info = {}
    return {
        "enriched_company": row.get("Company", ""),
        "enriched_name": row.get("Full Name", ""),
        "enriched_first_name": row.get("First Name", ""),
        "enriched_last_name": row.get("Last Name", ""),
        "enriched_linkedin": row.get("LinkedIn URL", ""),
        "enriched_email": row.get("Work Email", ""),
        "enriched_title": row.get("Apollo Title", ""),
        "enriched_seniority": row.get("Apollo Seniority", ""),
        "enriched_email_status": row.get("Email Status (Apollo)", ""),
        "enriched_company_phone": row.get("Work Phone (Company)", ""),
        "apollo_id": row.get("Apollo Person ID", ""),
        "target_priority": info.get("target_priority", ""),
        "flags": info.get("flags", []),
        "web_findings": info.get("web_findings", 0),
        "top_hook": info.get("top_hook", ""),
        "profile_path": info.get("profile", ""),
    }
