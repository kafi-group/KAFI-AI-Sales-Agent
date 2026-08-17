"""User activity logging and daily KPI report aggregation."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from db.models import AppUser, AppUserRole, UserActivityEvent

KPI_TIMEZONE = ZoneInfo("Asia/Karachi")

# Activity type constants
CALL_LOGGED = "call_logged"
CALL_OUTCOME = "call_outcome"
CALL_REMARKS = "call_remarks"
LEADS_IMPORTED = "leads_imported"
TABLE_ROW_EDITED = "table_row_edited"
EMAIL_TEMPLATE_CREATED = "email_template_created"
PERSONAL_EMAILS_SENT = "personal_emails_sent"
BULK_EMAILS_SENT = "bulk_emails_sent"
PERSONAL_WHATSAPP_SENT = "personal_whatsapp_sent"
BULK_WHATSAPP_SENT = "bulk_whatsapp_sent"
INBOX_REPLIED = "inbox_replied"
BRAND_ASSISTANT_SESSION = "brand_assistant_session"

_OUTCOME_LABELS = {
    "interested": "Client is Interested",
    "follow_up": "Follow up",
    "not_interested": "Not interested",
    "not_received_call": "Did not receive call",
}

_EMPTY_COUNTS = {
    "calls_logged": 0,
    "outcomes_interested": 0,
    "outcomes_follow_up": 0,
    "outcomes_not_interested": 0,
    "outcomes_not_received_call": 0,
    "call_remarks": 0,
    "leads_imported": 0,
    "table_edits": 0,
    "email_templates_created": 0,
    "personal_emails_sent": 0,
    "emails_after_calls": 0,
    "emails_other_personal": 0,
    "bulk_emails_sent": 0,
    "personal_whatsapp_sent": 0,
    "bulk_whatsapp_sent": 0,
    "inbox_replies": 0,
    "brand_assistant_sessions": 0,
}


def log_activity(
    db: Session,
    *,
    user_id: int,
    activity_type: str,
    title: str,
    summary: str,
    quantity: int = 1,
    entity_type: str | None = None,
    entity_id: int | None = None,
    details: dict | None = None,
) -> UserActivityEvent:
    entry = UserActivityEvent(
        user_id=user_id,
        activity_type=activity_type,
        title=title,
        summary=summary,
        quantity=max(1, int(quantity or 1)),
        entity_type=entity_type,
        entity_id=entity_id,
        details=details,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def day_bounds_utc(report_date: date) -> tuple[datetime, datetime]:
    """Return [start, end) for the report date in Asia/Karachi, as UTC datetimes."""
    start_local = datetime.combine(report_date, time.min, tzinfo=KPI_TIMEZONE)
    end_local = start_local + timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def period_bounds(
    report_date: date,
    period: str,
) -> tuple[date, date, datetime, datetime]:
    """Return (start_date, end_date_inclusive, start_utc, end_utc_exclusive).

    Weeks are Monday–Sunday (ISO). Months are calendar months.
    """
    normalized = (period or "day").strip().lower()
    if normalized in {"week", "weekly"}:
        # Monday = 0 … Sunday = 6
        start_date = report_date - timedelta(days=report_date.weekday())
        end_date = start_date + timedelta(days=6)
    elif normalized in {"month", "monthly"}:
        start_date = report_date.replace(day=1)
        if start_date.month == 12:
            next_month = start_date.replace(year=start_date.year + 1, month=1)
        else:
            next_month = start_date.replace(month=start_date.month + 1)
        end_date = next_month - timedelta(days=1)
    else:
        start_date = report_date
        end_date = report_date

    start_local = datetime.combine(start_date, time.min, tzinfo=KPI_TIMEZONE)
    end_local = datetime.combine(end_date + timedelta(days=1), time.min, tzinfo=KPI_TIMEZONE)
    return (
        start_date,
        end_date,
        start_local.astimezone(timezone.utc),
        end_local.astimezone(timezone.utc),
    )


def _normalize_period(period: str | None) -> str:
    value = (period or "day").strip().lower()
    if value in {"week", "weekly"}:
        return "week"
    if value in {"month", "monthly"}:
        return "month"
    return "day"


def _empty_counts() -> dict[str, int]:
    return dict(_EMPTY_COUNTS)


def _bump_counts(counts: dict[str, int], event: UserActivityEvent) -> None:
    qty = max(1, int(event.quantity or 1))
    kind = event.activity_type
    if kind == CALL_LOGGED:
        counts["calls_logged"] += qty
    elif kind == CALL_OUTCOME:
        outcome = (event.details or {}).get("outcome") or ""
        if outcome == "interested":
            counts["outcomes_interested"] += qty
        elif outcome == "follow_up":
            counts["outcomes_follow_up"] += qty
        elif outcome == "not_interested":
            counts["outcomes_not_interested"] += qty
        elif outcome == "not_received_call":
            counts["outcomes_not_received_call"] += qty
    elif kind == CALL_REMARKS:
        counts["call_remarks"] += qty
    elif kind == LEADS_IMPORTED:
        counts["leads_imported"] += qty
    elif kind == TABLE_ROW_EDITED:
        counts["table_edits"] += qty
    elif kind == EMAIL_TEMPLATE_CREATED:
        counts["email_templates_created"] += qty
    elif kind == PERSONAL_EMAILS_SENT:
        counts["personal_emails_sent"] += qty
    elif kind == BULK_EMAILS_SENT:
        counts["bulk_emails_sent"] += qty
    elif kind == PERSONAL_WHATSAPP_SENT:
        counts["personal_whatsapp_sent"] += qty
    elif kind == BULK_WHATSAPP_SENT:
        counts["bulk_whatsapp_sent"] += qty
    elif kind == INBOX_REPLIED:
        counts["inbox_replies"] += qty
    elif kind == BRAND_ASSISTANT_SESSION:
        counts["brand_assistant_sessions"] += qty


def _is_whatsapp_activity_event(event: Any) -> bool:
    details = getattr(event, "details", None) or {}
    if str(details.get("channel") or "").lower() == "whatsapp":
        return True
    title = str(getattr(event, "title", "") or "")
    return title.lower().startswith("whatsapp")


def _empty_email_bucket() -> dict[str, int]:
    return {
        "personal_emails_sent": 0,
        "emails_after_calls": 0,
        "emails_other_personal": 0,
        "bulk_emails_sent": 0,
    }


def _email_send_counts_by_user(
    db: Session,
    *,
    start_utc: datetime,
    end_utc: datetime,
    user_id: int | None = None,
) -> dict[int, dict[str, int]]:
    """Count personal vs bulk email sends from email_activity_events (email only)."""
    from db.models import EmailActivityEvent

    query = db.query(EmailActivityEvent).filter(
        EmailActivityEvent.created_at >= start_utc,
        EmailActivityEvent.created_at < end_utc,
        EmailActivityEvent.user_id.isnot(None),
    )
    if user_id is not None:
        query = query.filter(EmailActivityEvent.user_id == user_id)

    by_user: dict[int, dict[str, int]] = {}
    for event in query.all():
        if _is_whatsapp_activity_event(event):
            continue
        uid = event.user_id
        if uid is None:
            continue
        bucket = by_user.setdefault(uid, _empty_email_bucket())
        details = event.details or {}
        mode = str(details.get("send_mode") or "").lower()
        et = event.event_type

        if et in ("bulk_completed", "bulk_partial"):
            try:
                bucket["bulk_emails_sent"] += max(0, int(details.get("sent_count") or 0))
            except (TypeError, ValueError):
                pass
            continue

        if et == "sent":
            # Per-message bulk rows are suppressed by the mailer; still ignore mode=bulk.
            if mode == "bulk":
                continue
            bucket["personal_emails_sent"] += 1
            if event.interaction_id is not None:
                bucket["emails_after_calls"] += 1
            else:
                bucket["emails_other_personal"] += 1

    return by_user


def _whatsapp_send_counts_by_user(
    db: Session,
    *,
    start_utc: datetime,
    end_utc: datetime,
    user_id: int | None = None,
) -> dict[int, dict[str, int]]:
    """Count personal vs bulk WhatsApp sends from email_activity_events (WA channel)."""
    from db.models import EmailActivityEvent

    query = db.query(EmailActivityEvent).filter(
        EmailActivityEvent.created_at >= start_utc,
        EmailActivityEvent.created_at < end_utc,
        EmailActivityEvent.user_id.isnot(None),
    )
    if user_id is not None:
        query = query.filter(EmailActivityEvent.user_id == user_id)

    by_user: dict[int, dict[str, int]] = {}
    for event in query.all():
        if not _is_whatsapp_activity_event(event):
            continue
        uid = event.user_id
        if uid is None:
            continue
        bucket = by_user.setdefault(
            uid,
            {"personal_whatsapp_sent": 0, "bulk_whatsapp_sent": 0},
        )
        details = event.details or {}
        mode = str(details.get("send_mode") or "").lower()
        et = event.event_type

        if et in ("bulk_completed", "bulk_partial"):
            try:
                bucket["bulk_whatsapp_sent"] += max(0, int(details.get("sent_count") or 0))
            except (TypeError, ValueError):
                pass
            continue

        if et == "sent":
            if mode == "bulk":
                continue
            bucket["personal_whatsapp_sent"] += 1

    return by_user


def _apply_email_activity_counts(
    counts: dict[str, int],
    email_counts: dict[str, int] | None,
) -> None:
    """Prefer Email Activity totals for personal/bulk so KPI matches the activity feed."""
    if not email_counts:
        return
    personal = int(email_counts.get("personal_emails_sent") or 0)
    bulk = int(email_counts.get("bulk_emails_sent") or 0)
    after_calls = int(email_counts.get("emails_after_calls") or 0)
    other_personal = int(email_counts.get("emails_other_personal") or 0)
    # Take the higher of logged KPI events vs Email Activity (covers both writers).
    counts["personal_emails_sent"] = max(int(counts.get("personal_emails_sent") or 0), personal)
    counts["bulk_emails_sent"] = max(int(counts.get("bulk_emails_sent") or 0), bulk)
    counts["emails_after_calls"] = max(int(counts.get("emails_after_calls") or 0), after_calls)
    counts["emails_other_personal"] = max(
        int(counts.get("emails_other_personal") or 0), other_personal
    )


def _email_attribution_note(counts: dict[str, int]) -> str:
    """Plain-language link between calls and emails for KPI reports."""
    calls = int(counts.get("calls_logged") or 0)
    after_calls = int(counts.get("emails_after_calls") or 0)
    other = int(counts.get("emails_other_personal") or 0)
    bulk = int(counts.get("bulk_emails_sent") or 0)
    inbox = int(counts.get("inbox_replies") or 0)
    personal_total = int(counts.get("personal_emails_sent") or 0)
    email_total = personal_total + bulk

    if email_total == 0 and calls == 0:
        return ""

    parts: list[str] = []
    if calls:
        parts.append(f"{calls} call{'s' if calls != 1 else ''}")
    if after_calls:
        parts.append(
            f"{after_calls} email{'s' if after_calls != 1 else ''} linked to calls "
            f"(post-call / personalized follow-up)"
        )
    if other:
        parts.append(
            f"{other} other personal email{'s' if other != 1 else ''} "
            f"(table outreach, mailer, manual compose — not tied to a call log)"
        )
    if bulk:
        parts.append(f"{bulk} bulk email{'s' if bulk != 1 else ''} (batch sends)")
    if inbox:
        parts.append(f"{inbox} inbox repl{'ies' if inbox != 1 else 'y'}")

    if not parts:
        return ""

    note = " · ".join(parts) + "."
    if calls and after_calls > calls:
        note += (
            f" Note: {after_calls - calls} more call-linked email(s) than calls — "
            "multiple follow-ups or emails per conversation."
        )
    elif calls and personal_total + bulk > calls and after_calls <= calls:
        extra = personal_total + bulk - after_calls
        if extra > 0:
            note += (
                f" Remaining {extra} email(s) are bulk or non-call personal sends."
            )
    return note


def _apply_whatsapp_activity_counts(
    counts: dict[str, int],
    wa_counts: dict[str, int] | None,
) -> None:
    """Merge WhatsApp Activity feed totals with KPI activity logs."""
    if not wa_counts:
        return
    personal = int(wa_counts.get("personal_whatsapp_sent") or 0)
    bulk = int(wa_counts.get("bulk_whatsapp_sent") or 0)
    counts["personal_whatsapp_sent"] = max(int(counts.get("personal_whatsapp_sent") or 0), personal)
    counts["bulk_whatsapp_sent"] = max(int(counts.get("bulk_whatsapp_sent") or 0), bulk)


def _user_brief(user: AppUser | None) -> dict[str, Any] | None:
    if not user:
        return None
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "role": role,
    }


def _activity_dict(event: UserActivityEvent, user: AppUser | None) -> dict[str, Any]:
    return {
        "id": event.id,
        "user_id": event.user_id,
        "username": user.username if user else None,
        "full_name": user.full_name if user else None,
        "activity_type": event.activity_type,
        "title": event.title,
        "summary": event.summary,
        "quantity": event.quantity,
        "entity_type": event.entity_type,
        "entity_id": event.entity_id,
        "details": event.details,
        "created_at": event.created_at,
    }


def get_kpi_report(
    db: Session,
    *,
    report_date: date,
    viewer: AppUser,
    user_id: int | None = None,
    period: str = "day",
) -> dict[str, Any]:
    """Build a day/week/month activity report for one user or (admins) the whole team."""
    role = viewer.role.value if isinstance(viewer.role, AppUserRole) else str(viewer.role)
    is_admin = role == AppUserRole.admin.value
    normalized_period = _normalize_period(period)

    target_user_id = user_id
    if not is_admin:
        target_user_id = viewer.id
    elif user_id is not None:
        target = db.get(AppUser, user_id)
        if not target:
            raise ValueError("User not found")

    start_date, end_date, start_utc, end_utc = period_bounds(report_date, normalized_period)
    query = (
        db.query(UserActivityEvent)
        .filter(
            UserActivityEvent.created_at >= start_utc,
            UserActivityEvent.created_at < end_utc,
        )
        .order_by(UserActivityEvent.created_at.desc(), UserActivityEvent.id.desc())
    )
    if target_user_id is not None:
        query = query.filter(UserActivityEvent.user_id == target_user_id)

    events = query.all()
    email_by_user = _email_send_counts_by_user(
        db,
        start_utc=start_utc,
        end_utc=end_utc,
        user_id=target_user_id,
    )
    wa_by_user = _whatsapp_send_counts_by_user(
        db,
        start_utc=start_utc,
        end_utc=end_utc,
        user_id=target_user_id,
    )
    user_ids = {e.user_id for e in events} | set(email_by_user.keys()) | set(wa_by_user.keys())
    if target_user_id is not None:
        user_ids.add(target_user_id)
    users = {
        u.id: u
        for u in db.query(AppUser).filter(AppUser.id.in_(user_ids)).all()
    } if user_ids else {}

    counts = _empty_counts()
    for event in events:
        _bump_counts(counts, event)
    if target_user_id is not None:
        _apply_email_activity_counts(counts, email_by_user.get(target_user_id))
        _apply_whatsapp_activity_counts(counts, wa_by_user.get(target_user_id))
    else:
        # Team rollup: sum Email/WhatsApp Activity across users (then max with KPI logs).
        email_totals = _empty_email_bucket()
        for bucket in email_by_user.values():
            for key in email_totals:
                email_totals[key] += int(bucket.get(key) or 0)
        _apply_email_activity_counts(counts, email_totals)
        wa_totals = {"personal_whatsapp_sent": 0, "bulk_whatsapp_sent": 0}
        for bucket in wa_by_user.values():
            wa_totals["personal_whatsapp_sent"] += int(bucket.get("personal_whatsapp_sent") or 0)
            wa_totals["bulk_whatsapp_sent"] += int(bucket.get("bulk_whatsapp_sent") or 0)
        _apply_whatsapp_activity_counts(counts, wa_totals)

    activities = [_activity_dict(e, users.get(e.user_id)) for e in events]

    per_user: list[dict[str, Any]] = []
    scope = "user"
    focus_user = users.get(target_user_id) if target_user_id is not None else None

    if is_admin and target_user_id is None:
        scope = "team"
        by_user: dict[int, dict[str, Any]] = {}
        for event in events:
            bucket = by_user.get(event.user_id)
            if bucket is None:
                u = users.get(event.user_id)
                bucket = {
                    "user": _user_brief(u),
                    "counts": _empty_counts(),
                    "activity_count": 0,
                }
                by_user[event.user_id] = bucket
            _bump_counts(bucket["counts"], event)
            bucket["activity_count"] += 1
        for uid, email_counts in email_by_user.items():
            bucket = by_user.get(uid)
            if bucket is None:
                u = users.get(uid)
                bucket = {
                    "user": _user_brief(u),
                    "counts": _empty_counts(),
                    "activity_count": 0,
                }
                by_user[uid] = bucket
            _apply_email_activity_counts(bucket["counts"], email_counts)
        for uid, wa_counts in wa_by_user.items():
            bucket = by_user.get(uid)
            if bucket is None:
                u = users.get(uid)
                bucket = {
                    "user": _user_brief(u),
                    "counts": _empty_counts(),
                    "activity_count": 0,
                }
                by_user[uid] = bucket
            _apply_whatsapp_activity_counts(bucket["counts"], wa_counts)
        per_user = sorted(
            by_user.values(),
            key=lambda row: ((row["user"] or {}).get("full_name") or "").lower(),
        )

    return {
        "date": report_date.isoformat(),
        "period": normalized_period,
        "date_start": start_date.isoformat(),
        "date_end": end_date.isoformat(),
        "timezone": "Asia/Karachi",
        "scope": scope,
        "user": _user_brief(focus_user) if scope == "user" else None,
        "counts": counts,
        "email_attribution_note": _email_attribution_note(counts),
        "per_user": per_user,
        "activities": activities,
        "activity_count": len(activities),
    }


def get_daily_kpi(
    db: Session,
    *,
    report_date: date,
    viewer: AppUser,
    user_id: int | None = None,
) -> dict[str, Any]:
    """Backward-compatible daily wrapper."""
    return get_kpi_report(
        db,
        report_date=report_date,
        viewer=viewer,
        user_id=user_id,
        period="day",
    )


def _period_words(period: str, date_start: str, date_end: str) -> tuple[str, str]:
    if period == "week":
        return "Weekly", f"{date_start} to {date_end}"
    if period == "month":
        return "Monthly", f"{date_start} to {date_end}"
    return "Daily", date_start


def _subject_line(report: dict[str, Any]) -> str:
    period_label, range_label = _period_words(
        report.get("period") or "day",
        report.get("date_start") or report.get("date") or "",
        report.get("date_end") or report.get("date") or "",
    )
    if report.get("scope") == "team":
        who = "Sales team"
    else:
        user = report.get("user") or {}
        who = user.get("full_name") or user.get("username") or "Sales rep"
    return f"{period_label} KPI — {who} ({range_label})"


def _build_rule_based_summary(report: dict[str, Any]) -> str:
    counts = report.get("counts") or {}
    period_label, range_label = _period_words(
        report.get("period") or "day",
        report.get("date_start") or report.get("date") or "",
        report.get("date_end") or report.get("date") or "",
    )
    subject = _subject_line(report)
    activity_count = int(report.get("activity_count") or 0)

    lines = [
        subject,
        "",
        f"This {period_label.lower()} KPI covers {range_label} (Asia/Karachi).",
    ]

    if activity_count == 0:
        lines.extend(
            [
                "",
                "No tracked sales activity was recorded in this period.",
                "",
                "Ready to share with management as a status update.",
            ]
        )
        return "\n".join(lines)

    interested = int(counts.get("outcomes_interested") or 0)
    follow_up = int(counts.get("outcomes_follow_up") or 0)
    not_interested = int(counts.get("outcomes_not_interested") or 0)
    no_answer = int(counts.get("outcomes_not_received_call") or 0)

    lines.extend(
        [
            "",
            "Key volumes:",
            f"- Calls placed: {counts.get('calls_logged', 0)}",
            f"- Call outcomes: {interested} client interested, {follow_up} follow up, "
            f"{not_interested} not interested, {no_answer} did not receive call",
            f"- Call remarks added: {counts.get('call_remarks', 0)}",
            f"- Leads imported: {counts.get('leads_imported', 0)}",
            f"- Lead table edits: {counts.get('table_edits', 0)}",
            f"- Email templates created: {counts.get('email_templates_created', 0)}",
            f"- Personal emails sent: {counts.get('personal_emails_sent', 0)} "
            f"({counts.get('emails_after_calls', 0)} after calls, "
            f"{counts.get('emails_other_personal', 0)} other personal)",
            f"- Bulk emails sent: {counts.get('bulk_emails_sent', 0)}",
            f"- Personal WhatsApp sent: {counts.get('personal_whatsapp_sent', 0)}",
            f"- Bulk WhatsApp sent: {counts.get('bulk_whatsapp_sent', 0)}",
            f"- Inbox replies: {counts.get('inbox_replies', 0)}",
            f"- Brand assistant sessions: {counts.get('brand_assistant_sessions', 0)}",
            f"- Total activity events: {activity_count}",
        ]
    )
    attribution = _email_attribution_note(counts)
    if attribution:
        lines.extend(["", "Email vs calls:", attribution])

    highlights: list[str] = []
    if interested:
        highlights.append(f"{interested} interested outcome{'s' if interested != 1 else ''}")
    if follow_up:
        highlights.append(f"{follow_up} follow-up outcome{'s' if follow_up != 1 else ''}")
    if counts.get("personal_emails_sent"):
        highlights.append(
            f"{counts['personal_emails_sent']} personal email"
            f"{'s' if counts['personal_emails_sent'] != 1 else ''} sent"
        )
    if counts.get("bulk_emails_sent"):
        highlights.append(f"{counts['bulk_emails_sent']} bulk email{'s' if counts['bulk_emails_sent'] != 1 else ''} sent")
    if counts.get("personal_whatsapp_sent"):
        highlights.append(
            f"{counts['personal_whatsapp_sent']} personal WhatsApp"
            f"{'s' if counts['personal_whatsapp_sent'] != 1 else ''} sent"
        )
    if counts.get("bulk_whatsapp_sent"):
        highlights.append(
            f"{counts['bulk_whatsapp_sent']} bulk WhatsApp"
            f"{'s' if counts['bulk_whatsapp_sent'] != 1 else ''} sent"
        )
    if counts.get("leads_imported"):
        highlights.append(f"{counts['leads_imported']} lead{'s' if counts['leads_imported'] != 1 else ''} imported")
    if counts.get("calls_logged"):
        highlights.append(f"{counts['calls_logged']} call{'s' if counts['calls_logged'] != 1 else ''} logged")

    if highlights:
        lines.extend(["", "Highlights: " + "; ".join(highlights) + "."])

    per_user = report.get("per_user") or []
    if report.get("scope") == "team" and per_user:
        top = sorted(
            per_user,
            key=lambda row: int(row.get("activity_count") or 0),
            reverse=True,
        )[:5]
        bits = []
        for row in top:
            name = ((row.get("user") or {}).get("full_name")) or "Unknown"
            bits.append(f"{name} ({row.get('activity_count', 0)} events)")
        lines.extend(["", "Most active: " + ", ".join(bits) + "."])

    # Sample recent activity titles for context
    activities = report.get("activities") or []
    if activities:
        sample = activities[:8]
        lines.append("")
        lines.append("Recent activity samples:")
        for item in sample:
            title = item.get("title") or "Activity"
            summary = item.get("summary") or ""
            who = item.get("full_name") or item.get("username") or ""
            prefix = f"{who}: " if who and report.get("scope") == "team" else ""
            lines.append(f"- {prefix}{title} — {summary}")

    lines.extend(
        [
            "",
            "This summary is ready to share with management.",
        ]
    )
    return "\n".join(lines)


def _report_facts_for_llm(report: dict[str, Any]) -> str:
    counts = report.get("counts") or {}
    lines = [
        f"Subject context: {_subject_line(report)}",
        f"Period: {report.get('period')}",
        f"Date start: {report.get('date_start')}",
        f"Date end: {report.get('date_end')}",
        f"Timezone: {report.get('timezone')}",
        f"Scope: {report.get('scope')}",
        f"User: {report.get('user')}",
        f"Activity event count: {report.get('activity_count')}",
        "Counts JSON:",
        str(counts),
    ]
    per_user = report.get("per_user") or []
    if per_user:
        lines.append("Per-user rollup:")
        for row in per_user[:20]:
            u = row.get("user") or {}
            lines.append(
                f"- {u.get('full_name') or u.get('username')}: "
                f"{row.get('activity_count')} events, counts={row.get('counts')}"
            )
    activities = report.get("activities") or []
    lines.append(f"Activity list ({min(len(activities), 40)} of {len(activities)} shown):")
    for item in activities[:40]:
        lines.append(
            f"- [{item.get('created_at')}] {item.get('full_name') or item.get('username')}: "
            f"{item.get('title')} — {item.get('summary')} (qty={item.get('quantity')})"
        )
    return "\n".join(lines)


_DEFAULT_KPI_FALLBACK_MODELS = (
    "gemini-2.5-flash",
    "gemini-3.5-flash",
    "gemini-2.0-flash",
)


def _parse_kpi_csv(value: str | None) -> list[str]:
    if not value or not value.strip():
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _kpi_model_chain() -> list[str]:
    from config import settings
    from modules.llm_client import DEFAULT_MODEL, _resolve_model_name

    primary = _resolve_model_name(settings.kpi_gemini_model or DEFAULT_MODEL)
    fallbacks = _parse_kpi_csv(settings.kpi_gemini_fallback_models) or list(
        _DEFAULT_KPI_FALLBACK_MODELS
    )
    chain: list[str] = []
    for model in [primary, *fallbacks]:
        resolved = _resolve_model_name(model)
        if resolved and resolved not in chain:
            chain.append(resolved)
    return chain or [DEFAULT_MODEL]


def _get_kpi_gemini_clients() -> list[Any]:
    """Clients from KPI_GEMINI_API_KEY (+ optional KPI_GEMINI_API_KEYS only)."""
    from config import settings

    keys = _parse_kpi_csv(settings.kpi_gemini_api_keys)
    primary = (settings.kpi_gemini_api_key or "").strip()
    if primary and primary not in keys:
        keys.insert(0, primary)
    if not keys:
        return []

    try:
        from google import genai  # type: ignore[import]

        return [genai.Client(api_key=key) for key in keys]
    except Exception:
        return []


def _generate_kpi_summary_with_dedicated_key(system: str, prompt: str) -> str:
    """Use KPI Gemini key(s) only — never the main or chatbot Gemini keys."""
    from config import settings
    from modules.llm_client import _is_retryable_model_error

    clients = _get_kpi_gemini_clients()
    if not clients:
        raise RuntimeError(
            "KPI_GEMINI_API_KEY is not set. Add it to backend/.env for AI KPI summaries."
        )

    from google.genai import types as genai_types  # type: ignore[import]

    max_tokens = max(128, int(settings.kpi_gemini_max_output_tokens or 1024))
    config = genai_types.GenerateContentConfig(
        max_output_tokens=max_tokens,
        system_instruction=system,
    )
    chain = _kpi_model_chain()
    last_error: Exception | None = None
    retryable = False

    for client in clients:
        for model in chain:
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=config,
                )
                text = (response.text or "").strip()
                if text:
                    return text
            except Exception as exc:
                last_error = exc
                if _is_retryable_model_error(exc):
                    retryable = True
                    continue
                raise RuntimeError(f"KPI Gemini generation failed ({model}): {exc}") from exc

    if retryable:
        raise RuntimeError(
            "KPI Gemini failed on all configured models/keys (rate limit or unavailable model). "
            "Wait for quota reset or update KPI_GEMINI_FALLBACK_MODELS / KPI_GEMINI_API_KEYS."
        ) from last_error
    raise RuntimeError(f"KPI Gemini generation failed: {last_error}") from last_error


def generate_kpi_summary(
    db: Session,
    *,
    report_date: date,
    viewer: AppUser,
    user_id: int | None = None,
    period: str = "day",
) -> dict[str, Any]:
    """Build KPI report + narrative summary (KPI_GEMINI_API_KEY when set, else rules)."""
    from pathlib import Path

    report = get_kpi_report(
        db,
        report_date=report_date,
        viewer=viewer,
        user_id=user_id,
        period=period,
    )
    fallback = _build_rule_based_summary(report)
    source = "rules"
    summary = fallback

    prompt_path = Path(__file__).resolve().parents[1] / "prompts" / "kpi_summary_prompt.md"
    system = (
        prompt_path.read_text(encoding="utf-8")
        if prompt_path.exists()
        else "Write a concise professional KPI summary for management."
    )
    prompt = (
        "Write the management KPI summary from this data.\n\n"
        f"{_report_facts_for_llm(report)}\n\n"
        "Output plain text only (no markdown code fences)."
    )

    try:
        from config import settings

        if (settings.kpi_gemini_api_key or "").strip():
            text = _generate_kpi_summary_with_dedicated_key(system, prompt)
            if text:
                summary = text
                source = "llm"
    except Exception:
        summary = fallback
        source = "rules"

    return {
        "summary": summary,
        "source": source,
        "subject": _subject_line(report),
        "report": report,
    }


def outcome_label(outcome: str | None) -> str:
    if not outcome:
        return "Outcome set"
    return _OUTCOME_LABELS.get(outcome, outcome.replace("_", " ").title())
