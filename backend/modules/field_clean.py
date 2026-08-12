"""Shared normalization for emails and phones on import / synthesis / post-clean."""

from __future__ import annotations

import re

EMAIL_WRAP_QUOTES = re.compile(r"^['\"`]+|['\"`]+$")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+", re.I)
ZW = re.compile(r"[\u200b\u200c\u200d\ufeff]")
PHONE_DIGITS_RE = re.compile(r"\D")


def clean_scalar(value: object | None) -> str:
    if value is None:
        return ""
    text = ZW.sub("", str(value)).replace("\n", " ").strip()
    if re.fullmatch(r"\d+\.0+", text):
        return text.split(".", 1)[0]
    return text


def normalize_email(value: str | None) -> tuple[str, bool]:
    """Strip Excel apostrophes/quotes and return (email, changed)."""
    raw = clean_scalar(value)
    if not raw or raw in {"-", "—", "N/A", "n/a"}:
        return "", raw != (value or "").strip()
    stripped = EMAIL_WRAP_QUOTES.sub("", raw).strip().strip("'\"`")
    match = EMAIL_RE.search(stripped)
    if not match:
        return "", raw != (value or "").strip()
    email = match.group(0).lower()
    original = clean_scalar(value).lower()
    return email, email != original


def normalize_email_or_empty(value: str | None) -> str:
    email, _ = normalize_email(value)
    return email


def email_dedupe_key(value: str | None) -> str | None:
    email = normalize_email_or_empty(value)
    return email or None


def phone_dedupe_key(value: str | None) -> str | None:
    digits = PHONE_DIGITS_RE.sub("", value or "")
    if len(digits) < 8 or len(digits) > 15:
        return None
    if len(set(digits)) <= 2:
        return None
    return digits
