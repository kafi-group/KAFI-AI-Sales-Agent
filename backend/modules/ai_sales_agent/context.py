"""Build pre-call briefing from buyer profile, history, and guidance signals."""

from __future__ import annotations

from sqlalchemy.orm import Session

from db.models import Buyer, Contact
from modules.calls import latest_call_notes_by_buyer
from modules.helpful_guidance import generate_helpful_guidance
from modules import buyers as buyers_module


def _contact_line(contact: Contact | None) -> str:
    if not contact:
        return "Contact: unknown — human team should fill contact person and phone before calling."
    parts = [
        f"Contact person: {contact.full_name or 'Unknown'}",
        f"Designation: {contact.designation or 'Unknown'}",
        f"Email: {contact.email or 'Unknown'}",
        f"Phone: {contact.phone or contact.primary_phone or 'Unknown'}",
    ]
    return "\n".join(parts)


def _readiness_warnings(buyer: Buyer, contact: Contact | None) -> list[str]:
    warnings: list[str] = []
    if not (buyer.company_name or "").strip():
        warnings.append("Company name is missing.")
    if not contact or not (contact.full_name or "").strip():
        warnings.append("Contact person name is missing — add before AI call.")
    if contact and not (contact.email or "").strip() and not (contact.phone or contact.primary_phone or "").strip():
        warnings.append("No email or phone on contact.")
    if not (buyer.country or "").strip():
        warnings.append("Country missing.")
    if not (buyer.industry or buyer.product_interest or buyer.address):
        warnings.append("Limited company profile — human research recommended (industry, products, address).")
    return warnings


def build_lead_context(db: Session, *, buyer_id: int, contact_id: int | None = None) -> dict:
    buyer = buyers_module.get_buyer(db, buyer_id)
    if not buyer:
        raise ValueError("Lead not found")

    contact: Contact | None = None
    if contact_id:
        contact = buyers_module.get_contact(db, contact_id)
        if not contact or contact.buyer_id != buyer_id:
            contact = None
    if contact is None:
        try:
            from modules.calls import _primary_contact_for_call

            contact = _primary_contact_for_call(db, buyer_id)
        except Exception:
            contact = None

    notes_map = latest_call_notes_by_buyer(db, buyer_ids=[buyer_id])
    prior = notes_map.get(buyer_id) or {}

    warnings = _readiness_warnings(buyer, contact)
    ready = len(warnings) == 0

    text_blocks = [
        f"Company: {buyer.company_name}",
        f"Country: {buyer.country or 'Unknown'}",
        f"City: {buyer.city or 'Unknown'}",
        f"Business type / industry: {buyer.industry or 'Unknown'}",
        f"Product interest: {buyer.product_interest or 'Unknown'}",
        f"Website: {buyer.website_url or 'Unknown'}",
        f"Address: {(buyer.address or '')[:400] or 'Unknown'}",
        f"Remarks on file: {(buyer.remarks or '')[:400] or 'None'}",
        _contact_line(contact),
    ]
    if prior.get("call_notes"):
        text_blocks.append(f"Last call notes: {prior['call_notes']}")
    if prior.get("call_outcome"):
        text_blocks.append(f"Last call outcome: {prior['call_outcome']}")

    return {
        "ready": ready,
        "warnings": warnings,
        "context_text": "\n".join(text_blocks),
        "buyer": buyer,
        "contact": contact,
    }


def guidance_snippet_for_persona(db: Session, *, app_user_id: int | None) -> str:
    try:
        from db.models import AppUser

        viewer = db.get(AppUser, app_user_id) if app_user_id else None
        if not viewer:
            return ""
        report = generate_helpful_guidance(db, viewer=viewer, months=1, user_id=None)
        recs = report.get("recommendations") or []
        if not recs:
            return ""
        lines = [f"- {r.get('title')}: {r.get('body')}" for r in recs[:2] if r.get("title")]
        return "Coaching tips:\n" + "\n".join(lines) if lines else ""
    except Exception:
        return ""
