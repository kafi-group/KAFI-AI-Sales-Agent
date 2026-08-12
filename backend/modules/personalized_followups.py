"""Personalized post-call follow-ups from closed captions → email + WhatsApp drafts."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from db.models import (
    AppUser,
    AppUserRole,
    Buyer,
    Contact,
    Interaction,
    PersonalizedFollowupDraft,
)
from modules.channel_sync import derive_whatsapp_from_email, sync_whatsapp_with_email

ELIGIBLE_OUTCOMES = frozenset(
    {"interested", "follow_up", "not_interested", "not_received_call"}
)
ACTIVE_STATUSES = frozenset({"awaiting_transcript", "generating", "ready", "failed"})


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _sanitize_no_attachment_language(subject: str, body: str) -> tuple[str, str]:
    """Strip attachment wording — post-call sends have no files attached."""
    import re

    attachment_phrases = re.compile(
        r"(?i)\b("
        r"please find (?:the )?attach(?:ed|ment)|"
        r"find attach(?:ed|ment)|"
        r"see attach(?:ed|ment)|"
        r"attach(?:ed|ment) (?:is|are|herewith|below|for your reference)|"
        r"as attach(?:ed|ment)|"
        r"enclosed (?:is|are|please find)"
        r")\b[^.\n]*[.\n]?"
    )

    cleaned_body = attachment_phrases.sub("", body or "").strip()
    cleaned_body = re.sub(r"\n{3,}", "\n\n", cleaned_body)
    cleaned_subject = re.sub(
        r"(?i)\b(?:attached|attachment|enclosed)\b",
        "",
        subject or "",
    ).strip()
    cleaned_subject = re.sub(r"\s{2,}", " ", cleaned_subject)
    return cleaned_subject or subject, cleaned_body or body


def _is_admin(user: AppUser) -> bool:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    return role == AppUserRole.admin.value


def _call_notes(interaction: Interaction) -> str:
    from modules.calls import parse_call_fields

    return (parse_call_fields(interaction.content).get("notes") or "").strip()


def _transcript_text(interaction: Interaction) -> str | None:
    from modules.call_media import get_call_media

    media = get_call_media(interaction) or {}
    if (media.get("transcript_status") or "").lower() != "ready":
        return None
    text = (media.get("transcript") or "").strip()
    return text or None


def draft_to_dict(db: Session, draft: PersonalizedFollowupDraft) -> dict[str, Any]:
    buyer = db.get(Buyer, draft.buyer_id)
    contact = db.get(Contact, draft.contact_id) if draft.contact_id else None
    return {
        "id": draft.id,
        "interaction_id": draft.interaction_id,
        "buyer_id": draft.buyer_id,
        "company_name": buyer.company_name if buyer else None,
        "country": buyer.country if buyer else None,
        "contact_id": draft.contact_id,
        "contact_name": contact.full_name if contact else None,
        "contact_email": contact.email if contact else None,
        "contact_phone": (contact.phone or contact.wa_id) if contact else None,
        "created_by_user_id": draft.created_by_user_id,
        "call_outcome": draft.call_outcome,
        "status": draft.status,
        "subject": draft.subject,
        "email_body": draft.email_body,
        "whatsapp_body": draft.whatsapp_body,
        "transcript_excerpt": draft.transcript_excerpt,
        "generation_error": draft.generation_error,
        "email_send_status": draft.email_send_status,
        "whatsapp_send_status": draft.whatsapp_send_status,
        "whatsapp_personal_send_status": draft.whatsapp_personal_send_status,
        "email_send_message": draft.email_send_message,
        "whatsapp_send_message": draft.whatsapp_send_message,
        "whatsapp_personal_send_message": draft.whatsapp_personal_send_message,
        "sent_at": draft.sent_at.isoformat() if draft.sent_at else None,
        "created_at": draft.created_at.isoformat() if draft.created_at else None,
        "updated_at": draft.updated_at.isoformat() if draft.updated_at else None,
    }


def ensure_draft_for_call(
    db: Session,
    *,
    interaction_id: int,
    call_outcome: str,
    user_id: int | None,
    generate_now: bool = True,
) -> PersonalizedFollowupDraft | None:
    """Create or refresh a personalized draft after any completed call with remarks/outcome."""
    outcome = (call_outcome or "").strip().lower() or "follow_up"

    interaction = db.get(Interaction, interaction_id)
    if not interaction:
        return None
    contact = db.get(Contact, interaction.contact_id)
    if not contact:
        return None

    draft = (
        db.query(PersonalizedFollowupDraft)
        .filter(PersonalizedFollowupDraft.interaction_id == interaction_id)
        .one_or_none()
    )
    if draft and draft.status == "sent":
        return draft

    if not draft:
        draft = PersonalizedFollowupDraft(
            interaction_id=interaction_id,
            buyer_id=contact.buyer_id,
            contact_id=contact.id,
            created_by_user_id=user_id,
            call_outcome=outcome,
            status="awaiting_transcript",
        )
        db.add(draft)
    else:
        draft.call_outcome = outcome
        draft.contact_id = contact.id
        draft.buyer_id = contact.buyer_id
        if user_id and not draft.created_by_user_id:
            draft.created_by_user_id = user_id
        if draft.status in {"dismissed", "failed"}:
            draft.status = "awaiting_transcript"
            draft.generation_error = None

    db.commit()
    db.refresh(draft)

    if generate_now:
        return generate_draft_content(db, draft.id)
    return draft


def generate_draft_content(db: Session, draft_id: int) -> PersonalizedFollowupDraft:
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise ValueError("Personalized draft not found")
    if draft.status == "sent":
        return draft

    interaction = db.get(Interaction, draft.interaction_id)
    if not interaction:
        raise ValueError("Call interaction not found")

    buyer = db.get(Buyer, draft.buyer_id)
    contact = db.get(Contact, draft.contact_id) if draft.contact_id else None
    transcript = _transcript_text(interaction)
    notes = _call_notes(interaction)

    if not transcript and not notes:
        draft.status = "awaiting_transcript"
        draft.generation_error = (
            "Waiting for closed captions (or call remarks) before drafting the message."
        )
        db.commit()
        db.refresh(draft)
        return draft

    draft.status = "generating"
    draft.generation_error = None
    db.commit()

    company = buyer.company_name if buyer else "the client"
    contact_name = (contact.full_name if contact else None) or "Sir/Madam"
    country = (buyer.country if buyer else None) or ""
    outcome_label = (
        "Client is Interested" if draft.call_outcome == "interested" else "Follow up"
    )

    source = transcript or notes
    excerpt = source[:4000]
    draft.transcript_excerpt = excerpt[:2000]

    fallback_subject = f"Following our call — Kafi Commodities & {company}"
    fallback_email = (
        f"Dear {contact_name},\n\n"
        f"Thank you for speaking with us today. As per our phone conversation, this message "
        f"confirms the points we discussed regarding {company}.\n\n"
        f"We remain at your service for ESSENCE product specifications, samples, or pricing "
        f"whenever convenient for you.\n\n"
        f"Best regards,\nKafi Commodities Export Team"
    )

    subject = fallback_subject
    email_body = fallback_email

    try:
        from modules.llm_client import llm_client

        if llm_client.enabled:
            from modules.llm_client import with_email_reply_standards

            prompt = with_email_reply_standards(
                f"""You write a short, gentle call-confirmation message for Kafi Commodities (ESSENCE foods exporter from Pakistan).

Call outcome: {outcome_label}
Company: {company}
Contact: {contact_name}
Country: {country or "unknown"}

Call transcript / remarks:
---
{excerpt}
---

Return JSON only with keys:
- subject: email subject line (max 90 chars)
- email_body: polite confirmation of the phone call, about 60–100 words, reference 1–2 concrete points from the call, no invented prices or commitments

Rules:
- Start by confirming the phone conversation ("As per our call today…").
- Concise, warm, professional — suitable for both email and WhatsApp.
- NEVER repeat rude language, swearing, insults, or aggressive tone from the transcript — even if the operator used them. Summarize only the business substance (products, quantities, next steps) in polished export-sales language.
- If the transcript is empty, unclear, or only contains frustration, write a neutral polite confirmation that thanks them for the call and offers ESSENCE product information — do not mention conflict or tone.
- Do not invent product quantities, prices, or meeting times not in the source.
- NEVER mention attachments, enclosed files, "please find attached", or "see attached" — this message is sent as plain text with no files.
- Sign as Kafi Commodities Export Team.
- This email body will also be sent on WhatsApp unchanged.
"""
            )
            data = llm_client.generate_json(
                prompt,
                system=(
                    "You write concise inquiry-specific follow-up emails for Kafi Commodities. "
                    "Always professional and diplomatic — never echo profanity or negativity from call captions. "
                    "Return JSON only. One message will be used for both email and WhatsApp."
                ),
            )
            subject = (data.get("subject") or subject).strip()[:500] or subject
            email_body = (data.get("email_body") or email_body).strip() or email_body
    except Exception as exc:  # noqa: BLE001
        draft.generation_error = f"Used fallback draft ({exc})"

    subject, email_body = _sanitize_no_attachment_language(subject, email_body)

    # Email is source of truth — WhatsApp always mirrors the same information.
    whatsapp_body = derive_whatsapp_from_email(email_body)

    draft.subject = subject
    draft.email_body = email_body
    draft.whatsapp_body = whatsapp_body
    draft.status = "ready"
    if not draft.generation_error:
        draft.generation_error = None
    db.commit()
    db.refresh(draft)
    return draft


def maybe_generate_for_interaction(db: Session, interaction_id: int) -> None:
    """Called when closed captions become ready — fill drafts still waiting."""
    draft = (
        db.query(PersonalizedFollowupDraft)
        .filter(PersonalizedFollowupDraft.interaction_id == interaction_id)
        .one_or_none()
    )
    if not draft or draft.status == "sent":
        return
    if draft.status in {"awaiting_transcript", "failed", "generating"}:
        generate_draft_content(db, draft.id)


def dismiss_draft_for_ineligible_outcome(
    db: Session, *, interaction_id: int, call_outcome: str | None
) -> None:
    """Drop unsent drafts when the call is marked Not interested / Did not receive."""
    outcome = (call_outcome or "").strip().lower()
    if outcome in ELIGIBLE_OUTCOMES:
        return
    draft = (
        db.query(PersonalizedFollowupDraft)
        .filter(PersonalizedFollowupDraft.interaction_id == interaction_id)
        .one_or_none()
    )
    if not draft or draft.status == "sent":
        return
    draft.status = "dismissed"
    db.commit()


def list_drafts(
    db: Session,
    *,
    viewer: AppUser,
    status: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    q = db.query(PersonalizedFollowupDraft)
    if status:
        q = q.filter(PersonalizedFollowupDraft.status == status.strip().lower())
    else:
        q = q.filter(PersonalizedFollowupDraft.status.in_(sorted(ACTIVE_STATUSES)))

    total = q.count()
    rows = (
        q.order_by(PersonalizedFollowupDraft.created_at.desc())
        .limit(min(max(1, limit), 200))
        .all()
    )
    ready_q = db.query(PersonalizedFollowupDraft).filter(
        PersonalizedFollowupDraft.status == "ready"
    )
    return {
        "total": total,
        "pending_count": int(ready_q.count() or 0),
        "rows": [draft_to_dict(db, row) for row in rows],
    }


def get_draft_for_interaction(
    db: Session,
    *,
    interaction_id: int,
) -> dict[str, Any] | None:
    draft = (
        db.query(PersonalizedFollowupDraft)
        .filter(PersonalizedFollowupDraft.interaction_id == interaction_id)
        .order_by(PersonalizedFollowupDraft.created_at.desc())
        .first()
    )
    if not draft:
        return None
    return draft_to_dict(db, draft)


def update_draft(
    db: Session,
    draft_id: int,
    *,
    subject: str | None = None,
    email_body: str | None = None,
    whatsapp_body: str | None = None,
) -> PersonalizedFollowupDraft:
    """Update draft. Email is source of truth; WhatsApp is kept in sync."""
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise ValueError("Personalized draft not found")
    if draft.status == "sent":
        raise ValueError("This follow-up was already sent")
    if subject is not None:
        draft.subject = subject.strip()[:500]
    if email_body is not None:
        draft.email_body = email_body.strip()
    # Always mirror WhatsApp from email so channels cannot diverge.
    # (whatsapp_body in the payload is accepted for API compatibility but ignored when email exists.)
    draft.whatsapp_body = sync_whatsapp_with_email(
        draft.email_body or "",
        whatsapp_body if email_body is None else None,
    )
    if draft.status in {"awaiting_transcript", "failed", "generating"} and draft.email_body:
        draft.status = "ready"
    db.commit()
    db.refresh(draft)
    return draft


def dismiss_draft(db: Session, draft_id: int) -> PersonalizedFollowupDraft:
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise ValueError("Personalized draft not found")
    draft.status = "dismissed"
    db.commit()
    db.refresh(draft)
    return draft


def send_draft(
    db: Session,
    draft_id: int,
    *,
    user: AppUser,
    channels: str | list[str] | None = None,
    template_name: str | None = None,
    template_language: str = "en_US",
    template_variables: list[str] | None = None,
    attachments: list[dict] | None = None,
) -> dict[str, Any]:
    """Send the reviewed message via email and/or WhatsApp (human-approved).

    ``channels``: ``"email"`` | ``"whatsapp"`` | ``"both"`` (default), or a list
    of channel names. Outside the 24h WhatsApp window, pass an approved
    ``template_name`` (+ variables) or the WhatsApp send will fail with a
    template-required message the UI can surface.
    """
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise ValueError("Personalized draft not found")

    channel_set: set[str]
    if channels is None:
        channel_set = {"email", "whatsapp"}
    elif isinstance(channels, str):
        key = channels.strip().lower()
        if key in {"all", "all_three", "everything", "email_whatsapp_personal"}:
            channel_set = {"email", "whatsapp", "whatsapp_personal"}
        elif key in {"both", "all", "email+whatsapp", "email_whatsapp"}:
            channel_set = {"email", "whatsapp"}
        elif key in {"email", "whatsapp", "whatsapp_personal"}:
            channel_set = {key}
        else:
            raise ValueError(
                "channels must be 'email', 'whatsapp', 'whatsapp_personal', 'both', or 'all'"
            )
    else:
        channel_set = {str(c).strip().lower() for c in channels if str(c).strip()}
        channel_set &= {"email", "whatsapp", "whatsapp_personal"}
        if not channel_set:
            raise ValueError("Select at least one channel")

    send_email = "email" in channel_set
    send_whatsapp = "whatsapp" in channel_set
    send_whatsapp_personal = "whatsapp_personal" in channel_set

    email_already_ok = (draft.email_send_status or "") in {"sent", "queued"}
    wa_already_ok = draft.whatsapp_send_status == "sent"
    wa_personal_already_ok = draft.whatsapp_personal_send_status == "sent"

    if draft.status == "sent" and (
        (not send_email or email_already_ok)
        and (not send_whatsapp or wa_already_ok)
        and (not send_whatsapp_personal or wa_personal_already_ok)
    ):
        raise ValueError("This follow-up was already sent on the selected channel(s)")

    # Skip channels that already succeeded (retry only the failed ones).
    if send_email and email_already_ok:
        send_email = False
    if send_whatsapp and wa_already_ok:
        send_whatsapp = False
    if send_whatsapp_personal and wa_personal_already_ok:
        send_whatsapp_personal = False
    if not send_email and not send_whatsapp and not send_whatsapp_personal:
        raise ValueError("Selected channel(s) were already sent")

    body_text = (draft.email_body or "").strip()
    if send_email:
        if not (draft.subject or "").strip() or not body_text:
            raise ValueError("Subject and email body are required before sending email")
    if send_whatsapp and not body_text and not (template_name or "").strip():
        raise ValueError("Message body is required before sending WhatsApp (Meta)")
    if send_whatsapp_personal and not body_text:
        raise ValueError("Message body is required before sending WhatsApp Personal")

    # Final sync: free-text WhatsApp carries the same information as the email.
    draft.whatsapp_body = derive_whatsapp_from_email(draft.email_body or "")
    db.commit()

    from modules.comms_generator import get_comms

    comms = get_comms()
    email_status = draft.email_send_status
    email_message = draft.email_send_message
    wa_status = draft.whatsapp_send_status
    wa_message = draft.whatsapp_send_message
    wa_personal_status = draft.whatsapp_personal_send_status
    wa_personal_message = draft.whatsapp_personal_send_message
    email_interaction_id = draft.email_interaction_id
    wa_interaction_id = draft.whatsapp_interaction_id

    # Email
    if send_email:
        try:
            email_draft = comms.create_manual_email_draft(
                db,
                buyer_id=draft.buyer_id,
                contact_id=draft.contact_id,
                subject=draft.subject or "",
                body=draft.email_body or "",
                attachments=attachments,
            )
            email_interaction_id = email_draft.id
            _approved, send_result = comms.approve_draft(
                db,
                email_draft.id,
                approved_by=user.username,
                send=True,
                mailbox_user=user,
            )
            email_status = (send_result or {}).get("status") or "sent"
            email_message = (send_result or {}).get("message")
            approved_status = getattr(_approved.status, "value", _approved.status)
            if email_status not in {"sent", "queued"} and str(approved_status) == "sent":
                email_status = "sent"
                email_message = email_message or "Email sent"
        except Exception as exc:  # noqa: BLE001
            email_status = "error"
            email_message = str(exc)

    # WhatsApp (free text inside 24h window, or approved template outside it)
    if send_whatsapp:
        try:
            contact = db.get(Contact, draft.contact_id) if draft.contact_id else None
            if not contact or not (contact.phone or contact.wa_id):
                raise ValueError("Contact has no phone number for WhatsApp")
            wa_draft = comms.create_manual_whatsapp_draft(
                db,
                contact_id=contact.id,
                content=(draft.whatsapp_body or draft.email_body or "").strip(),
            )
            wa_interaction_id = wa_draft.id
            _wa_approved, wa_result = comms.approve_draft(
                db,
                wa_draft.id,
                approved_by=user.username,
                send=True,
                template_name=(template_name or "").strip() or None,
                template_language=template_language or "en_US",
                template_variables=template_variables,
            )
            approved_wa = getattr(_wa_approved.status, "value", _wa_approved.status)
            wa_status = (wa_result or {}).get("status") or (
                "sent" if str(approved_wa) == "sent" else "error"
            )
            wa_message = (wa_result or {}).get("message")
        except Exception as exc:  # noqa: BLE001
            wa_status = "error"
            wa_message = str(exc)

    # WhatsApp Personal (Baileys bridge — rep's scanned phone)
    if send_whatsapp_personal:
        try:
            from integrations import whatsapp_bridge_client as bridge

            contact = db.get(Contact, draft.contact_id) if draft.contact_id else None
            phone = (contact.phone or contact.wa_id or "").strip() if contact else ""
            if not phone:
                raise ValueError("Contact has no phone number for WhatsApp Personal")
            status = bridge.bridge_status(user.id)
            if not status.get("connected"):
                raise ValueError(
                    "Personal WhatsApp is not connected. Open WhatsApp QR and scan your phone."
                )
            bridge.bridge_send(
                user.id,
                to_phone=phone,
                message=(draft.whatsapp_body or draft.email_body or "").strip(),
            )
            wa_personal_status = "sent"
            wa_personal_message = "Sent via personal WhatsApp"
        except Exception as exc:  # noqa: BLE001
            wa_personal_status = "error"
            wa_personal_message = str(exc)

    draft.email_interaction_id = email_interaction_id
    draft.whatsapp_interaction_id = wa_interaction_id
    draft.email_send_status = email_status
    draft.whatsapp_send_status = wa_status
    draft.whatsapp_personal_send_status = wa_personal_status
    draft.email_send_message = email_message
    draft.whatsapp_send_message = wa_message
    draft.whatsapp_personal_send_message = wa_personal_message

    email_ok = (email_status or "") in {"sent", "queued"}
    wa_ok = wa_status == "sent"
    wa_personal_ok = wa_personal_status == "sent"

    requested_email = "email" in channel_set
    requested_wa = "whatsapp" in channel_set
    requested_wa_personal = "whatsapp_personal" in channel_set
    email_done = (not requested_email) or email_ok
    wa_done = (not requested_wa) or wa_ok
    wa_personal_done = (not requested_wa_personal) or wa_personal_ok

    if (requested_email and email_ok) or (requested_wa and wa_ok) or (
        requested_wa_personal and wa_personal_ok
    ):
        if email_done and wa_done and wa_personal_done:
            draft.status = "sent"
            draft.sent_at = draft.sent_at or _utcnow()
            draft.generation_error = None
        else:
            # Partial success — keep ready so the failed channel can be retried.
            draft.status = "ready"
            draft.sent_at = draft.sent_at or _utcnow()
            if requested_email and not email_ok:
                draft.generation_error = email_message or "Email send failed"
            elif requested_wa and not wa_ok:
                draft.generation_error = wa_message or "WhatsApp (Meta) send failed"
            elif requested_wa_personal and not wa_personal_ok:
                draft.generation_error = wa_personal_message or "WhatsApp Personal send failed"
            else:
                draft.generation_error = None
    else:
        draft.status = "ready"
        draft.generation_error = email_message or wa_message or "Send failed"

    db.commit()
    db.refresh(draft)

    from modules.audit import log_action
    from modules import activity as activity_module

    log_action(
        db,
        entity_type="personalized_followup",
        entity_id=draft.id,
        action="sent" if email_done and wa_done else "send_partial",
        actor=user.username,
        details={
            "channels": sorted(channel_set),
            "email_status": email_status,
            "whatsapp_status": wa_status,
            "buyer_id": draft.buyer_id,
            "template_name": template_name,
        },
    )

    if requested_email and email_ok:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.PERSONAL_EMAILS_SENT,
            title="Personal email sent",
            summary=f"Personalized follow-up email (draft #{draft.id})",
            quantity=1,
            entity_type="personalized_followup",
            entity_id=draft.id,
            details={"mode": "personalized_followup", "channel": "email", "buyer_id": draft.buyer_id},
        )
    if requested_wa and wa_ok:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.PERSONAL_WHATSAPP_SENT,
            title="Personal WhatsApp sent",
            summary=f"Personalized follow-up WhatsApp (draft #{draft.id})",
            quantity=1,
            entity_type="personalized_followup",
            entity_id=draft.id,
            details={"mode": "personalized_followup", "channel": "whatsapp", "buyer_id": draft.buyer_id},
        )

    if requested_email and requested_wa:
        if email_ok and wa_ok:
            message = "Email and WhatsApp sent."
        elif email_ok:
            message = f"Email sent; WhatsApp not sent: {wa_message}"
        elif wa_ok:
            message = f"WhatsApp sent; email not sent: {email_message}"
        else:
            message = f"Send failed: {email_message or wa_message}"
    elif requested_email:
        message = "Email sent." if email_ok else f"Email not sent: {email_message}"
    else:
        message = "WhatsApp sent." if wa_ok else f"WhatsApp not sent: {wa_message}"

    return {
        "draft": draft_to_dict(db, draft),
        "email_sent": email_ok if requested_email else False,
        "whatsapp_sent": wa_ok if requested_wa else False,
        "needs_whatsapp_template": bool(
            requested_wa
            and not wa_ok
            and wa_message
            and "template" in (wa_message or "").lower()
        ),
        "message": message,
    }
