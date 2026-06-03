"""Interactive setup wizard.

Reads your input CSV, auto-detects the column mapping and the segments present
in the data, then prompts for the campaign content and sender identity. Writes
config.yaml. Never touches API keys — those go in .env (see .env.example).

    python -m src.setup
"""
from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path

import yaml

from .config import CONFIG_PATH, ROOT, detect_columns, read_headers

DEFAULT_INPUT = "data/input.csv"


def _ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer or default


def _ask_multiline(prompt: str) -> str:
    print(f"{prompt} (end with a blank line):")
    lines: list[str] = []
    while True:
        line = input()
        if not line:
            break
        lines.append(line)
    return "\n".join(lines)


def _resolve_input_csv() -> Path:
    path_str = _ask("Path to your input CSV", DEFAULT_INPUT)
    path = (ROOT / path_str) if not Path(path_str).is_absolute() else Path(path_str)
    while not path.exists():
        print(f"  Not found: {path}")
        path_str = _ask("Path to your input CSV")
        path = (ROOT / path_str) if not Path(path_str).is_absolute() else Path(path_str)
    return path


def _confirm_columns(headers: list[str]) -> dict[str, str]:
    detected = detect_columns(headers)
    print("\nDetected column mapping (press Enter to accept, or type a header):")
    print(f"  Available headers: {', '.join(headers)}")
    columns: dict[str, str] = {}
    for concept in ["name", "company", "role", "category", "linkedin"]:
        guess = detected.get(concept, "")
        value = _ask(f"  {concept}", guess)
        if value:
            columns[concept] = value
    return columns


def _distinct_categories(path: Path, category_header: str) -> list[str]:
    if not category_header:
        return []
    with path.open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    counts = Counter((r.get(category_header) or "").strip() for r in rows)
    counts.pop("", None)
    return [c for c, _ in counts.most_common()]


def _input_csv_relpath(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main() -> None:
    print("=== Lead outreach setup ===\n")
    if CONFIG_PATH.exists():
        if _ask("config.yaml exists. Overwrite? (y/N)", "N").lower() != "y":
            print("Aborted.")
            return

    input_path = _resolve_input_csv()
    headers = read_headers(input_path)
    columns = _confirm_columns(headers)

    print("\n--- What you're offering ---")
    product = _ask_multiline("Describe your product/offer in 1-2 sentences")

    print("\n--- Sender identity ---")
    sender_name = _ask("Your name")
    sender_email = _ask("From email")
    signature = _ask_multiline("Email signature")
    booking_link = _ask("Booking/demo link (optional)")

    categories = _distinct_categories(input_path, columns.get("category", ""))
    segments: dict[str, dict] = {}
    if categories:
        print(f"\n--- Segment angles ({len(categories)} found in '{columns['category']}') ---")
        print("For each segment, give the hook for why THAT audience should care.")
        for category in categories:
            angle = _ask_multiline(f"Angle for segment '{category}'")
            segments[category] = {"angle": angle}
    else:
        print("\nNo category column / values found — using a single default angle.")

    default_angle = _ask_multiline(
        "Default angle (used for leads with no/unknown segment)"
    )

    config = {
        "input_csv": _input_csv_relpath(input_path),
        "output_csv": "data/enriched.csv",
        "columns": columns,
        "product": {"description": product},
        "sender": {
            "name": sender_name,
            "email": sender_email,
            "signature": signature,
            "booking_link": booking_link,
        },
        "segments": segments,
        "default_angle": default_angle,
        "generation": {
            "model": "claude-opus-4-8",
            "max_tokens": 1024,
            "tone": "warm, concise, professional, not salesy",
            "word_limit": 120,
        },
        "apollo": {"reveal_personal_emails": True, "batch_size": 10},
    }

    with CONFIG_PATH.open("w") as fh:
        yaml.safe_dump(config, fh, sort_keys=False, default_flow_style=False)

    print(f"\nWrote {CONFIG_PATH.relative_to(ROOT)}.")
    print("Next:")
    print("  1. Copy .env.example to .env and paste your Apollo + Anthropic keys.")
    print("  2. Add credentials.json for Gmail (see README 'Gmail setup').")
    print("  3. Run: python -m src.pipeline --enrich --limit 5   (cheap test)")


if __name__ == "__main__":
    main()
