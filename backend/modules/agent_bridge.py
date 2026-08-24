"""Read-only dashboard data for bank-recon / PA (agent-bridge API)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from db.models import (
    AiCompanyLifecycle,
    AppUser,
    AppUserRole,
    Buyer,
    Channel,
    Contact,
    Interaction,
    InteractionStatus,
    Quotation,
    QuotationLineItem,
    QuotationStatus,
)
from modules import activity as activity_module
from modules import ai_mode as ai_mode_module
from modules.calls import latest_call_notes_by_buyer, list_call_history, parse_call_fields


# Map internal lifecycle keys → brief-friendly pipeline buckets.
_PIPELINE_BUCKETS: dict[str, tuple[str, ...]] = {
    "new": ("new_lead", "potential_clients"),
    "contacted": ("assigned", "calling", "follow_up", "interested"),
    "quoted": ("quotation_sent", "negotiation"),
    "won": ("won",),
    "lost": ("lost", "not_interested"),
}


def _admin_viewer(db: Session) -> AppUser:
    admin = (
        db.query(AppUser)
        .filter(AppUser.role == AppUserRole.admin, AppUser.is_active.is_(True))
        .order_by(AppUser.id.asc())
        .first()
    )
    if admin:
        return admin
    fallback = (
        db.query(AppUser).filter(AppUser.is_active.is_(True)).order_by(AppUser.id.asc()).first()
    )
    if not fallback:
        raise RuntimeError("No active Sales Agent users")
    return fallback


def _iso_z(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _pipeline_value_usd(db: Session) -> float:
    open_statuses = (QuotationStatus.sent, QuotationStatus.approved)
    line_total = func.coalesce(QuotationLineItem.quantity, 0) * func.coalesce(
        QuotationLineItem.unit_price, 0
    )
    from_lines = (
        db.query(func.coalesce(func.sum(line_total), 0))
        .join(Quotation, Quotation.id == QuotationLineItem.quotation_id)
        .filter(Quotation.status.in_(open_statuses))
        .scalar()
    )
    header_total = func.coalesce(Quotation.quantity, 0) * func.coalesce(Quotation.unit_price, 0)
    from_headers = (
        db.query(func.coalesce(func.sum(header_total), 0))
        .outerjoin(QuotationLineItem, QuotationLineItem.quotation_id == Quotation.id)
        .filter(Quotation.status.in_(open_statuses), QuotationLineItem.id.is_(None))
        .scalar()
    )
    return round(float(from_lines or 0) + float(from_headers or 0), 2)


def bridge_summary(db: Session) -> dict[str, Any]:
    today = date.today()
    _, _, day_start_utc, day_end_utc = activity_module.period_bounds(today, "day")
    _, _, week_start_utc, week_end_utc = activity_module.period_bounds(today, "week")

    leads_today = (
        db.query(func.count(Buyer.id))
        .filter(Buyer.created_at >= day_start_utc, Buyer.created_at < day_end_utc)
        .scalar()
        or 0
    )
    leads_week = (
        db.query(func.count(Buyer.id))
        .filter(Buyer.created_at >= week_start_utc, Buyer.created_at < week_end_utc)
        .scalar()
        or 0
    )

    now_utc = datetime.now(timezone.utc)
    follow_ups_due = (
        db.query(func.count(Buyer.id))
        .filter(Buyer.follow_up_at.isnot(None), Buyer.follow_up_at <= now_utc)
        .scalar()
        or 0
    )

    admin = _admin_viewer(db)
    kpi_today = activity_module.get_kpi_report(
        db, report_date=today, viewer=admin, period="day", user_id=None
    )
    calls_today = int((kpi_today.get("counts") or {}).get("calls_logged") or 0)

    return {
        "leadsToday": int(leads_today),
        "leadsThisWeek": int(leads_week),
        "pipelineValueUsd": _pipeline_value_usd(db),
        "callsToday": calls_today,
        "followUpsDue": int(follow_ups_due),
        "asOf": _iso_z(now_utc),
    }


def bridge_leads(db: Session, *, limit: int = 20) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    rows = db.query(Buyer).order_by(Buyer.updated_at.desc()).limit(limit).all()
    buyer_ids = {b.id for b in rows}
    notes_by_buyer = latest_call_notes_by_buyer(db, buyer_ids=buyer_ids) if buyer_ids else {}

    lifecycle_by_buyer: dict[int, AiCompanyLifecycle] = {}
    if buyer_ids:
        for lc in (
            db.query(AiCompanyLifecycle)
            .filter(AiCompanyLifecycle.buyer_id.in_(buyer_ids))
            .all()
        ):
            lifecycle_by_buyer[lc.buyer_id] = lc

    leads: list[dict[str, Any]] = []
    for buyer in rows:
        lc = lifecycle_by_buyer.get(buyer.id)
        status = lc.stage if lc else None
        notes = notes_by_buyer.get(buyer.id) or buyer.remarks
        leads.append(
            {
                "id": str(buyer.id),
                "name": buyer.company_name,
                "status": status or buyer.company_grading or "unknown",
                "source": buyer.source or "unknown",
                "assignedTo": buyer.assigned_to if buyer.assigned_to != "unassigned" else None,
                "lastActivityAt": _iso_z(buyer.updated_at),
                "notes": (notes or "")[:280] or None,
            }
        )
    return {"leads": leads}


def bridge_pipeline(db: Session) -> dict[str, Any]:
    admin = _admin_viewer(db)
    internal = ai_mode_module.lifecycle_pipeline_counts(db, viewer=admin)
    stages: list[dict[str, Any]] = []
    for bucket, keys in _PIPELINE_BUCKETS.items():
        count = sum(int(internal.get(k) or 0) for k in keys)
        stages.append({"stage": bucket, "count": count})
    return {"stages": stages}


def _rep_name_for_interaction(db: Session, interaction_id: int) -> str | None:
    from db.models import AiCallActivityLog

    row = (
        db.query(AiCallActivityLog)
        .filter(AiCallActivityLog.interaction_id == interaction_id)
        .order_by(AiCallActivityLog.created_at.desc())
        .first()
    )
    if not row or not row.user_id:
        return None
    user = db.get(AppUser, row.user_id)
    return user.full_name if user else None


def bridge_calls(db: Session, *, limit: int = 20) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    result = list_call_history(db, limit=limit, since_days=30)
    calls: list[dict[str, Any]] = []
    for row in result.get("rows") or []:
        if not isinstance(row, dict):
            continue
        parsed = parse_call_fields(row.get("content"))
        summary = (
            row.get("notes")
            or parsed.get("notes")
            or (row.get("transcript") or "")[:240]
            or row.get("subject")
            or ""
        )
        calls.append(
            {
                "id": str(row.get("id")),
                "leadName": row.get("company_name") or row.get("contact_name") or "Unknown",
                "repName": _rep_name_for_interaction(db, int(row["id"])) if row.get("id") else None,
                "startedAt": _iso_z(row.get("created_at")),
                "durationSec": parsed.get("call_duration_seconds"),
                "summary": str(summary)[:500] if summary else None,
            }
        )
    return {"calls": calls}


def _rep_revenue_usd(db: Session, user_id: int | None) -> float:
    if not user_id:
        return 0.0
    open_statuses = (QuotationStatus.sent, QuotationStatus.approved)
    line_total = func.coalesce(QuotationLineItem.quantity, 0) * func.coalesce(
        QuotationLineItem.unit_price, 0
    )
    rev_lines = (
        db.query(func.coalesce(func.sum(line_total), 0))
        .join(Quotation, Quotation.id == QuotationLineItem.quotation_id)
        .join(Buyer, Quotation.buyer_id == Buyer.id)
        .filter(
            Quotation.status.in_(open_statuses),
            Buyer.assigned_to_user_id == user_id,
        )
        .scalar()
    )
    header_total = func.coalesce(Quotation.quantity, 0) * func.coalesce(Quotation.unit_price, 0)
    rev_headers = (
        db.query(func.coalesce(func.sum(header_total), 0))
        .join(Buyer, Quotation.buyer_id == Buyer.id)
        .outerjoin(QuotationLineItem, QuotationLineItem.quotation_id == Quotation.id)
        .filter(
            Quotation.status.in_(open_statuses),
            Buyer.assigned_to_user_id == user_id,
            QuotationLineItem.id.is_(None),
        )
        .scalar()
    )
    return round(float(rev_lines or 0) + float(rev_headers or 0), 2)


def bridge_performance(db: Session) -> dict[str, Any]:
    today = date.today()
    start_date, _, start_utc, _ = activity_module.period_bounds(today, "week")
    admin = _admin_viewer(db)
    report = activity_module.get_kpi_report(
        db, report_date=today, viewer=admin, period="week", user_id=None
    )
    by_rep: list[dict[str, Any]] = []
    for bucket in report.get("per_user") or []:
        if not isinstance(bucket, dict):
            continue
        user = bucket.get("user") or {}
        counts = bucket.get("counts") or {}
        name = user.get("full_name") or user.get("username") or "Unknown"
        uid = user.get("id")

        rep_rev = _rep_revenue_usd(db, uid)
        rep_meetings = (
            int(counts.get("outcomes_follow_up") or 0)
            + int(counts.get("outcomes_interested") or 0)
            + int(counts.get("outcomes_call_back") or 0)
        )

        by_rep.append(
            {
                "repName": name,
                "callsMade": int(counts.get("calls_logged") or 0),
                "leadsWorked": int(counts.get("table_edits") or 0)
                + int(counts.get("leads_imported") or 0),
                "followUpsCompleted": int(counts.get("outcomes_follow_up") or 0),
                "revenue": rep_rev,
                "target": 50000.0,
                "meetings": rep_meetings,
            }
        )
    by_rep.sort(key=lambda r: (r["callsMade"], r["leadsWorked"]), reverse=True)
    tracking = start_utc if start_utc.tzinfo else start_utc.replace(tzinfo=timezone.utc)
    return {
        "byRep": by_rep,
        "trackingSince": _iso_z(tracking),
    }


def bridge_emails(db: Session, *, limit: int = 20) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    emails: list[dict[str, Any]] = []

    # 1. DB interactions with channel == email
    db_interactions = (
        db.query(Interaction)
        .filter(Interaction.channel == Channel.email)
        .order_by(Interaction.created_at.desc())
        .limit(limit)
        .all()
    )

    if db_interactions:
        for inter in db_interactions:
            contact = db.get(Contact, inter.contact_id) if inter.contact_id else None
            buyer = db.get(Buyer, contact.buyer_id) if contact and contact.buyer_id else None
            sender_str = contact.email if contact and contact.email else (buyer.company_name if buyer else "Unknown")
            if contact and contact.name:
                sender_str = f"{contact.name} <{contact.email}>" if contact.email else contact.name

            emails.append(
                {
                    "id": str(inter.id),
                    "sender": sender_str,
                    "subject": inter.subject or "Email Conversation",
                    "receivedAt": _iso_z(inter.created_at),
                    "snippet": (inter.content or "")[:200] or None,
                    "leadName": buyer.company_name if buyer else (contact.name if contact else "Unknown"),
                    "status": "unread" if inter.status == InteractionStatus.received else "read",
                }
            )

    # 2. Supplement from live Inbox threads if needed
    if len(emails) < limit:
        try:
            admin = _admin_viewer(db)
            from modules import inbox as inbox_module

            res = inbox_module.list_threads(admin, limit=limit - len(emails), offset=0)
            threads = res.get("items") or []
            existing_subjects = {e["subject"] for e in emails}
            for t in threads:
                subj = t.get("subject") or "No Subject"
                if subj in existing_subjects:
                    continue
                sender_name = t.get("latest_from_name") or t.get("latest_from_email") or "Unknown"
                sender_email = t.get("latest_from_email")
                sender_formatted = f"{sender_name} <{sender_email}>" if sender_email else sender_name
                snippet_text = t.get("snippet") or subj

                lead_name = sender_name
                if sender_email:
                    b = db.query(Buyer).filter(Buyer.email.ilike(f"%{sender_email}%")).first()
                    if b:
                        lead_name = b.company_name

                emails.append(
                    {
                        "id": str(t.get("thread_id") or t.get("id") or len(emails) + 1),
                        "sender": sender_formatted,
                        "subject": subj,
                        "receivedAt": _iso_z(t.get("latest_date")),
                        "snippet": str(snippet_text)[:200] if snippet_text else None,
                        "leadName": lead_name,
                        "status": "unread" if (t.get("unread_count") or 0) > 0 else "read",
                    }
                )
        except Exception:  # noqa: BLE001
            pass

    return {"emails": emails[:limit]}
