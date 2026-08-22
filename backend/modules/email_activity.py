"""Email activity notifications — outbound send lifecycle events for the dashboard."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import or_
from sqlalchemy.orm import Session

from db.models import AppUser, EmailActivityEvent

DEFAULT_PAGE_SIZE = 25

ActivityChannel = Literal["email", "whatsapp"]


def _is_whatsapp_event_clause():
    """Match WhatsApp activity rows (details.channel or title prefix for legacy rows)."""
    return or_(
        EmailActivityEvent.details.op("->>")("channel") == "whatsapp",
        EmailActivityEvent.title.ilike("WhatsApp%"),
    )


def _is_email_event_clause():
    """Email activity rows — NULL-safe inverse of WhatsApp filter.

    Plain ``~whatsapp_clause`` wrongly drops rows where details.channel is NULL
    because ``NOT (NULL OR false)`` is NULL in SQL three-valued logic. Open
    events from the tracking pixel have no details.channel set.
    """
    from sqlalchemy import func as sa_func

    channel = sa_func.coalesce(EmailActivityEvent.details.op("->>")("channel"), "")
    return sa_func.lower(channel) != "whatsapp", ~EmailActivityEvent.title.ilike("WhatsApp%")


def _scoped_query(
    db: Session,
    *,
    user_id: int | None,
    is_admin: bool,
    channel: ActivityChannel | None = None,
):
    """Admins see all events; other users only see their own."""
    query = db.query(EmailActivityEvent)
    if not is_admin:
        if user_id is None:
            return query.filter(EmailActivityEvent.id < 0)
        query = query.filter(EmailActivityEvent.user_id == user_id)
    if channel == "whatsapp":
        query = query.filter(_is_whatsapp_event_clause())
    elif channel == "email":
        query = query.filter(*_is_email_event_clause())
    return query


def _actor_user_id(mailbox_user) -> int | None:
    if mailbox_user is None:
        return None
    return getattr(mailbox_user, "id", None)

# Canonical event types. Some are emitted today; others are reserved for ESP/webhook tracking.
EVENT_CATALOG: dict[str, dict[str, str]] = {
    "send_started": {
        "label": "Send started",
        "description": "Outbound send was initiated for one or more recipients.",
    },
    "sent": {
        "label": "Email sent",
        "description": "SMTP accepted the message and the send completed successfully.",
    },
    "send_failed": {
        "label": "Send failed",
        "description": "The provider rejected the send or an unexpected error occurred.",
    },
    "mailbox_not_configured": {
        "label": "Mailbox not configured",
        "description": "Outbound email credentials are missing or incomplete.",
    },
    "invalid_recipient": {
        "label": "Invalid recipient",
        "description": "No usable email address was found for the contact.",
    },
    "authentication_failed": {
        "label": "Authentication failed",
        "description": "SMTP/OAuth login to the mailbox failed.",
    },
    "network_error": {
        "label": "Network error",
        "description": "Could not reach the mail server (timeout, DNS, connection).",
    },
    "attachment_rejected": {
        "label": "Attachment rejected",
        "description": "An attachment was too large, blocked, or unreadable.",
    },
    "rate_limited": {
        "label": "Rate limited",
        "description": "Sending paused or blocked by provider daily/hourly limits.",
    },
    "bulk_started": {
        "label": "Bulk send started",
        "description": "A multi-recipient outbound batch began.",
    },
    "bulk_progress": {
        "label": "Bulk send progress",
        "description": "Intermediate status while a bulk batch is running.",
    },
    "bulk_completed": {
        "label": "Bulk send completed",
        "description": "All messages in a bulk batch finished (success and/or failure).",
    },
    "bulk_partial": {
        "label": "Bulk send partial",
        "description": "Some messages in a bulk batch sent; others failed or were skipped.",
    },
    "skipped_no_email": {
        "label": "Skipped — no email",
        "description": "Lead was skipped because no contact email was on file.",
    },
    "delivered": {
        "label": "Delivered",
        "description": "Provider confirmed delivery to the recipient mailbox (ESP webhook).",
    },
    "deferred": {
        "label": "Deferred",
        "description": "Temporary delivery delay; provider will retry.",
    },
    "bounced_soft": {
        "label": "Soft bounce",
        "description": "Temporary bounce (full mailbox, greylist) — may succeed on retry.",
    },
    "bounced_hard": {
        "label": "Hard bounce",
        "description": "Permanent bounce (invalid address, domain does not exist).",
    },
    "opened": {
        "label": "Opened",
        "description": "Recipient opened the email (tracking pixel / ESP event).",
    },
    "clicked": {
        "label": "Link clicked",
        "description": "Recipient clicked a tracked link in the email.",
    },
    "replied": {
        "label": "Reply received",
        "description": "Recipient replied to the outbound thread.",
    },
    "unsubscribed": {
        "label": "Unsubscribed",
        "description": "Recipient opted out of further outreach.",
    },
    "spam_complaint": {
        "label": "Spam complaint",
        "description": "Recipient marked the message as spam.",
    },
    "blocked": {
        "label": "Blocked",
        "description": "Message blocked by policy, denylist, or content filters.",
    },
}

SEVERITY_BY_TYPE: dict[str, str] = {
    "send_started": "info",
    "sent": "success",
    "send_failed": "error",
    "mailbox_not_configured": "warning",
    "invalid_recipient": "warning",
    "authentication_failed": "error",
    "network_error": "error",
    "attachment_rejected": "warning",
    "rate_limited": "warning",
    "bulk_started": "info",
    "bulk_progress": "info",
    "bulk_completed": "success",
    "bulk_partial": "warning",
    "skipped_no_email": "warning",
    "delivered": "success",
    "deferred": "warning",
    "bounced_soft": "warning",
    "bounced_hard": "error",
    "opened": "success",
    "clicked": "success",
    "replied": "success",
    "unsubscribed": "warning",
    "spam_complaint": "error",
    "blocked": "error",
}


def classify_send_result(send_result: dict | None) -> str:
    """Map mail_client/outlook status payloads to a canonical event type."""
    if not send_result:
        return "send_failed"
    status = str(send_result.get("status") or "").lower()
    message = str(send_result.get("message") or "").lower()
    if status == "sent":
        return "sent"
    if status == "not_configured":
        return "mailbox_not_configured"
    if "auth" in message or "login" in message or "credential" in message:
        return "authentication_failed"
    if "timeout" in message or "connection" in message or "network" in message:
        return "network_error"
    if "attachment" in message or "too large" in message:
        return "attachment_rejected"
    if "rate" in message or "limit" in message or "throttle" in message:
        return "rate_limited"
    if "invalid" in message or "recipient" in message or "address" in message:
        return "invalid_recipient"
    if "block" in message or "spam" in message or "policy" in message:
        return "blocked"
    return "send_failed"


def record_event(
    db: Session,
    *,
    event_type: str,
    title: str,
    message: str,
    user_id: int | None = None,
    buyer_id: int | None = None,
    contact_id: int | None = None,
    interaction_id: int | None = None,
    details: dict[str, Any] | None = None,
    severity: str | None = None,
    mailbox_user=None,
) -> EmailActivityEvent:
    actor_id = user_id if user_id is not None else _actor_user_id(mailbox_user)
    event = EmailActivityEvent(
        event_type=event_type,
        severity=severity or SEVERITY_BY_TYPE.get(event_type, "info"),
        title=title,
        message=message,
        user_id=actor_id,
        buyer_id=buyer_id,
        contact_id=contact_id,
        interaction_id=interaction_id,
        details=details or {},
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


def record_send_result(
    db: Session,
    *,
    send_result: dict | None,
    company_name: str,
    to_email: str | None,
    user_id: int | None = None,
    buyer_id: int | None = None,
    contact_id: int | None = None,
    interaction_id: int | None = None,
    subject: str | None = None,
    send_mode: str = "individual",
    mailbox_user=None,
) -> EmailActivityEvent:
    event_type = classify_send_result(send_result)
    catalog = EVENT_CATALOG.get(event_type, {})
    provider_message = (send_result or {}).get("message") or catalog.get("description", "")
    mode = "bulk" if send_mode == "bulk" else "individual"
    if event_type == "sent":
        title = f"Sent to {company_name}"
        message = f"Email delivered to outbound queue for {to_email or 'recipient'}."
        if subject:
            message = f"“{subject}” sent to {to_email or 'recipient'}."
    elif event_type == "mailbox_not_configured":
        title = "Mailbox not configured"
        message = str(provider_message)
    else:
        title = f"Send failed — {company_name}"
        message = str(provider_message) or f"Could not send to {to_email or company_name}."

    return record_event(
        db,
        event_type=event_type,
        title=title,
        message=message,
        user_id=user_id,
        buyer_id=buyer_id,
        contact_id=contact_id,
        interaction_id=interaction_id,
        mailbox_user=mailbox_user,
        details={
            "company_name": company_name,
            "to_email": to_email,
            "subject": subject,
            "send_result": send_result,
            "send_mode": mode,
        },
    )


def list_events(
    db: Session,
    *,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
    unread_only: bool = False,
    user_id: int | None = None,
    is_admin: bool = False,
    channel: ActivityChannel | None = "email",
) -> tuple[list[EmailActivityEvent], int, int]:
    page = max(1, page)
    page_size = min(max(1, page_size), 100)
    query = _scoped_query(db, user_id=user_id, is_admin=is_admin, channel=channel)
    if unread_only:
        query = query.filter(EmailActivityEvent.read_at.is_(None))
    total = query.count()
    unread = (
        _scoped_query(db, user_id=user_id, is_admin=is_admin, channel=channel)
        .filter(EmailActivityEvent.read_at.is_(None))
        .count()
    )
    rows = (
        query.order_by(EmailActivityEvent.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return rows, total, unread


def mark_read(
    db: Session,
    event_ids: list[int] | None = None,
    *,
    mark_all: bool = False,
    user_id: int | None = None,
    is_admin: bool = False,
    channel: ActivityChannel | None = None,
) -> int:
    now = datetime.now(timezone.utc)
    query = _scoped_query(db, user_id=user_id, is_admin=is_admin, channel=channel).filter(
        EmailActivityEvent.read_at.is_(None)
    )
    if mark_all:
        updated = query.update({EmailActivityEvent.read_at: now}, synchronize_session=False)
    elif event_ids:
        updated = query.filter(EmailActivityEvent.id.in_(event_ids)).update(
            {EmailActivityEvent.read_at: now},
            synchronize_session=False,
        )
    else:
        return 0
    db.commit()
    return int(updated or 0)


WHATSAPP_EVENT_LABELS: dict[str, str] = {
    "sent": "Sent",
    "send_failed": "Failed",
    "bulk_started": "Bulk started",
    "bulk_completed": "Bulk completed",
    "bulk_partial": "Bulk partial",
    "invalid_recipient": "Invalid recipient",
}


def _is_whatsapp_event(event: EmailActivityEvent) -> bool:
    details = event.details if isinstance(event.details, dict) else {}
    title = event.title or ""
    channel = str(details.get("channel") or "").lower()
    return (
        channel == "whatsapp"
        or title.startswith("WhatsApp")
        or title.startswith("Bulk WhatsApp")
        or "WhatsApp" in title
    )


def _whatsapp_event_label(event: EmailActivityEvent) -> str:
    if event.event_type in WHATSAPP_EVENT_LABELS:
        return WHATSAPP_EVENT_LABELS[event.event_type]
    return event.event_type.replace("_", " ").title()


def _event_label(
    event: EmailActivityEvent,
    *,
    channel: ActivityChannel | None = None,
) -> str:
    if channel == "whatsapp" or _is_whatsapp_event(event):
        return _whatsapp_event_label(event)
    catalog = EVENT_CATALOG.get(event.event_type, {})
    return catalog.get("label", event.event_type.replace("_", " ").title())


def event_to_dict(
    event: EmailActivityEvent,
    *,
    actor: AppUser | None = None,
    channel: ActivityChannel | None = None,
) -> dict[str, Any]:
    return {
        "id": event.id,
        "event_type": event.event_type,
        "event_label": _event_label(event, channel=channel),
        "severity": event.severity,
        "title": event.title,
        "message": event.message,
        "user_id": event.user_id,
        "user_username": actor.username if actor else None,
        "user_full_name": (actor.full_name if actor else None) or None,
        "buyer_id": event.buyer_id,
        "contact_id": event.contact_id,
        "interaction_id": event.interaction_id,
        "details": event.details or {},
        "read_at": event.read_at.isoformat() if event.read_at else None,
        "created_at": event.created_at.isoformat() if event.created_at else None,
    }


def actors_for_events(db: Session, events: list[EmailActivityEvent]) -> dict[int, AppUser]:
    user_ids = {e.user_id for e in events if e.user_id is not None}
    if not user_ids:
        return {}
    rows = db.query(AppUser).filter(AppUser.id.in_(user_ids)).all()
    return {row.id: row for row in rows}


def catalog_list() -> list[dict[str, str]]:
    return [
        {
            "event_type": key,
            "label": meta["label"],
            "description": meta["description"],
            "severity": SEVERITY_BY_TYPE.get(key, "info"),
        }
        for key, meta in EVENT_CATALOG.items()
    ]


_FAIL_TYPES = {
    "send_failed",
    "mailbox_not_configured",
    "invalid_recipient",
    "authentication_failed",
    "network_error",
    "attachment_rejected",
    "rate_limited",
    "blocked",
}


def insights_stats(
    db: Session,
    *,
    days: int | None = 30,
    date_from: str | None = None,
    date_to: str | None = None,
    user_id: int | None = None,
    is_admin: bool = False,
    channel: ActivityChannel | None = "email",
) -> dict[str, Any]:
    """Aggregate outbound activity into bulk vs individual insight cards."""
    from datetime import date, time, timedelta

    query = _scoped_query(db, user_id=user_id, is_admin=is_admin, channel=channel)
    since = None
    until = None
    period_days = days

    def _parse_day(value: str | None, *, end_of_day: bool) -> datetime | None:
        if not value:
            return None
        raw = value.strip()
        if not raw:
            return None
        try:
            day = date.fromisoformat(raw[:10])
        except ValueError as exc:
            raise ValueError(f"Invalid date '{value}'. Use YYYY-MM-DD.") from exc
        if end_of_day:
            return datetime.combine(day, time(23, 59, 59, 999999), tzinfo=timezone.utc)
        return datetime.combine(day, time.min, tzinfo=timezone.utc)

    if date_from or date_to:
        since = _parse_day(date_from, end_of_day=False)
        until = _parse_day(date_to, end_of_day=True)
        if since and until and until < since:
            raise ValueError("date_to must be on or after date_from")
        if since is not None:
            query = query.filter(EmailActivityEvent.created_at >= since)
        if until is not None:
            query = query.filter(EmailActivityEvent.created_at <= until)
        if since and until:
            period_days = max(1, (until.date() - since.date()).days + 1)
        else:
            period_days = None
    elif days and days > 0:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        query = query.filter(EmailActivityEvent.created_at >= since)
        period_days = days
    else:
        period_days = None

    rows = list(query.all())

    # Include opens that were stored without user_id but belong to this user's sends
    # (older bulk/mailer paths). Admins already see all rows via _scoped_query.
    if user_id is not None and not is_admin:
        sent_interaction_ids = {
            e.interaction_id
            for e in rows
            if e.event_type == "sent" and e.interaction_id is not None
        }
        if sent_interaction_ids:
            seen_open_ids = {e.id for e in rows if e.event_type == "opened"}
            orphan_q = db.query(EmailActivityEvent).filter(
                EmailActivityEvent.event_type == "opened",
                EmailActivityEvent.interaction_id.in_(sent_interaction_ids),
                EmailActivityEvent.user_id.is_(None),
            )
            if since is not None:
                orphan_q = orphan_q.filter(EmailActivityEvent.created_at >= since)
            if until is not None:
                orphan_q = orphan_q.filter(EmailActivityEvent.created_at <= until)
            for orphan in orphan_q.all():
                if orphan.id not in seen_open_ids:
                    rows.append(orphan)

    individual_sent = 0
    individual_failed = 0
    individual_opened = 0
    bulk_sent = 0
    bulk_failed = 0
    bulk_opened = 0
    bulk_batches = 0
    bulk_batches_partial = 0
    bulk_batches_failed = 0

    for event in rows:
        details = event.details or {}
        mode = str(details.get("send_mode") or "").lower()
        et = event.event_type

        if et == "opened":
            if mode == "bulk":
                bulk_opened += 1
            else:
                individual_opened += 1
            continue

        if et in ("bulk_completed", "bulk_partial"):
            bulk_batches += 1
            if et == "bulk_partial":
                bulk_batches_partial += 1
            try:
                bulk_sent += int(details.get("sent_count") or 0)
            except (TypeError, ValueError):
                pass
            try:
                bulk_failed += int(details.get("failed_count") or 0)
            except (TypeError, ValueError):
                pass
            continue

        if et == "bulk_started":
            continue

        if et == "sent":
            if mode == "bulk":
                bulk_sent += 1
            else:
                individual_sent += 1
            continue

        if et in _FAIL_TYPES:
            # Bulk batch-level total failure (0 sent)
            if et == "send_failed" and (
                "sent_count" in details or "failed_count" in details or "interaction_ids" in details
            ):
                bulk_batches += 1
                bulk_batches_failed += 1
                try:
                    bulk_failed += int(details.get("failed_count") or 0)
                except (TypeError, ValueError):
                    pass
            elif mode == "bulk":
                bulk_failed += 1
            else:
                individual_failed += 1

    individual_total = individual_sent + individual_failed
    bulk_total = bulk_sent + bulk_failed
    total_sent = individual_sent + bulk_sent
    total_failed = individual_failed + bulk_failed
    total_opened = individual_opened + bulk_opened
    total_attempted = total_sent + total_failed
    not_opened = max(0, total_sent - total_opened)

    def _rate(part: int, whole: int) -> float:
        if whole <= 0:
            return 0.0
        return round((part / whole) * 100.0, 1)

    from modules.email_tracking import public_api_base

    tracking_base = public_api_base()

    return {
        "period_days": period_days,
        "since": since.isoformat() if since else None,
        "until": until.isoformat() if until else None,
        "tracking_enabled": bool(tracking_base),
        "tracking_base_url": tracking_base,
        "tracking_pixel_path": "/api/track/email-open/{token}.gif",
        "totals": {
            "attempted": total_attempted,
            "sent": total_sent,
            "failed": total_failed,
            "opened": total_opened,
            "not_opened": not_opened,
            "open_rate_pct": _rate(total_opened, total_sent),
            "success_rate_pct": _rate(total_sent, total_attempted),
        },
        "individual": {
            "attempted": individual_total,
            "sent": individual_sent,
            "failed": individual_failed,
            "opened": individual_opened,
            "not_opened": max(0, individual_sent - individual_opened),
            "open_rate_pct": _rate(individual_opened, individual_sent),
            "success_rate_pct": _rate(individual_sent, individual_total),
        },
        "bulk": {
            "batches": bulk_batches,
            "batches_partial": bulk_batches_partial,
            "batches_failed": bulk_batches_failed,
            "attempted": bulk_total,
            "sent": bulk_sent,
            "failed": bulk_failed,
            "opened": bulk_opened,
            "not_opened": max(0, bulk_sent - bulk_opened),
            "open_rate_pct": _rate(bulk_opened, bulk_sent),
            "success_rate_pct": _rate(bulk_sent, bulk_total),
        },
        "event_count": len(rows),
    }
