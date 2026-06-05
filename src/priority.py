"""Rule-based target prioritization and verification flags.

Deterministic (no LLM): a lead's priority and flags are decided from its title
and Apollo seniority via a configurable keyword map. Keeping this separate from
the research stage means the High/Med/Low call is reproducible and cheap.
"""
from __future__ import annotations

# Defaults used when config.yaml omits a `priority` / `flags` section. Lowercase
# compares throughout.
DEFAULT_HIGH_KEYWORDS = ["lending", "credit", "risk", "consumer banking"]
DEFAULT_HIGH_SENIORITIES = ["c_suite", "owner", "founder", "partner"]
DEFAULT_MED_SENIORITIES = ["vp", "director", "head"]
DEFAULT_RETIRED_KEYWORDS = ["retired", "former"]

HIGH = "High"
MED = "Med"
LOW = "Low"


def _cfg_list(config: dict, section: str, key: str, default: list[str]) -> list[str]:
    values = (config.get(section) or {}).get(key)
    if not values:
        return default
    return [str(v).lower().strip() for v in values]


def target_priority(title: str, seniority: str, config: dict) -> str:
    """Return 'High' | 'Med' | 'Low' for a lead.

    High wins on either a title keyword (e.g. "lending") or a high seniority
    (e.g. c_suite). Otherwise mid seniorities are Med; everything else is Low.
    """
    title_l = (title or "").lower()
    seniority_l = (seniority or "").lower().strip()

    high_keywords = _cfg_list(config, "priority", "high_keywords", DEFAULT_HIGH_KEYWORDS)
    high_seniorities = _cfg_list(config, "priority", "high_seniorities", DEFAULT_HIGH_SENIORITIES)
    med_seniorities = _cfg_list(config, "priority", "med_seniorities", DEFAULT_MED_SENIORITIES)

    if any(kw in title_l for kw in high_keywords) or seniority_l in high_seniorities:
        return HIGH
    if seniority_l in med_seniorities:
        return MED
    return LOW


def flags(title: str, config: dict) -> list[str]:
    """Return verification flags for a lead (e.g. ['retired'])."""
    title_l = (title or "").lower()
    retired_keywords = _cfg_list(config, "flags", "retired_keywords", DEFAULT_RETIRED_KEYWORDS)
    found: list[str] = []
    if any(kw in title_l for kw in retired_keywords):
        found.append("retired")
    return found
