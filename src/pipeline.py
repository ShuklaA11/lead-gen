"""CLI orchestrator: enrich -> generate -> draft.

The output CSV (config.output_csv) is the single source of truth. Each stage
is independent and resumable: run them together or one at a time, review the
file in between, and re-run safely — finished work is carried forward unless
--force is given.

Usage:
    python -m src.pipeline                 # run all three stages
    python -m src.pipeline --enrich        # just enrichment
    python -m src.pipeline --generate      # just email writing
    python -m src.pipeline --draft         # just Gmail drafts
    python -m src.pipeline --limit 5       # only the first 5 leads (cheap test)
    python -m src.pipeline --force         # redo even completed steps
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from .config import ROOT, field, load_config, read_leads

EXTRA_COLUMNS = [
    "enriched_email",
    "enriched_linkedin",
    "enriched_title",
    "enriched_company",
    "apollo_id",
    "apollo_status",
    "email_subject",
    "email_body",
    "gen_status",
    "draft_id",
]


def _key(row: dict, config: dict) -> str:
    name = field(row, config, "name").lower()
    company = field(row, config, "company").lower()
    return f"{name}|{company}"


def _load_existing(config: dict) -> dict[str, dict]:
    path = ROOT / config["output_csv"]
    if not path.exists():
        return {}
    with path.open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    return {_key(r, config): r for r in rows}


def _write_output(records: list[dict], original_headers: list[str], config: dict) -> None:
    path = ROOT / config["output_csv"]
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = original_headers + [c for c in EXTRA_COLUMNS if c not in original_headers]
    with path.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)


def run(args: argparse.Namespace) -> None:
    config = load_config()
    leads = read_leads(config)
    if args.limit:
        leads = leads[: args.limit]
    original_headers = list(leads[0].keys()) if leads else []
    existing = _load_existing(config)

    # Seed records from input, carrying forward any prior output for each lead.
    records: list[dict] = []
    input_keys: set[str] = set()
    for lead in leads:
        key = _key(lead, config)
        input_keys.add(key)
        record = dict(lead)
        prior = existing.get(key, {})
        for col in EXTRA_COLUMNS:
            record[col] = prior.get(col, "")
        records.append(record)

    # Carry forward output-only rows (e.g. people discovered by a prior --find
    # run) that aren't in the input, so the found set persists across runs.
    for key, row in existing.items():
        if key not in input_keys:
            records.append(dict(row))

    run_all = not (args.find or args.enrich or args.generate or args.draft)

    # --- Stage 0: find people ------------------------------------------------
    if run_all or args.find:
        from .find import find_people

        records.extend(find_people(records, config))
        _write_output(records, original_headers, config)

    # --- Stage 1: enrich -----------------------------------------------------
    if run_all or args.enrich:
        from .enrich import enrich_leads

        name_col = config.get("columns", {}).get("name")
        enrichments = enrich_leads(records, config)
        for record, enr in zip(records, enrichments):
            # Don't clobber a source row that was fanned out by --find.
            if str(record.get("apollo_status", "")).startswith("expanded"):
                continue
            # For found rows (matched by Apollo id), upgrade the partial first
            # name to the revealed full name.
            if name_col and record.get("apollo_id") and enr.get("name"):
                record[name_col] = enr["name"]
            # Prefer fresh match data, but keep values Find already supplied
            # (e.g. LinkedIn) when a match comes back sparse.
            record["enriched_email"] = enr["email"] or record.get("enriched_email", "")
            record["enriched_linkedin"] = enr["linkedin_url"] or record.get("enriched_linkedin", "")
            record["enriched_title"] = enr["title"] or record.get("enriched_title", "")
            record["enriched_company"] = enr["company_enriched"] or record.get("enriched_company", "")
            record["apollo_status"] = enr["apollo_status"]
        _write_output(records, original_headers, config)

    # --- Stage 2: generate ---------------------------------------------------
    if run_all or args.generate:
        from .generate import generate_emails

        # Build the enrichment view each generation needs.
        enr_view = [
            {
                "email": r.get("enriched_email", ""),
                "linkedin_url": r.get("enriched_linkedin", ""),
                "title": r.get("enriched_title", ""),
                "company_enriched": r.get("enriched_company", ""),
            }
            for r in records
        ]
        # Skip rows that already have a body unless --force. Records are
        # lead-like dicts, so they double as the "lead" for generation.
        pending_leads, pending_enr, pending_idx = [], [], []
        for idx, record in enumerate(records):
            if record.get("email_body") and not args.force:
                continue
            pending_leads.append(record)
            pending_enr.append(enr_view[idx])
            pending_idx.append(idx)

        if pending_leads:
            generated = generate_emails(pending_leads, pending_enr, config)
            for idx, gen in zip(pending_idx, generated):
                records[idx]["email_subject"] = gen["subject"]
                records[idx]["email_body"] = gen["body"]
                records[idx]["gen_status"] = gen["gen_status"]
        else:
            print("Generate: nothing to do (all leads already written; use --force).")
        _write_output(records, original_headers, config)

    # --- Stage 3: draft ------------------------------------------------------
    if run_all or args.draft:
        from .deliver import create_drafts

        items = [
            {
                "email": r.get("enriched_email", ""),
                "subject": r.get("email_subject", ""),
                "body": r.get("email_body", ""),
                "existing_draft_id": "" if args.force else r.get("draft_id", ""),
            }
            for r in records
        ]
        draft_ids = create_drafts(items, config)
        for record, draft_id in zip(records, draft_ids):
            record["draft_id"] = draft_id
        _write_output(records, original_headers, config)

    _summary(records)


def _summary(records: list[dict]) -> None:
    emails = sum(1 for r in records if r.get("enriched_email"))
    bodies = sum(1 for r in records if r.get("email_body"))
    drafts = sum(1 for r in records if r.get("draft_id"))
    print(
        f"\nDone. {len(records)} leads | {emails} with email | "
        f"{bodies} emails written | {drafts} drafts created."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Lead enrichment + outreach pipeline.")
    parser.add_argument("--find", action="store_true", help="find people by company+role (Apollo search)")
    parser.add_argument("--enrich", action="store_true", help="run Apollo enrichment")
    parser.add_argument("--generate", action="store_true", help="write outreach emails")
    parser.add_argument("--draft", action="store_true", help="create Gmail drafts")
    parser.add_argument("--force", action="store_true", help="redo completed steps")
    parser.add_argument("--limit", type=int, default=0, help="process only first N leads")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
