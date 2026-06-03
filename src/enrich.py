"""Apollo people enrichment.

Resolves email + LinkedIn + verified title for each lead via Apollo's
bulk_match endpoint (up to 10 per call). Every match is cached to disk keyed
by name+company, so re-runs never spend Apollo credits twice.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import requests

from .config import ROOT, field, require_env

BULK_MATCH_URL = "https://api.apollo.io/api/v1/people/bulk_match"
CACHE_DIR = ROOT / "data" / "cache"
NO_MATCH = {"_no_match": True}
REQUEST_TIMEOUT = 30
PAUSE_BETWEEN_BATCHES = 1.0  # seconds, gentle on Apollo rate limits


def _cache_key(name: str, company: str) -> str:
    raw = f"{name.lower().strip()}|{company.lower().strip()}"
    return hashlib.sha1(raw.encode()).hexdigest()


def _cache_path(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


def _load_cached(key: str) -> dict | None:
    path = _cache_path(key)
    if path.exists():
        return json.loads(path.read_text())
    return None


def _save_cached(key: str, person: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(key).write_text(json.dumps(person))


def _split_name(name: str) -> tuple[str, str]:
    parts = name.split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _detail(name: str, company: str, linkedin: str) -> dict:
    first, last = _split_name(name)
    detail: dict = {"name": name}
    if first:
        detail["first_name"] = first
    if last:
        detail["last_name"] = last
    if company:
        detail["organization_name"] = company
    if linkedin:
        detail["linkedin_url"] = linkedin
    return detail


def _extract(person: dict) -> dict:
    """Pull the fields we care about out of an Apollo person object."""
    org = person.get("organization") or {}
    return {
        "email": person.get("email") or "",
        "linkedin_url": person.get("linkedin_url") or "",
        "title": person.get("title") or "",
        "company_enriched": person.get("organization_name") or org.get("name") or "",
        "apollo_status": "matched" if person.get("email") else "no_email",
    }


def _empty() -> dict:
    return {
        "email": "",
        "linkedin_url": "",
        "title": "",
        "company_enriched": "",
        "apollo_status": "no_match",
    }


def _call_apollo(details: list[dict], api_key: str, reveal: bool) -> list[dict | None]:
    """POST one batch (<=10) and return a list aligned to `details`."""
    resp = requests.post(
        BULK_MATCH_URL,
        headers={
            "X-Api-Key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Cache-Control": "no-cache",
        },
        json={"details": details, "reveal_personal_emails": reveal},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    # Apollo has used "matches" historically; be tolerant of alternatives.
    people = (
        data.get("matches")
        or data.get("contacts")
        or data.get("people")
        or []
    )
    # Pad/truncate so the result lines up with the input order.
    people = list(people) + [None] * (len(details) - len(people))
    return people[: len(details)]


def enrich_leads(leads: list[dict], config: dict, *, verbose: bool = True) -> list[dict]:
    """Return one enrichment dict per lead, in the same order as `leads`."""
    api_key = require_env("APOLLO_API_KEY")
    reveal = config.get("apollo", {}).get("reveal_personal_emails", True)
    batch_size = min(int(config.get("apollo", {}).get("batch_size", 10)), 10)

    results: list[dict | None] = [None] * len(leads)
    pending: list[tuple[int, dict, str]] = []  # (index, detail, cache_key)

    # First pass: serve from cache, queue the rest.
    for i, lead in enumerate(leads):
        name = field(lead, config, "name")
        company = field(lead, config, "company")
        if not name:
            results[i] = _empty()
            continue
        key = _cache_key(name, company)
        cached = _load_cached(key)
        if cached is not None:
            results[i] = _empty() if cached.get("_no_match") else _extract(cached)
            continue
        linkedin = field(lead, config, "linkedin")
        pending.append((i, _detail(name, company, linkedin), key))

    if verbose:
        cached_count = len(leads) - len(pending)
        print(f"Apollo: {cached_count} from cache, {len(pending)} to fetch.")

    # Second pass: fetch uncached leads in batches of <=10.
    for start in range(0, len(pending), batch_size):
        batch = pending[start : start + batch_size]
        details = [d for _, d, _ in batch]
        people = _call_apollo(details, api_key, reveal)
        for (idx, _, key), person in zip(batch, people):
            if person:
                _save_cached(key, person)
                results[idx] = _extract(person)
            else:
                _save_cached(key, NO_MATCH)
                results[idx] = _empty()
        if verbose:
            print(f"Apollo: fetched {min(start + batch_size, len(pending))}/{len(pending)}")
        if start + batch_size < len(pending):
            time.sleep(PAUSE_BETWEEN_BATCHES)

    return [r if r is not None else _empty() for r in results]
