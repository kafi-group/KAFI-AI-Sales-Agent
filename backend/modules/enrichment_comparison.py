"""Module for comparing AI-enriched spreadsheet files against Sales Agent DB contacts.

Provides read-only gap reports and safe-fill merges (only populating missing/blank fields,
preserving existing non-empty DB values 100%).
"""

from __future__ import annotations

import io
from typing import Any
import pandas as pd
from sqlalchemy.orm import Session
from db.models import Buyer, AppUser
from modules.buyers import _normalize_name, _dedupe_domain

COMPARE_COLUMNS = [
    ("company_name", "Company Name"),
    ("contact_name", "Contact Person / Name"),
    ("designation", "Designation / Title"),
    ("email", "Email Address #1"),
    ("secondary_email", "Email Address #2"),
    ("phone", "Phone Number #1"),
    ("secondary_phone", "Phone Number #2 / Mobile"),
    ("website_url", "Website URL"),
    ("country", "Country"),
    ("city", "City"),
    ("address", "Address"),
    ("linkedin_url", "LinkedIn URL"),
    ("facebook_url", "Facebook URL"),
    ("instagram_url", "Instagram URL"),
    ("remarks", "Remarks / Notes"),
]


def _parse_uploaded_file(file_content: bytes, filename: str) -> list[dict[str, Any]]:
    """Parse uploaded bytes into a list of row dicts."""
    fname = filename.lower()
    if fname.endswith(".csv"):
        df = pd.read_csv(io.BytesIO(file_content), dtype=str).fillna("")
    elif fname.endswith((".xlsx", ".xls", ".xlsm")):
        df = pd.read_excel(io.BytesIO(file_content), dtype=str).fillna("")
    else:
        raise ValueError("Unsupported file format. Please upload an Excel (.xlsx) or CSV file.")

    rows = df.to_dict(orient="records")
    normalized_rows = []
    for r in rows:
        norm = {}
        for k, v in r.items():
            k_clean = str(k).strip().lower().replace(" ", "_").replace("#", "")
            val_clean = str(v).strip() if v is not None else ""
            if val_clean in ("nan", "none", "null"):
                val_clean = ""
            norm[k_clean] = val_clean
            norm[str(k).strip()] = val_clean

        company = (
            norm.get("company_name")
            or norm.get("company")
            or norm.get("buyer_name")
            or norm.get("name")
            or ""
        )
        contact = (
            norm.get("contact_name")
            or norm.get("contact_person")
            or norm.get("person_name")
            or norm.get("contact")
            or ""
        )
        designation = (
            norm.get("designation")
            or norm.get("title")
            or norm.get("job_title")
            or norm.get("role")
            or ""
        )
        email1 = (
            norm.get("email")
            or norm.get("email_address")
            or norm.get("email_1")
            or norm.get("primary_email")
            or ""
        )
        email2 = (
            norm.get("secondary_email")
            or norm.get("email_2")
            or norm.get("alternate_email")
            or ""
        )
        phone1 = (
            norm.get("phone")
            or norm.get("phone_number")
            or norm.get("mobile")
            or norm.get("contact_1")
            or ""
        )
        phone2 = (
            norm.get("secondary_phone")
            or norm.get("secondary_mobile")
            or norm.get("contact_2")
            or norm.get("phone_2")
            or ""
        )
        website = (
            norm.get("website_url")
            or norm.get("website")
            or norm.get("domain")
            or norm.get("url")
            or ""
        )
        country = norm.get("country") or norm.get("location") or ""
        city = norm.get("city") or ""
        address = norm.get("address") or norm.get("street") or ""
        linkedin = norm.get("linkedin_url") or norm.get("linkedin") or ""
        facebook = norm.get("facebook_url") or norm.get("facebook") or ""
        instagram = norm.get("instagram_url") or norm.get("instagram") or ""
        remarks = norm.get("remarks") or norm.get("notes") or norm.get("comment") or ""

        row_dict = {
            "company_name": company,
            "contact_name": contact,
            "designation": designation,
            "email": email1,
            "secondary_email": email2,
            "phone": phone1,
            "secondary_phone": phone2,
            "website_url": website,
            "country": country,
            "city": city,
            "address": address,
            "linkedin_url": linkedin,
            "facebook_url": facebook,
            "instagram_url": instagram,
            "remarks": remarks,
            "_raw": r,
        }
        normalized_rows.append(row_dict)
    return normalized_rows


def generate_enrichment_comparison_report(
    db: Session,
    *,
    file_content: bytes,
    filename: str,
    user_id: int | None = None,
    table_source: str = "master_table",
) -> dict[str, Any]:
    """Read-only analysis comparing uploaded enriched file against Sales Agent contacts."""
    uploaded_rows = _parse_uploaded_file(file_content, filename)

    query = db.query(Buyer)
    if table_source == "old_clients":
        query = query.filter(Buyer.source == "old_clients")
    else:
        query = query.filter(Buyer.source != "old_clients")

    if user_id is not None:
        query = query.filter(Buyer.assigned_to_user_id == user_id)
        user_obj = db.query(AppUser).filter(AppUser.id == user_id).first()
        user_name = user_obj.full_name if user_obj else f"User #{user_id}"
    else:
        user_name = "All Assigned Contacts"

    db_buyers = query.all()
    db_total_contacts = len(db_buyers)

    by_name = {}
    by_domain = {}
    by_email = {}
    by_phone = {}

    for buyer in db_buyers:
        if buyer.company_name:
            by_name[_normalize_name(buyer.company_name)] = buyer
        if buyer.website_url:
            dom = _dedupe_domain(buyer.website_url)
            if dom:
                by_domain[dom] = buyer
        if buyer.email:
            by_email[buyer.email.strip().lower()] = buyer
        if buyer.phone:
            by_phone[buyer.phone.strip()] = buyer

        for c in buyer.contacts or []:
            if c.email:
                by_email[c.email.strip().lower()] = buyer
            if c.phone:
                by_phone[c.phone.strip()] = buyer

    matched_pairs: list[tuple[dict[str, Any], Buyer]] = []
    unmatched_rows: list[dict[str, Any]] = []

    for row in uploaded_rows:
        comp_name = row.get("company_name") or ""
        domain = _dedupe_domain(row.get("website_url"))
        email = (row.get("email") or "").strip().lower()
        phone = (row.get("phone") or "").strip()

        matched_buyer = None
        if comp_name and _normalize_name(comp_name) in by_name:
            matched_buyer = by_name[_normalize_name(comp_name)]
        elif domain and domain in by_domain:
            matched_buyer = by_domain[domain]
        elif email and email in by_email:
            matched_buyer = by_email[email]
        elif phone and phone in by_phone:
            matched_buyer = by_phone[phone]

        if matched_buyer:
            matched_pairs.append((row, matched_buyer))
        else:
            unmatched_rows.append(row)

    column_analysis = []
    total_potential_new_fills = 0
    sample_fills = []

    for field_key, field_label in COMPARE_COLUMNS:
        db_populated = 0
        db_missing = 0
        file_populated = 0
        new_fill_potential = 0
        protected_existing = 0

        for file_row, buyer in matched_pairs:
            db_val = getattr(buyer, field_key, None)
            if not db_val and buyer.contacts:
                db_val = getattr(buyer.contacts[0], field_key, None)

            db_has_val = bool(db_val and str(db_val).strip())
            file_val = file_row.get(field_key)
            file_has_val = bool(file_val and str(file_val).strip())

            if db_has_val:
                db_populated += 1
            else:
                db_missing += 1

            if file_has_val:
                file_populated += 1

            if not db_has_val and file_has_val:
                new_fill_potential += 1
                total_potential_new_fills += 1
                if len(sample_fills) < 6:
                    sample_fills.append(
                        {
                            "company_name": buyer.company_name,
                            "field_name": field_label,
                            "new_value": file_val,
                        }
                    )

            if (
                db_has_val
                and file_has_val
                and str(db_val).strip().lower() != str(file_val).strip().lower()
            ):
                protected_existing += 1

        column_analysis.append(
            {
                "field_key": field_key,
                "field_label": field_label,
                "db_populated_count": db_populated,
                "db_missing_count": db_missing,
                "file_populated_count": file_populated,
                "new_fill_count": new_fill_potential,
                "protected_count": protected_existing,
            }
        )

    return {
        "user_name": user_name,
        "table_source": table_source,
        "filename": filename,
        "db_total_contacts": db_total_contacts,
        "uploaded_file_contacts": len(uploaded_rows),
        "matched_contacts_count": len(matched_pairs),
        "unmatched_contacts_count": len(unmatched_rows),
        "total_potential_new_fills": total_potential_new_fills,
        "column_analysis": column_analysis,
        "sample_fills": sample_fills,
    }


def execute_safe_fill_merge(
    db: Session,
    *,
    file_content: bytes,
    filename: str,
    user_id: int | None = None,
    table_source: str = "master_table",
) -> dict[str, Any]:
    """Perform a Safe Merge: Populates missing/blank fields only, 100% preserving existing DB values."""
    uploaded_rows = _parse_uploaded_file(file_content, filename)

    query = db.query(Buyer)
    if table_source == "old_clients":
        query = query.filter(Buyer.source == "old_clients")
    else:
        query = query.filter(Buyer.source != "old_clients")

    if user_id is not None:
        query = query.filter(Buyer.assigned_to_user_id == user_id)

    db_buyers = query.all()

    by_name = {}
    by_domain = {}
    by_email = {}
    by_phone = {}

    for buyer in db_buyers:
        if buyer.company_name:
            by_name[_normalize_name(buyer.company_name)] = buyer
        if buyer.website_url:
            dom = _dedupe_domain(buyer.website_url)
            if dom:
                by_domain[dom] = buyer
        if buyer.email:
            by_email[buyer.email.strip().lower()] = buyer
        if buyer.phone:
            by_phone[buyer.phone.strip()] = buyer
        for c in buyer.contacts or []:
            if c.email:
                by_email[c.email.strip().lower()] = buyer
            if c.phone:
                by_phone[c.phone.strip()] = buyer

    contacts_updated = 0
    total_fields_filled = 0
    protected_fields_count = 0

    buyer_fields = [
        "country",
        "industry",
        "city",
        "address",
        "website_url",
        "remarks",
        "company_grading",
        "product_interest",
    ]
    contact_fields = [
        "contact_name",
        "designation",
        "email",
        "secondary_email",
        "phone",
        "secondary_phone",
        "linkedin_url",
        "facebook_url",
        "instagram_url",
    ]

    for row in uploaded_rows:
        comp_name = row.get("company_name") or ""
        domain = _dedupe_domain(row.get("website_url"))
        email = (row.get("email") or "").strip().lower()
        phone = (row.get("phone") or "").strip()

        buyer = None
        if comp_name and _normalize_name(comp_name) in by_name:
            buyer = by_name[_normalize_name(comp_name)]
        elif domain and domain in by_domain:
            buyer = by_domain[domain]
        elif email and email in by_email:
            buyer = by_email[email]
        elif phone and phone in by_phone:
            buyer = by_phone[phone]

        if not buyer:
            continue

        buyer_modified = False
        primary_contact = buyer.contacts[0] if buyer.contacts else None

        for f in buyer_fields:
            current_val = getattr(buyer, f, None)
            new_val = row.get(f)
            if not current_val or not str(current_val).strip():
                if new_val and str(new_val).strip():
                    setattr(buyer, f, str(new_val).strip())
                    buyer_modified = True
                    total_fields_filled += 1
            else:
                if (
                    new_val
                    and str(new_val).strip()
                    and str(current_val).strip().lower() != str(new_val).strip().lower()
                ):
                    protected_fields_count += 1

        if primary_contact:
            for f in contact_fields:
                current_val = getattr(primary_contact, f, None)
                new_val = row.get(f)
                if not current_val or not str(current_val).strip():
                    if new_val and str(new_val).strip():
                        setattr(primary_contact, f, str(new_val).strip())
                        buyer_modified = True
                        total_fields_filled += 1
                else:
                    if (
                        new_val
                        and str(new_val).strip()
                        and str(current_val).strip().lower()
                        != str(new_val).strip().lower()
                    ):
                        protected_fields_count += 1

        if buyer_modified:
            contacts_updated += 1

    db.commit()

    return {
        "status": "success",
        "contacts_updated": contacts_updated,
        "total_fields_filled": total_fields_filled,
        "protected_fields_count": protected_fields_count,
        "message": f"Successfully enriched {contacts_updated} contacts with {total_fields_filled} new missing fields filled! {protected_fields_count} existing fields were 100% protected.",
    }
