"""Config + environment loading and CSV column auto-detection.

Keeps all "where does X come from" logic in one place so the pipeline stages
stay focused on their own job.
"""
from __future__ import annotations

import csv
import os
from pathlib import Path

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.yaml"

# Common header spellings -> canonical concept. Lowercased compare.
COLUMN_ALIASES = {
    "name": ["name", "full name", "full_name", "contact", "contact name"],
    "company": ["company", "organization", "organisation", "employer", "account"],
    "role": ["role", "title", "job title", "position"],
    "category": ["category", "segment", "type", "list", "group"],
    "linkedin": ["linkedin", "linkedin url", "linkedin_url", "li", "profile"],
}


def load_env() -> None:
    """Load .env into the process environment (idempotent)."""
    load_dotenv(ROOT / ".env")


def require_env(name: str) -> str:
    load_env()
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(
            f"Missing {name}. Copy .env.example to .env and paste your key."
        )
    return value


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        raise SystemExit(
            "No config.yaml found. Run `python -m src.setup` to create one."
        )
    with CONFIG_PATH.open() as fh:
        return yaml.safe_load(fh) or {}


def read_headers(csv_path: str | Path) -> list[str]:
    with Path(csv_path).open(newline="") as fh:
        reader = csv.reader(fh)
        return next(reader, [])


def detect_columns(headers: list[str]) -> dict[str, str]:
    """Map canonical concept -> actual header, best-effort.

    Returns only concepts we could match; the caller decides what's required.
    """
    detected: dict[str, str] = {}
    lowered = {h.lower().strip(): h for h in headers}
    for concept, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in lowered:
                detected[concept] = lowered[alias]
                break
    return detected


def read_leads(config: dict) -> list[dict]:
    """Read the input CSV as a list of dict rows (raw, original headers)."""
    path = ROOT / config["input_csv"]
    if not path.exists():
        raise SystemExit(f"Input CSV not found: {path}")
    with path.open(newline="") as fh:
        return list(csv.DictReader(fh))


def field(row: dict, config: dict, concept: str) -> str:
    """Pull a canonical concept's value from a raw row via the column mapping."""
    header = config.get("columns", {}).get(concept)
    if not header:
        return ""
    return (row.get(header) or "").strip()
