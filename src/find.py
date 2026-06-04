"""Apollo People Search — discover people by company + role.

For target lists that name the companies and roles you want but not the people,
this finds the top matching people per company+title via Apollo's (credit-free)
search and returns new lead rows with name + LinkedIn filled in. The enrich step
reveals their emails afterward.

Search answers "who holds this role at this company?"; enrich answers "what's
this known person's email?". A name-less list needs find first.
"""
from __future__ import annotations

import requests

from .config import field, require_env

PEOPLE_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/api_search"
ORG_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_companies/search"
FIND_PER_COMPANY = 3
REQUEST_TIMEOUT = 30


def _headers(api_key: str) -> dict:
    return {
        "X-Api-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Cache-Control": "no-cache",
    }


def _api_error(action: str, resp) -> SystemExit:
    hint = ""
    if resp.status_code in (401, 403):
        hint = (
            " Access denied. The Apollo search/enrich APIs require a PAID plan "
            "(Professional+) — free plans return API_INACCESSIBLE — and People "
            "Search additionally needs a MASTER API key. Check your plan at "
            "app.apollo.io and recreate the key (master access) in the paid workspace."
        )
    return SystemExit(f"Apollo {action} failed ({resp.status_code}).{hint} {resp.text[:200]}")


def _resolve_org(name: str, api_key: str, cache: dict) -> dict | None:
    """Resolve a company name to an Apollo org {id, domain}; cached per run.

    Returns None only when the company genuinely isn't found (HTTP 200, no
    match). HTTP errors are raised so auth/plan problems aren't hidden.
    """
    if name in cache:
        return cache[name]
    resp = requests.post(
        ORG_SEARCH_URL,
        headers=_headers(api_key),
        json={"q_organization_name": name, "per_page": 1},
        timeout=REQUEST_TIMEOUT,
    )
    if not resp.ok:
        raise _api_error("company search", resp)
    listing = resp.json().get("organizations") or resp.json().get("accounts") or []
    org = None
    if listing:
        org = {"id": listing[0].get("id") or "", "domain": listing[0].get("primary_domain") or ""}
    cache[name] = org
    return org


def _search_people(org: dict | None, title: str, api_key: str) -> list[dict]:
    """Return [{name, title, linkedin_url}] for people matching title at org."""
    if not org or (not org.get("id") and not org.get("domain")):
        return []  # company unidentifiable — skip rather than search the whole world
    body: dict = {
        "person_titles": [title],
        "include_similar_titles": True,
        "page": 1,
        "per_page": FIND_PER_COMPANY,
    }
    if org.get("id"):
        body["organization_ids"] = [org["id"]]
    else:
        body["q_organization_domains_list"] = [org["domain"]]

    resp = requests.post(
        PEOPLE_SEARCH_URL, headers=_headers(api_key), json=body, timeout=REQUEST_TIMEOUT
    )
    if not resp.ok:
        raise _api_error("people search", resp)
    people = resp.json().get("people") or []
    out: list[dict] = []
    for p in people:
        name = p.get("name") or f"{p.get('first_name', '')} {p.get('last_name', '')}".strip()
        if name:
            out.append(
                {
                    "name": name,
                    "title": p.get("title") or "",
                    "linkedin_url": p.get("linkedin_url") or "",
                }
            )
    return out


def find_people(records: list[dict], config: dict, *, verbose: bool = True) -> list[dict]:
    """Fan out company+role rows that lack a name into found-person records.

    Mutates the apollo_status of each processed source row to 'expanded (N)' and
    returns the list of NEW records to append. Rows that already have a name, or
    were already expanded, are left untouched.
    """
    api_key = require_env("APOLLO_API_KEY")
    name_col = config.get("columns", {}).get("name")
    if not name_col:
        raise SystemExit("Find requires a mapped 'name' column to write found names into.")

    org_cache: dict = {}
    new_records: list[dict] = []
    for record in records:
        if field(record, config, "name"):
            continue
        if str(record.get("apollo_status", "")).startswith("expanded"):
            continue
        company = field(record, config, "company")
        title = field(record, config, "role")
        if not company or not title:
            continue

        people = _search_people(_resolve_org(company, api_key, org_cache), title, api_key)
        for person in people:
            found = dict(record)  # carry company, role, location, etc.
            found[name_col] = person["name"]
            found["enriched_title"] = person["title"] or title
            found["enriched_linkedin"] = person["linkedin_url"]
            found["enriched_email"] = ""
            found["enriched_company"] = ""
            found["email_subject"] = ""
            found["email_body"] = ""
            found["gen_status"] = ""
            found["draft_id"] = ""
            found["apollo_status"] = "found"
            new_records.append(found)
        record["apollo_status"] = f"expanded ({len(people)})"
        if verbose:
            print(f"Find: {company} / {title} -> {len(people)} people")

    return new_records
