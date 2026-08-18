"""Resolve email/WhatsApp salutation names — skip placeholder contact labels."""

from __future__ import annotations

_PLACEHOLDER_CONTACT_NAMES = frozenset(
    {
        "",
        "general contact",
        "contact",
        "n/a",
        "na",
        "-",
        "unknown",
        "sir/madam",
        "sir",
        "madam",
    }
)


def is_real_contact_name(name: str | None) -> bool:
    trimmed = (name or "").strip()
    if not trimmed:
        return False
    return trimmed.lower() not in _PLACEHOLDER_CONTACT_NAMES


def resolve_salutation_name(
    *,
    contact_name: str | None = None,
    company_name: str | None = None,
) -> str:
    """Contact person first, else company name, else empty (use bare 'Dear,')."""
    contact = (contact_name or "").strip()
    if is_real_contact_name(contact):
        return contact
    company = (company_name or "").strip()
    return company
