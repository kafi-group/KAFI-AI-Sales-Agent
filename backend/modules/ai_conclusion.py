"""AI Conclusion for Target & Workspace — buyer status snapshot for reps and admins."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from db.models import (
    AppUser,
    Buyer,
    Channel,
    Contact,
    Interaction,
    Quotation,
    QuotationStatus,
    WorkspaceLeadLifecycle,
)


_STAGE_STATUS = {
    "fresh": "Untouched / fresh outreach",
    "needs_follow_up": "Active opportunity",
    "not_interested": "Closed — not interested",
    "no_response": "No response / cold",
    "interested": "Active opportunity",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _ago_label(when: datetime | None) -> str:
    if when is None:
        return "No contact logged"
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    delta = _utc_now() - when
    seconds = max(0, int(delta.total_seconds()))
    if seconds < 3600:
        mins = max(1, seconds // 60)
        return f"{mins} minute{'s' if mins != 1 else ''} ago"
    if seconds < 86400:
        hours = seconds // 3600
        return f"{hours} hour{'s' if hours != 1 else ''} ago"
    days = seconds // 86400
    if days == 1:
        return "1 day ago"
    if days < 14:
        return f"{days} days ago"
    if days < 60:
        weeks = days // 7
        return f"{weeks} week{'s' if weeks != 1 else ''} ago"
    months = days // 30
    return f"{months} month{'s' if months != 1 else ''} ago"


def _channel_key(channel: Any) -> str:
    value = getattr(channel, "value", channel)
    raw = str(value or "").lower()
    if raw in {"phone", "call", "voice"}:
        return "calls"
    if raw in {"email"}:
        return "emails"
    if "whatsapp" in raw or raw == "wa":
        return "whatsapp"
    if "telegram" in raw:
        return "telegram"
    return "other"


def _empty_bucket() -> dict[str, int]:
    return {
        "calls": 0,
        "emails": 0,
        "whatsapp": 0,
        "telegram": 0,
        "quotations": 0,
        "follow_ups_pending": 0,
    }


def _engagement_for_buyer(db: Session, buyer_id: int) -> dict[str, dict[str, int]]:
    """Channel counts for 7 / 30 / 90 day windows."""
    now = _utc_now()
    windows = {"7d": 7, "30d": 30, "90d": 90}
    result = {key: _empty_bucket() for key in windows}

    contact_ids = [
        row[0]
        for row in db.query(Contact.id).filter(Contact.buyer_id == buyer_id).all()
    ]
    if contact_ids:
        since_90 = now - timedelta(days=90)
        rows = (
            db.query(Interaction.channel, Interaction.created_at)
            .filter(
                Interaction.contact_id.in_(contact_ids),
                Interaction.created_at >= since_90,
            )
            .all()
        )
        for channel, created_at in rows:
            key = _channel_key(channel)
            if key == "other" or created_at is None:
                continue
            ts = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
            age_days = (now - ts).total_seconds() / 86400.0
            for label, days in windows.items():
                if age_days <= days and key in result[label]:
                    result[label][key] += 1

    quotes = (
        db.query(Quotation.generated_at, Quotation.sent_at, Quotation.status)
        .filter(Quotation.buyer_id == buyer_id)
        .all()
    )
    for generated_at, sent_at, status in quotes:
        when = sent_at or generated_at
        if when is None:
            continue
        ts = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
        age_days = (now - ts).total_seconds() / 86400.0
        for label, days in windows.items():
            if age_days <= days:
                result[label]["quotations"] += 1
                if status == QuotationStatus.draft:
                    result[label]["follow_ups_pending"] += 1

    life = (
        db.query(WorkspaceLeadLifecycle)
        .filter(WorkspaceLeadLifecycle.buyer_id == buyer_id)
        .one_or_none()
    )
    if life and life.stage == "needs_follow_up":
        for label in windows:
            result[label]["follow_ups_pending"] += 1

    return result


def _last_interaction_at(db: Session, buyer_id: int) -> datetime | None:
    contact_ids = [
        row[0]
        for row in db.query(Contact.id).filter(Contact.buyer_id == buyer_id).all()
    ]
    if not contact_ids:
        return None
    return (
        db.query(func.max(Interaction.created_at))
        .filter(Interaction.contact_id.in_(contact_ids))
        .scalar()
    )


def _responsible_name(db: Session, buyer: Buyer, life: WorkspaceLeadLifecycle | None) -> str:
    user_id = None
    if life and life.user_id:
        user_id = life.user_id
    elif buyer.assigned_to_user_id:
        user_id = buyer.assigned_to_user_id
    if user_id:
        user = db.get(AppUser, user_id)
        if user:
            return (user.full_name or user.username or "Sales Agent").strip()
    assigned = (buyer.assigned_to or "").strip()
    if assigned and assigned.lower() != "unassigned":
        return assigned
    return "Unassigned"


def _build_fields(
    *,
    buyer: Buyer,
    life: WorkspaceLeadLifecycle | None,
    last_contact_at: datetime | None,
    responsible: str,
    engagement: dict[str, dict[str, int]],
) -> dict[str, str]:
    stage = (life.stage if life else "fresh") or "fresh"
    buyer_status = _STAGE_STATUS.get(stage, "Monitoring")

    pending = "Continue outreach"
    next_action = "Call or message within 48 hours"
    attention = "Not required"

    if stage == "needs_follow_up":
        buyer_status = "Active opportunity"
        action = (life.follow_up_action if life else None) or ""
        reason = (life.follow_up_reason if life else None) or ""
        if "quotation" in f"{action} {reason}".lower():
            pending = "Send revised quotation"
            next_action = "Follow up within 24 hours"
        elif action == "call":
            pending = "Schedule / complete follow-up call"
            next_action = "Call within 24 hours"
        elif action == "email":
            pending = "Send follow-up email"
            next_action = "Email within 24 hours"
        elif action == "whatsapp":
            pending = "Send WhatsApp follow-up"
            next_action = "WhatsApp within 24 hours"
        else:
            pending = reason.replace("_", " ").strip().capitalize() or "Follow up with buyer"
            next_action = "Follow up within 24 hours"
        attention = "Required" if (life and life.follow_up_date and life.follow_up_date <= _utc_now() + timedelta(days=1)) else "Not required"
    elif stage == "not_interested":
        pending = "Archive / revisit later"
        next_action = "No immediate action"
        attention = "Not required"
    elif stage == "no_response":
        pending = "Try alternate channel or contact"
        next_action = "One more multi-channel attempt this week"
        attention = "Required" if (engagement.get("30d", {}).get("calls", 0) + engagement.get("30d", {}).get("emails", 0)) >= 5 else "Not required"
    elif stage == "fresh":
        pending = "First outreach"
        next_action = "Call during Valid-to-call window"
        attention = "Not required"

    open_quotes_90 = engagement.get("90d", {}).get("quotations", 0)
    if open_quotes_90 and stage in {"fresh", "needs_follow_up", "interested"}:
        if "quotation" not in pending.lower():
            pending = "Send revised quotation" if open_quotes_90 else pending
            next_action = "Follow up within 24 hours"

    # Stale active deals need management eyes.
    if stage == "needs_follow_up" and last_contact_at:
        ts = last_contact_at if last_contact_at.tzinfo else last_contact_at.replace(tzinfo=timezone.utc)
        if (_utc_now() - ts).days >= 7:
            attention = "Required"
            next_action = "Manager review + follow up within 24 hours"

    return {
        "buyer_status": buyer_status,
        "last_contact": _ago_label(last_contact_at),
        "pending_action": pending,
        "responsible_person": responsible,
        "next_action": next_action,
        "management_attention": attention,
    }


def build_buyer_conclusion(db: Session, buyer_id: int) -> dict[str, Any] | None:
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        return None
    life = (
        db.query(WorkspaceLeadLifecycle)
        .filter(WorkspaceLeadLifecycle.buyer_id == buyer_id)
        .one_or_none()
    )
    last_at = _last_interaction_at(db, buyer_id)
    engagement = _engagement_for_buyer(db, buyer_id)
    responsible = _responsible_name(db, buyer, life)
    fields = _build_fields(
        buyer=buyer,
        life=life,
        last_contact_at=last_at,
        responsible=responsible,
        engagement=engagement,
    )
    return {
        "buyer_id": buyer.id,
        "company_name": buyer.company_name,
        "country": buyer.country,
        "stage": (life.stage if life else "fresh"),
        "responsible_user_id": life.user_id if life else buyer.assigned_to_user_id,
        "engagement": engagement,
        **fields,
        "generated_at": _utc_now().isoformat(),
    }


def list_conclusions(
    db: Session,
    *,
    user_id: int | None = None,
    buyer_id: int | None = None,
    company_query: str | None = None,
    day_of_week: str | None = None,
    attention: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """Build conclusions for matching buyers (computed live from activity)."""
    from modules import target_workspace as tw_module

    q = db.query(Buyer)
    if buyer_id is not None:
        q = q.filter(Buyer.id == buyer_id)
    if user_id is not None:
        q = q.filter(
            or_(
                Buyer.assigned_to_user_id == user_id,
                Buyer.id.in_(
                    db.query(WorkspaceLeadLifecycle.buyer_id).filter(
                        WorkspaceLeadLifecycle.user_id == user_id
                    )
                ),
            )
        )
    if company_query and company_query.strip():
        like = f"%{company_query.strip()}%"
        q = q.filter(Buyer.company_name.ilike(like))

    # Day filter: buyers in that day's target countries (team or user).
    if day_of_week:
        targets = tw_module.get_day_country_targets(
            db, day_of_week=day_of_week.lower(), user_id=user_id
        )
        countries = {
            (t.get("country") or "").strip().lower()
            for t in targets
            if t.get("country")
        }
        if countries:
            q = q.filter(func.lower(Buyer.country).in_(countries))
        else:
            return {"total": 0, "items": [], "limit": limit, "offset": offset}

    # Prefer buyers that already have workspace lifecycle or assignment.
    # Without a user/company/day/buyer filter, only surface workspace-active leads
    # so admin overview stays usable (not the entire Master Table).
    if user_id is None and buyer_id is None and not (company_query or "").strip() and not day_of_week:
        q = q.filter(
            or_(
                Buyer.assigned_to_user_id.isnot(None),
                Buyer.id.in_(db.query(WorkspaceLeadLifecycle.buyer_id)),
            )
        )

    total = q.count()
    buyers = (
        q.order_by(Buyer.company_name.asc())
        .offset(max(0, offset))
        .limit(min(200, max(1, limit)))
        .all()
    )

    items: list[dict[str, Any]] = []
    for buyer in buyers:
        item = build_buyer_conclusion(db, buyer.id)
        if not item:
            continue
        if attention:
            want = attention.strip().lower()
            got = str(item.get("management_attention") or "").lower()
            if want == "required" and "required" not in got:
                continue
            if want in {"not_required", "not required"} and "not required" not in got:
                continue
        items.append(item)

    return {
        "total": total if not attention else len(items),
        "items": items,
        "limit": limit,
        "offset": offset,
    }


def summarize_admin_overview(db: Session, *, day_of_week: str | None = None) -> dict[str, Any]:
    """Roll-up for Khalid / admins: attention counts by assignee."""
    data = list_conclusions(db, day_of_week=day_of_week, limit=200, offset=0)
    items = data.get("items") or []
    by_user: dict[str, dict[str, int]] = {}
    attention_required = 0
    for item in items:
        name = str(item.get("responsible_person") or "Unassigned")
        bucket = by_user.setdefault(name, {"companies": 0, "attention_required": 0})
        bucket["companies"] += 1
        if str(item.get("management_attention") or "").lower() == "required":
            bucket["attention_required"] += 1
            attention_required += 1
    return {
        "day_of_week": day_of_week,
        "companies_scanned": len(items),
        "attention_required": attention_required,
        "by_user": [
            {"responsible_person": name, **counts}
            for name, counts in sorted(by_user.items(), key=lambda x: (-x[1]["attention_required"], x[0]))
        ],
        "items": items,
    }
