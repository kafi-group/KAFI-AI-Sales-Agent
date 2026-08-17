from collections import defaultdict

from sqlalchemy.orm import Session

import re

from db.models import (
    Buyer,
    BuyerResearchProfile,
    ConsentStatus,
    Contact,
    ExportHistory,
    Interaction,
    LeadScore,
    Quotation,
    ScheduledEvent,
)

_VALID_EMAIL_RE = re.compile(r"^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$", re.I)
_BLOCKED_EMAIL_PREFIXES = ("noreply@", "no-reply@", "donotreply@", "example@", "test@")
_INVALID_EMAIL_VALUES = {"not found", "n/a", "na", "none", "-"}


def is_valid_email(email: str | None) -> bool:
    if not email:
        return False
    value = email.strip()
    if not value or value.lower() in _INVALID_EMAIL_VALUES:
        return False
    if value.lower().startswith(_BLOCKED_EMAIL_PREFIXES):
        return False
    return bool(_VALID_EMAIL_RE.match(value))


def normalize_buyer_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def buyer_website_domain(url: str | None) -> str | None:
    if not url:
        return None
    try:
        from urllib.parse import urlparse

        parsed = urlparse(url if "://" in url else f"https://{url}")
        host = parsed.netloc.lower()
        return host[4:] if host.startswith("www.") else host
    except ValueError:
        return None


def buyer_data_score(db: Session, buyer: Buyer) -> int:
    """Higher score = richer lead record; used to pick which duplicate to keep."""
    contact = primary_contact_with_email(db, buyer.id)
    if not contact:
        contacts = list_contacts_for_buyer(db, buyer.id)
        contact = contacts[0] if contacts else None

    latest_score = (
        db.query(LeadScore)
        .filter(LeadScore.buyer_id == buyer.id)
        .order_by(LeadScore.scored_at.desc())
        .first()
    )
    return buyer_data_score_from_parts(buyer, contact, latest_score)


def buyer_data_score_from_parts(
    buyer: Buyer,
    contact: Contact | None,
    latest_score: LeadScore | None,
) -> int:
    from db.models import LeadScoreLabel

    points = 0
    if buyer.website_url:
        points += 10
    if buyer.country:
        points += 2
    if buyer.industry:
        points += 2
    if buyer.linkedin_company_url:
        points += 3
    if buyer.facebook_company_url:
        points += 2
    if buyer.instagram_company_url:
        points += 2
    if buyer.company_grading:
        points += 1
    if buyer.product_interest:
        points += 2
    if buyer.city:
        points += 1
    if buyer.address:
        points += 1
    if buyer.remarks:
        points += 1
    if contact and is_valid_email(contact.email):
        points += 15
    if contact and contact.phone:
        points += 5
    if contact and contact.primary_phone:
        points += 3
    if contact and contact.secondary_mobile:
        points += 2
    if contact and contact.secondary_phone:
        points += 2
    if contact and is_valid_email(contact.secondary_email):
        points += 5
    if latest_score:
        points += 5
        if latest_score.score == LeadScoreLabel.AAA:
            points += 10
        elif latest_score.score == LeadScoreLabel.AA:
            points += 5
    return points


def preload_buyer_data_scores(db: Session, buyers: list[Buyer]) -> dict[int, int]:
    """Score many buyers with two queries instead of 2–3 per buyer."""
    if not buyers:
        return {}

    buyer_ids = [buyer.id for buyer in buyers]
    contacts = (
        db.query(Contact)
        .filter(Contact.buyer_id.in_(buyer_ids))
        .order_by(Contact.buyer_id.asc(), Contact.id.asc())
        .all()
    )
    contact_by_buyer: dict[int, Contact] = {}
    for contact in contacts:
        current = contact_by_buyer.get(contact.buyer_id)
        if current is None:
            contact_by_buyer[contact.buyer_id] = contact
        elif is_valid_email(contact.email) and not is_valid_email(current.email):
            contact_by_buyer[contact.buyer_id] = contact

    from sqlalchemy import func as sa_func

    ranked = (
        db.query(
            LeadScore.id,
            sa_func.row_number()
            .over(partition_by=LeadScore.buyer_id, order_by=LeadScore.scored_at.desc())
            .label("rn"),
        )
        .filter(LeadScore.buyer_id.in_(buyer_ids))
        .subquery()
    )
    latest_scores = (
        db.query(LeadScore)
        .join(ranked, LeadScore.id == ranked.c.id)
        .filter(ranked.c.rn == 1)
        .all()
    )
    score_by_buyer = {row.buyer_id: row for row in latest_scores}

    return {
        buyer.id: buyer_data_score_from_parts(
            buyer,
            contact_by_buyer.get(buyer.id),
            score_by_buyer.get(buyer.id),
        )
        for buyer in buyers
    }


def is_sparse_buyer(db: Session, buyer: Buyer) -> bool:
    """True when a lead has almost no scraped details (typical failed CSV import)."""
    return buyer_data_score(db, buyer) < 8


def build_buyer_lookup_index(
    db: Session,
    *,
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
) -> tuple[
    dict[str, Buyer],
    dict[str, Buyer],
    dict[int, int],
    dict[str, Buyer],
    dict[str, Buyer],
]:
    """One scoped load for import dedupe: name, domain, email, phone → buyer.

    When ``assigned_to_user_id`` is set (sales-user import), only that user's
    assigned rows count as duplicates — admin/other users' clients are ignored.
    When None (admin import), dedupe is section-wide as before.
    """
    from sqlalchemy import func as sa_func

    from db.models import Contact
    from modules.field_clean import email_dedupe_key, phone_dedupe_key

    excluded = {
        part.strip().lower()
        for part in (exclude_source or "").split(",")
        if part.strip()
    }
    query = db.query(Buyer)
    if source:
        query = query.filter(sa_func.lower(Buyer.source) == source.strip().lower())
    if excluded:
        query = query.filter(
            ~sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(excluded)
        )
    if assigned_to_user_id is not None:
        query = query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)

    buyers = query.all()
    buyer_ids = [buyer.id for buyer in buyers]
    contacts_by_buyer: dict[int, list[Contact]] = defaultdict(list)
    if buyer_ids:
        for contact in db.query(Contact).filter(Contact.buyer_id.in_(buyer_ids)).all():
            contacts_by_buyer[contact.buyer_id].append(contact)

    by_name: dict[str, Buyer] = {}
    by_domain: dict[str, Buyer] = {}
    by_email: dict[str, Buyer] = {}
    by_phone: dict[str, Buyer] = {}
    for buyer in buyers:
        name_key = normalize_buyer_key(buyer.company_name)
        if name_key and name_key not in by_name:
            by_name[name_key] = buyer
        domain = buyer_website_domain(buyer.website_url)
        if domain and domain not in by_domain:
            by_domain[domain] = buyer
        for contact in contacts_by_buyer.get(buyer.id, []):
            for field in ("email", "secondary_email"):
                email_key = email_dedupe_key(getattr(contact, field, None))
                if email_key and email_key not in by_email:
                    by_email[email_key] = buyer
            for field in ("phone", "primary_phone", "secondary_phone", "secondary_mobile"):
                phone_key = phone_dedupe_key(getattr(contact, field, None))
                if phone_key and phone_key not in by_phone:
                    by_phone[phone_key] = buyer

    scores = preload_buyer_data_scores(db, buyers)
    return by_name, by_domain, scores, by_email, by_phone


def find_buyer_by_name_or_domain(
    db: Session,
    *,
    company_name: str,
    website_url: str | None = None,
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
) -> Buyer | None:
    by_name, by_domain, _, _, _ = build_buyer_lookup_index(
        db,
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
    )
    name_key = normalize_buyer_key(company_name)
    domain = buyer_website_domain(website_url)
    return by_name.get(name_key) or (by_domain.get(domain) if domain else None)


def primary_contact_with_email(db: Session, buyer_id: int) -> Contact | None:
    for contact in list_contacts_for_buyer(db, buyer_id):
        if is_valid_email(contact.email):
            return contact
    return None


def primary_contact_with_phone(db: Session, buyer_id: int) -> Contact | None:
    from integrations.voice_client import normalize_e164

    for contact in list_contacts_for_buyer(db, buyer_id):
        if normalize_e164(contact.phone):
            return contact
    return None


def list_buyers(db: Session) -> list[Buyer]:
    return db.query(Buyer).order_by(Buyer.created_at.desc()).all()


def get_buyer(db: Session, buyer_id: int) -> Buyer | None:
    return db.get(Buyer, buyer_id)


def create_buyer(db: Session, data: dict, *, commit: bool = True, flush: bool = True) -> Buyer:
    from modules.countries import resolve_country_name

    payload = dict(data)
    country = (payload.get("country") or "").strip()
    if country:
        payload["country"] = resolve_country_name(country) or country
    buyer = Buyer(**payload)
    db.add(buyer)
    if commit:
        db.commit()
        db.refresh(buyer)
    elif flush:
        db.flush()
    return buyer


def list_contacts(db: Session) -> list[Contact]:
    return db.query(Contact).order_by(Contact.id.desc()).all()


def list_contacts_for_buyer(db: Session, buyer_id: int) -> list[Contact]:
    return (
        db.query(Contact)
        .filter(Contact.buyer_id == buyer_id)
        .order_by(Contact.id.asc())
        .all()
    )


def contact_to_read(contact: Contact) -> dict:
    """Serialize a contact, including WhatsApp 24h session window status."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    expires = contact.whatsapp_window_expires_at
    within_window = bool(expires and expires > now)
    consent = contact.consent_status
    consent_value = consent.value if hasattr(consent, "value") else str(consent or "unknown")
    return {
        "id": contact.id,
        "buyer_id": contact.buyer_id,
        "full_name": contact.full_name,
        "designation": contact.designation,
        "email": contact.email,
        "phone": contact.phone,
        "preferred_language": contact.preferred_language,
        "consent_status": consent_value,
        "whatsapp_opt_in": bool(contact.whatsapp_opt_in),
        "wa_id": contact.wa_id,
        "within_session_window": within_window,
        "window_expires_at": expires,
    }


def get_contact(db: Session, contact_id: int) -> Contact | None:
    return db.get(Contact, contact_id)


def create_contact(db: Session, data: dict, *, commit: bool = True, flush: bool = True) -> Contact:
    consent = data.pop("consent_status", "unknown")
    data["consent_status"] = ConsentStatus(consent)
    contact = Contact(**data)
    db.add(contact)
    if commit:
        db.commit()
        db.refresh(contact)
    elif flush:
        db.flush()
    return contact


def update_buyer(
    db: Session,
    buyer_id: int,
    data: dict,
    *,
    remarks_by: str | None = None,
) -> Buyer | None:
    buyer = get_buyer(db, buyer_id)
    if not buyer:
        return None
    if "remarks" in data:
        new_remarks = data.get("remarks")
        old = (buyer.remarks or "").strip()
        new = (new_remarks or "").strip() if new_remarks is not None else ""
        if new and new != old:
            from modules.client_history import append_client_history

            append_client_history(
                buyer,
                text=new,
                by_username=remarks_by,
                source="remark",
            )
    for key, value in data.items():
        if key in {
            "company_name",
            "website_url",
            "country",
            "industry",
            "linkedin_company_url",
            "facebook_company_url",
            "instagram_company_url",
            "source",
            "legacy_serial_no",
            "company_grading",
            "product_interest",
            "city",
            "address",
            "remarks",
            "assigned_to",
            "assigned_to_user_id",
        }:
            if key == "country" and value:
                from modules.countries import resolve_country_name

                value = resolve_country_name(str(value)) or value
            setattr(buyer, key, value)
    db.commit()
    db.refresh(buyer)
    return buyer


def update_contact(db: Session, contact_id: int, data: dict) -> Contact | None:
    contact = db.get(Contact, contact_id)
    if not contact:
        return None
    if "consent_status" in data and data["consent_status"] is not None:
        contact.consent_status = ConsentStatus(data["consent_status"])
        data = {k: v for k, v in data.items() if k != "consent_status"}
    for key, value in data.items():
        if key in {
            "full_name",
            "email",
            "phone",
            "designation",
            "secondary_mobile",
            "primary_phone",
            "secondary_phone",
            "secondary_email",
            "preferred_language",
            "date_of_birth",
            "nationality",
            "wa_id",
            "whatsapp_opt_in",
        }:
            setattr(contact, key, value)
    db.commit()
    db.refresh(contact)
    return contact


def delete_contact(db: Session, contact_id: int) -> bool:
    contact = db.get(Contact, contact_id)
    if not contact:
        return False
    db.query(Interaction).filter(Interaction.contact_id == contact_id).delete(
        synchronize_session=False
    )
    db.query(ScheduledEvent).filter(ScheduledEvent.contact_id == contact_id).delete(
        synchronize_session=False
    )
    db.delete(contact)
    db.commit()
    return True


def upsert_primary_contact(
    db: Session,
    buyer_id: int,
    *,
    contact_id: int | None = None,
    full_name: str | None = None,
    email: str | None = None,
    phone: str | None = None,
    designation: str | None = None,
    secondary_mobile: str | None = None,
    primary_phone: str | None = None,
    secondary_phone: str | None = None,
    secondary_email: str | None = None,
) -> Contact | None:
    contact_extras = {
        "designation": designation,
        "secondary_mobile": secondary_mobile,
        "primary_phone": primary_phone,
        "secondary_phone": secondary_phone,
        "secondary_email": secondary_email,
    }
    if contact_id:
        contact = db.get(Contact, contact_id)
        if contact and contact.buyer_id == buyer_id:
            if full_name is not None:
                contact.full_name = full_name
            if email is not None:
                contact.email = email or None
            if phone is not None:
                contact.phone = phone or None
            for key, value in contact_extras.items():
                if value is not None:
                    setattr(contact, key, value or None)
            db.commit()
            db.refresh(contact)
            return contact

    has_extra = any(value for value in contact_extras.values())
    if not (full_name or email or phone or has_extra):
        return None

    payload = {
        "buyer_id": buyer_id,
        "full_name": full_name or "General contact",
        "email": email or None,
        "phone": phone or None,
        "data_source": "table_edit",
        "consent_status": "unknown",
    }
    for key, value in contact_extras.items():
        if value is not None:
            payload[key] = value or None
    return create_contact(db, payload)


def delete_buyer(db: Session, buyer_id: int, *, commit: bool = True) -> bool:
    return delete_buyers_bulk(db, [buyer_id], commit=commit) > 0


def delete_buyers_bulk(db: Session, buyer_ids: list[int], *, commit: bool = True) -> int:
    """Delete many buyers and related rows in a few SQL statements.

    Used by remove-duplicates — the per-row delete_buyer path times out on
    hundreds of duplicates (statement_timeout / client abort).
    """
    ids = sorted({int(buyer_id) for buyer_id in buyer_ids if buyer_id})
    if not ids:
        return 0

    from db.models import EmailActivityEvent

    contact_ids = [
        row[0]
        for row in db.query(Contact.id).filter(Contact.buyer_id.in_(ids)).all()
    ]
    if contact_ids:
        interaction_ids = [
            row[0]
            for row in db.query(Interaction.id).filter(Interaction.contact_id.in_(contact_ids)).all()
        ]
        if interaction_ids:
            db.query(EmailActivityEvent).filter(
                EmailActivityEvent.interaction_id.in_(interaction_ids)
            ).update({EmailActivityEvent.interaction_id: None}, synchronize_session=False)
        db.query(Interaction).filter(Interaction.contact_id.in_(contact_ids)).delete(
            synchronize_session=False
        )
        db.query(ScheduledEvent).filter(ScheduledEvent.contact_id.in_(contact_ids)).delete(
            synchronize_session=False
        )
        db.query(EmailActivityEvent).filter(
            EmailActivityEvent.contact_id.in_(contact_ids)
        ).update({EmailActivityEvent.contact_id: None}, synchronize_session=False)
        db.query(Contact).filter(Contact.id.in_(contact_ids)).delete(
            synchronize_session=False
        )

    db.query(EmailActivityEvent).filter(EmailActivityEvent.buyer_id.in_(ids)).update(
        {EmailActivityEvent.buyer_id: None}, synchronize_session=False
    )
    db.query(LeadScore).filter(LeadScore.buyer_id.in_(ids)).delete(
        synchronize_session=False
    )
    db.query(Quotation).filter(Quotation.buyer_id.in_(ids)).delete(
        synchronize_session=False
    )
    db.query(ExportHistory).filter(ExportHistory.buyer_id.in_(ids)).delete(
        synchronize_session=False
    )
    db.query(BuyerResearchProfile).filter(BuyerResearchProfile.buyer_id.in_(ids)).delete(
        synchronize_session=False
    )
    deleted = (
        db.query(Buyer).filter(Buyer.id.in_(ids)).delete(synchronize_session=False) or 0
    )
    if commit:
        db.commit()
    else:
        db.flush()
    return int(deleted)
