"""Post-import cleaning pipeline for Old clients (and scoped table sections).

Runs after spreadsheet upload: fix emails, company fields, names, remove junk,
then dedupe — without touching other Master Table sections.
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session

from db.models import Buyer, Contact
from modules.audit import log_action
from modules.buyers import buyer_data_score
from modules import buyers as buyers_module
from modules.leads import (
    _apply_lead_table_scope,
    cleanup_sparse_csv_leads,
    dedupe_leads_table,
)

EMAIL_WRAP_QUOTES = re.compile(r"^['\"`]+|['\"`]+$")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+", re.I)
ZW = re.compile(r"[\u200b\u200c\u200d\ufeff]")
JUNK_NAMES = frozenset({"", "unnamed", "unknown", "n/a", "na", "-", "---"})


def _clean_scalar(value: object | None) -> str:
    if value is None:
        return ""
    text = ZW.sub("", str(value)).replace("\n", " ").strip()
    if re.fullmatch(r"\d+\.0+", text):
        return text.split(".", 1)[0]
    return text


def _normalize_email(value: str) -> tuple[str, bool]:
    raw = _clean_scalar(value)
    if not raw or raw in {"-", "—", "N/A", "n/a"}:
        return "", raw != value
    stripped = EMAIL_WRAP_QUOTES.sub("", raw).strip().strip("'\"`")
    match = EMAIL_RE.search(stripped)
    if not match:
        return "", raw != value
    email = match.group(0).lower()
    return email, email != raw.strip().lower()


def clean_contact_emails(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, Any]:
    """Strip Excel apostrophes and normalize Primary/Secondary Email on contacts."""
    buyers = _apply_lead_table_scope(
        db.query(Buyer),
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
    ).all()
    scanned = 0
    changed = 0
    samples: list[dict[str, Any]] = []

    for buyer in buyers:
        contacts = (
            db.query(Contact)
            .filter(Contact.buyer_id == buyer.id)
            .order_by(Contact.id.asc())
            .all()
        )
        if not contacts:
            continue
        contact = contacts[0]
        scanned += 1
        row_changed = False
        for field in ("email", "secondary_email"):
            before = getattr(contact, field) or ""
            after, fixed = _normalize_email(before)
            if fixed:
                setattr(contact, field, after or None)
                row_changed = True
                if len(samples) < 20:
                    samples.append(
                        {
                            "buyer_id": buyer.id,
                            "field": field,
                            "before": before,
                            "after": after,
                        }
                    )
        if row_changed:
            changed += 1

    if changed:
        db.commit()
    return {"scanned": scanned, "changed": changed, "samples": samples}


def remove_junk_old_client_rows(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, Any]:
    """Move Unnamed / sparse rows to Incomplete Data from Archives — never delete salvage rows."""
    from modules.incomplete_archives import (
        has_salvage_data,
        is_incomplete_archives_source,
        primary_contact,
        relocate_buyer_to_incomplete_archives,
    )

    buyers = _apply_lead_table_scope(
        db.query(Buyer),
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
    ).all()
    relocated: list[dict[str, Any]] = []

    for buyer in buyers:
        if is_incomplete_archives_source(buyer.source):
            continue
        name_key = _clean_scalar(buyer.company_name).lower()
        contact = primary_contact(db, buyer.id)
        sparse_name = name_key in JUNK_NAMES or not name_key
        if not sparse_name and buyers_module.buyer_data_score(db, buyer) >= 12:
            continue
        if sparse_name and not has_salvage_data(buyer, contact):
            continue
        if not sparse_name and not buyers_module.is_sparse_buyer(db, buyer):
            continue
        if relocate_buyer_to_incomplete_archives(
            db, buyer.id, reason="junk_or_sparse_name", commit=False
        ):
            relocated.append(
                {"id": buyer.id, "company_name": buyer.company_name, "sparse_name": sparse_name}
            )

    if relocated:
        db.commit()
    return {"removed_count": 0, "relocated_count": len(relocated), "relocated": relocated[:40]}


def run_post_import_clean(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, Any]:
    """Full post-upload clean for Old clients — safe for existing rows in same section."""
    from modules.buyer_name_repair import repair_location_company_names  # noqa: F401 — optional manual step
    from modules.old_clients_clean import clean_old_clients_company_fields

    scope = {
        "source": source,
        "exclude_source": exclude_source,
        "assigned_to_user_id": assigned_to_user_id,
        "unassigned_only": unassigned_only,
    }

    emails = clean_contact_emails(db, **scope)
    company = clean_old_clients_company_fields(db, **scope)
    # Skip repair_location here — it can web-lookup per row and takes hours on 8k+ Old clients.
    # Use Master Table → Fix names for location-as-company rows in smaller batches.
    names: dict[str, Any] = {
        "skipped": True,
        "reason": "bulk_post_import_skip_web_name_repair",
        "repaired_with_name": 0,
        "relocated_name_empty": 0,
    }
    junk = remove_junk_old_client_rows(db, **scope)
    sparse = cleanup_sparse_csv_leads(db, **scope)
    dedupe = dedupe_leads_table(db, **scope)

    names_fixed = int(names.get("repaired_with_name") or 0) + int(
        names.get("relocated_name_empty") or 0
    )

    summary = {
        "emails_fixed": emails.get("changed", 0),
        "company_fields_fixed": company.get("changed", 0),
        "names_fixed": names_fixed,
        "junk_rows_removed": junk.get("relocated_count", junk.get("removed_count", 0)),
        "empty_rows_removed": sparse.get("relocated_count", sparse.get("removed_count", 0)),
        "duplicates_removed": dedupe.get("removed_count", 0),
        "duplicates_relocated_incomplete": dedupe.get("relocated_count", 0),
    }

    log_action(
        db,
        entity_type="buyer",
        entity_id=0,
        action="old_clients_post_import_cleaned",
        details={"source": source, **summary},
    )

    return {
        "emails": emails,
        "company_fields": company,
        "names": names,
        "junk_removed": junk,
        "sparse_removed": sparse,
        "dedupe": dedupe,
        "summary": summary,
    }
