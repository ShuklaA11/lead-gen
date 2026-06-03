"""Per-lead outreach email generation via the Claude API.

The product pitch, sender identity, and writing rules are identical for every
lead, so they go in a cached system prompt prefix. Only the per-lead details
and the segment angle change between calls, keeping cost low across a big list.
"""
from __future__ import annotations

import json
import re

from anthropic import Anthropic

from .config import field, require_env

_SYSTEM_TEMPLATE = """You write short, personalized B2B cold outreach emails.

WHAT WE OFFER:
{product}

SENDER: {sender_name} <{sender_email}>

RULES:
- Tone: {tone}.
- Hard limit: {word_limit} words in the body. Shorter is better.
- Open with a specific, genuine reason for reaching out to THIS person given
  their role and company. No flattery, no "I came across your profile".
- One clear value proposition tied to the segment angle you are given.
- One soft call to action.{booking}
- Do NOT include a signature, sign-off name, or "Best regards" line — that is
  appended automatically. End on the last sentence of the body.
- No placeholders like [Name] or [Company]; use the real values provided.

Respond with ONLY a JSON object: {{"subject": "...", "body": "..."}}"""


def _system_prompt(config: dict) -> str:
    gen = config.get("generation", {})
    sender = config.get("sender", {})
    booking = ""
    if sender.get("booking_link"):
        booking = (
            f"\n- If proposing a call, you may offer this link: "
            f"{sender['booking_link']}"
        )
    return _SYSTEM_TEMPLATE.format(
        product=config.get("product", {}).get("description", "").strip(),
        sender_name=sender.get("name", ""),
        sender_email=sender.get("email", ""),
        tone=gen.get("tone", "warm, concise, professional"),
        word_limit=gen.get("word_limit", 120),
        booking=booking,
    )


def _angle_for(category: str, config: dict) -> str:
    segments = config.get("segments", {}) or {}
    entry = segments.get(category)
    if entry and entry.get("angle"):
        return entry["angle"].strip()
    return (config.get("default_angle") or "").strip()


def _parse(text: str) -> dict:
    """Extract {subject, body} from the model response, defensively."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
    return {"subject": "", "body": text.strip()}


def _with_signature(body: str, config: dict) -> str:
    signature = config.get("sender", {}).get("signature", "").strip()
    body = body.strip()
    if signature:
        return f"{body}\n\n{signature}"
    return body


def generate_emails(
    leads: list[dict],
    enrichments: list[dict],
    config: dict,
    *,
    verbose: bool = True,
) -> list[dict]:
    """Return {subject, body, gen_status} per lead, aligned to input order.

    Leads without an enriched email are skipped (no point writing to no one).
    """
    require_env("ANTHROPIC_API_KEY")
    client = Anthropic()  # reads ANTHROPIC_API_KEY from env
    model = config.get("generation", {}).get("model", "claude-opus-4-8")
    max_tokens = int(config.get("generation", {}).get("max_tokens", 1024))
    system = [
        {
            "type": "text",
            "text": _system_prompt(config),
            "cache_control": {"type": "ephemeral"},
        }
    ]

    results: list[dict] = []
    for i, (lead, enr) in enumerate(zip(leads, enrichments)):
        if not enr.get("email"):
            results.append({"subject": "", "body": "", "gen_status": "no_email"})
            continue

        name = field(lead, config, "name")
        company = field(lead, config, "company") or enr.get("company_enriched", "")
        category = field(lead, config, "category")
        title = enr.get("title") or field(lead, config, "role")
        angle = _angle_for(category, config)

        user_msg = (
            f"Recipient: {name}\n"
            f"Title: {title}\n"
            f"Company: {company}\n"
            f"Segment: {category or 'general'}\n"
            f"Segment angle to use: {angle}\n\n"
            f"Write the email."
        )
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        parsed = _parse(resp.content[0].text)
        results.append(
            {
                "subject": (parsed.get("subject") or "").strip(),
                "body": _with_signature(parsed.get("body", ""), config),
                "gen_status": "generated",
            }
        )
        if verbose:
            print(f"Generated {i + 1}/{len(leads)}: {name}")

    return results
