"""Per-person web research via Claude's native web_search tool.

One Claude call per person. The web_search tool is a *server* tool — Anthropic
runs the search loop inside the single API call and returns the final answer with
citations — so we don't manage a manual tool loop. The model researches the
person and returns a JSON profile; we persist the full profile to disk and lift a
few summary fields (top_hook, web_findings, target_priority, flags) onto the
record. Research-derived priority/flags override the rule-based fallback.
"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

from anthropic import Anthropic

from .config import ROOT, field, require_env

WEB_SEARCH_TOOL = "web_search_20250305"

_SYSTEM = """You are a meticulous B2B sales researcher. Given one person, use web
search to find specific, recent, verifiable facts about them and their work, then
decide how good a fit they are for the campaign described below.

CAMPAIGN BRIEF (judge target_priority against this):
{brief}

Rules:
- Search for the person by name + company + role. Prefer recent, specific,
  attributable facts (talks, podcasts, posts, launches, quotes, role changes).
- target_priority is High / Med / Low: how well this person fits the campaign
  brief. A retired/former or clearly mis-targeted contact is Low.
- top_hook: ONE concrete, verifiable outreach angle tied to a real finding —
  specific enough that it could only be written about THIS person. No flattery,
  no generic "I saw your profile".
- flags: short tokens for caveats, e.g. "retired" if their current role is
  former/retired, "name-uncertain" if the real name is ambiguous. [] if none.
- note: optional one-line verification caveat for a human (or "").

Respond with ONLY a JSON object:
{{"top_hook": "...", "target_priority": "High|Med|Low", "flags": [...],
  "summary": "...", "note": "...",
  "findings": [{{"title": "...", "url": "...", "note": "..."}}]}}"""


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "unknown"


def _brief(config: dict) -> str:
    research = config.get("research", {}) or {}
    if research.get("campaign_brief"):
        return research["campaign_brief"].strip()
    # Fall back to the product pitch so the stage still has targeting context.
    return (config.get("product", {}) or {}).get("description", "").strip() or (
        "No campaign brief configured; judge fit by general seniority and "
        "relevance to a B2B outreach about our product."
    )


def _collect(content: list) -> tuple[str, int]:
    """Return (final text, distinct source-url count) from response blocks."""
    text_parts: list[str] = []
    urls: set[str] = set()
    for block in content:
        btype = getattr(block, "type", "")
        if btype == "text":
            text_parts.append(getattr(block, "text", ""))
        elif btype == "web_search_tool_result":
            for item in getattr(block, "content", []) or []:
                url = getattr(item, "url", None) or (item.get("url") if isinstance(item, dict) else None)
                if url:
                    urls.add(url)
    return "".join(text_parts), len(urls)


def _parse(text: str) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
    return {}


def _suffix(parsed: dict) -> str:
    """Build the Source Note suffix from research flags + note."""
    parts: list[str] = []
    if "retired" in (parsed.get("flags") or []):
        parts.append("[RETIRED — remove/deprioritize]")
    note = (parsed.get("note") or "").strip()
    if note:
        parts.append(note)
    return "; ".join(parts)


def _profiles_dir(config: dict) -> Path:
    rel = (config.get("research", {}) or {}).get("profiles_dir", "enrichment/profiles")
    return ROOT / rel


def _already_done(record: dict, config: dict) -> bool:
    path_rel = record.get("profile_path", "")
    return bool(record.get("top_hook")) and bool(path_rel) and (ROOT / path_rel).exists()


def research_leads(
    records: list[dict],
    config: dict,
    *,
    force: bool = False,
    verbose: bool = True,
) -> None:
    """Research each person in place, writing profiles and updating records."""
    require_env("ANTHROPIC_API_KEY")
    client = Anthropic()
    rcfg = config.get("research", {}) or {}
    model = rcfg.get("model", "claude-opus-4-8")
    max_searches = int(rcfg.get("max_searches", 5))
    max_tokens = int(rcfg.get("max_tokens", 4096))
    system = _SYSTEM.format(brief=_brief(config))
    tools = [{"type": WEB_SEARCH_TOOL, "name": "web_search", "max_uses": max_searches}]
    profiles_dir = _profiles_dir(config)

    targets = [
        r
        for r in records
        if not str(r.get("apollo_status", "")).startswith("expanded")
        and (r.get("enriched_name") or field(r, config, "name"))
    ]
    todo = targets if force else [r for r in targets if not _already_done(r, config)]
    if verbose:
        print(f"Research: {len(targets)} people, {len(todo)} to do "
              f"({len(targets) - len(todo)} already have profiles).")

    for i, record in enumerate(todo):
        name = record.get("enriched_name") or field(record, config, "name")
        company = record.get("enriched_company") or field(record, config, "company")
        title = record.get("enriched_title") or field(record, config, "role")
        linkedin = record.get("enriched_linkedin", "")
        user_msg = (
            f"Person: {name}\nTitle: {title}\nCompany: {company}\n"
            f"LinkedIn: {linkedin or '(unknown)'}\n\nResearch them and respond with the JSON."
        )
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            tools=tools,
            messages=[{"role": "user", "content": user_msg}],
        )
        text, url_count = _collect(resp.content)
        parsed = _parse(text)
        findings = parsed.get("findings") or []
        web_findings = len(findings) or url_count

        profile = {
            "name": name,
            "title": title,
            "company": company,
            "linkedin": linkedin,
            "generated_at": date.today().isoformat(),
            "web_findings": web_findings,
            "target_priority": parsed.get("target_priority", ""),
            "top_hook": parsed.get("top_hook", ""),
            "flags": parsed.get("flags", []),
            "summary": parsed.get("summary", ""),
            "findings": findings,
        }
        profiles_dir.mkdir(parents=True, exist_ok=True)
        rel_path = f"{profiles_dir.relative_to(ROOT)}/{_slug(name)}.json"
        (ROOT / rel_path).write_text(json.dumps(profile, indent=2))

        # Lift summary fields onto the record; research overrides the fallback.
        record["profile_path"] = rel_path
        record["web_findings"] = web_findings
        record["top_hook"] = parsed.get("top_hook", "")
        if parsed.get("target_priority"):
            record["target_priority"] = parsed["target_priority"]
        if "flags" in parsed:
            record["flags"] = parsed["flags"]
        record["source_note_suffix"] = _suffix(parsed)
        if verbose:
            print(f"  [{i + 1}/{len(todo)}] {name}: {web_findings} findings, "
                  f"priority {record['target_priority']}")
