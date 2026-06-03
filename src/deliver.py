"""Gmail draft creation via the Gmail API.

Creates a draft (never sends) per lead so you review before anything goes out.
First run opens a browser for a one-time OAuth consent; the token is cached in
token.json for subsequent runs.
"""
from __future__ import annotations

import base64
from email.message import EmailMessage
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from .config import ROOT

# Compose scope is enough to create/manage drafts without full mailbox access.
SCOPES = ["https://www.googleapis.com/auth/gmail.compose"]
CREDENTIALS_PATH = ROOT / "credentials.json"
TOKEN_PATH = ROOT / "token.json"


def _get_service():
    if not CREDENTIALS_PATH.exists():
        raise SystemExit(
            "Missing credentials.json (Google OAuth client). See the README "
            "'Gmail setup' section for how to create one."
        )
    creds: Credentials | None = None
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                str(CREDENTIALS_PATH), SCOPES
            )
            creds = flow.run_local_server(port=0)
        TOKEN_PATH.write_text(creds.to_json())
    return build("gmail", "v1", credentials=creds)


def _raw_message(to: str, subject: str, body: str, sender_email: str) -> str:
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    if sender_email:
        msg["From"] = sender_email
    msg.set_content(body)
    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


def create_drafts(
    items: list[dict],
    config: dict,
    *,
    verbose: bool = True,
) -> list[str]:
    """Create a Gmail draft per item; return a draft_id (or "") per item.

    Each item: {email, subject, body, existing_draft_id}. Items with an
    existing draft_id or no email are skipped (returns the existing id / "").
    """
    sender_email = config.get("sender", {}).get("email", "")
    service = None
    out: list[str] = []
    for i, item in enumerate(items):
        if item.get("existing_draft_id"):
            out.append(item["existing_draft_id"])
            continue
        if not item.get("email") or not item.get("body"):
            out.append("")
            continue
        if service is None:  # defer auth until we actually have something to send
            service = _get_service()
        raw = _raw_message(
            item["email"], item.get("subject", ""), item["body"], sender_email
        )
        draft = (
            service.users()
            .drafts()
            .create(userId="me", body={"message": {"raw": raw}})
            .execute()
        )
        out.append(draft["id"])
        if verbose:
            print(f"Draft {i + 1}/{len(items)} created for {item['email']}")
    return out
