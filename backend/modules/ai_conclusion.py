"""AI Conclusion for Target & Workspace — buyer status snapshot for reps and admins."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from db.models import (
    AppUser,
    Buyer,
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


def _engagement_maps(
    db: Session, buyer_ids: list[int]
) -> tuple[dict[int, dict[str, dict[str, int]]], dict[int, datetime | None]]:
    """Batch engagement + last-contact for many buyers (avoids N+1 timeouts)."""
    windows = {"7d": 7, "30d": 30, "90d": 90}
    engagement: dict[int, dict[str, dict[str, int]]] = {
        bid: {key: _empty_bucket() for key in windows} for bid in buyer_ids
    }
    last_at: dict[int, datetime | None] = {bid: None for bid in buyer_ids}
    if not buyer_ids:
        return engagement, last_at

    now = _utc_now()
    since_90 = now - timedelta(days=90)

    contact_rows = (
        db.query(Contact.id, Contact.buyer_id)
        .filter(Contact.buyer_id.in_(buyer_ids))
        .all()
    )
    contact_to_buyer = {cid: bid for cid, bid in contact_rows}
    contact_ids = list(contact_to_buyer.keys())
    if contact_ids:
        ix_rows = (
            db.query(Interaction.contact_id, Interaction.channel, Interaction.created_at)
            .filter(
                Interaction.contact_id.in_(contact_ids),
                Interaction.created_at >= since_90,
            )
            .all()
        )
        for contact_id, channel, created_at in ix_rows:
            bid = contact_to_buyer.get(contact_id)
            if bid is None or created_at is None:
                continue
            key = _channel_key(channel)
            if key == "other":
                continue
            ts = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
            prev = last_at.get(bid)
            if prev is None or ts > prev:
                last_at[bid] = ts
            age_days = (now - ts).total_seconds() / 86400.0
            for label, days in windows.items():
                if age_days <= days and key in engagement[bid][label]:
                    engagement[bid][label][key] += 1

    quote_rows = (
        db.query(
            Quotation.buyer_id,
            Quotation.generated_at,
            Quotation.sent_at,
            Quotation.status,
        )
        .filter(Quotation.buyer_id.in_(buyer_ids))
        .all()
    )
    for bid, generated_at, sent_at, status in quote_rows:
        when = sent_at or generated_at
        if when is None or bid not in engagement:
            continue
        ts = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
        age_days = (now - ts).total_seconds() / 86400.0
        for label, days in windows.items():
            if age_days <= days:
                engagement[bid][label]["quotations"] += 1
                if status == QuotationStatus.draft:
                    engagement[bid][label]["follow_ups_pending"] += 1

    return engagement, last_at


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
        attention = (
            "Required"
            if (life and life.follow_up_date and life.follow_up_date <= _utc_now() + timedelta(days=1))
            else "Not required"
        )
    elif stage == "not_interested":
        pending = "Archive / revisit later"
        next_action = "No immediate action"
        attention = "Not required"
    elif stage == "no_response":
        pending = "Try alternate channel or contact"
        next_action = "One more multi-channel attempt this week"
        attention = (
            "Required"
            if (engagement.get("30d", {}).get("calls", 0) + engagement.get("30d", {}).get("emails", 0))
            >= 5
            else "Not required"
        )
    elif stage == "fresh":
        pending = "First outreach"
        next_action = "Call during Valid-to-call window"
        attention = "Not required"

    open_quotes_90 = engagement.get("90d", {}).get("quotations", 0)
    if open_quotes_90 and stage in {"fresh", "needs_follow_up", "interested"}:
        if "quotation" not in pending.lower():
            pending = "Send revised quotation"
            next_action = "Follow up within 24 hours"

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
    eng_map, last_map = _engagement_maps(db, [buyer_id])
    engagement = eng_map.get(buyer_id) or {k: _empty_bucket() for k in ("7d", "30d", "90d")}
    if life and life.stage == "needs_follow_up":
        for label in engagement:
            engagement[label]["follow_ups_pending"] += 1
    last_at = last_map.get(buyer_id)
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
    limit: int = 40,
    offset: int = 0,
) -> dict[str, Any]:
    """Build conclusions for workspace-active buyers (batched — stays fast)."""
    from modules import target_workspace as tw_module

    # Always start from workspace lifecycle (or a single buyer) — never the full Master Table.
    q = (
        db.query(Buyer, WorkspaceLeadLifecycle)
        .outerjoin(WorkspaceLeadLifecycle, WorkspaceLeadLifecycle.buyer_id == Buyer.id)
    )

    if buyer_id is not None:
        q = q.filter(Buyer.id == buyer_id)
    else:
        q = q.filter(
            or_(
                WorkspaceLeadLifecycle.id.isnot(None),
                Buyer.assigned_to_user_id.isnot(None),
            )
        )

    if user_id is not None:
        q = q.filter(
            or_(
                Buyer.assigned_to_user_id == user_id,
                WorkspaceLeadLifecycle.user_id == user_id,
            )
        )
    if company_query and company_query.strip():
        like = f"%{company_query.strip()}%"
        q = q.filter(Buyer.company_name.ilike(like))

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

    safe_limit = min(80, max(1, int(limit or 40)))
    safe_offset = max(0, int(offset or 0))
    total = q.count()
    rows = (
        q.order_by(Buyer.company_name.asc())
        .offset(safe_offset)
        .limit(safe_limit)
        .all()
    )

    buyers = [b for b, _life in rows]
    lives = {b.id: life for b, life in rows if life is not None}
    buyer_ids = [b.id for b in buyers]
    eng_map, last_map = _engagement_maps(db, buyer_ids)

    # Prefetch assignees in one query
    assignee_ids = {
        (lives[b.id].user_id if lives.get(b.id) and lives[b.id].user_id else b.assigned_to_user_id)
        for b in buyers
    }
    assignee_ids.discard(None)
    users_by_id: dict[int, AppUser] = {}
    if assignee_ids:
        users_by_id = {
            u.id: u for u in db.query(AppUser).filter(AppUser.id.in_(list(assignee_ids))).all()
        }

    items: list[dict[str, Any]] = []
    for buyer in buyers:
        life = lives.get(buyer.id)
        engagement = eng_map.get(buyer.id) or {k: _empty_bucket() for k in ("7d", "30d", "90d")}
        if life and life.stage == "needs_follow_up":
            for label in engagement:
                engagement[label]["follow_ups_pending"] += 1
        last_at = last_map.get(buyer.id)
        uid = life.user_id if life and life.user_id else buyer.assigned_to_user_id
        user = users_by_id.get(uid) if uid else None
        if user:
            responsible = (user.full_name or user.username or "Sales Agent").strip()
        else:
            responsible = _responsible_name(db, buyer, life)
        fields = _build_fields(
            buyer=buyer,
            life=life,
            last_contact_at=last_at,
            responsible=responsible,
            engagement=engagement,
        )
        item = {
            "buyer_id": buyer.id,
            "company_name": buyer.company_name,
            "country": buyer.country,
            "stage": (life.stage if life else "fresh"),
            "responsible_user_id": uid,
            "engagement": engagement,
            **fields,
            "generated_at": _utc_now().isoformat(),
        }
        if attention:
            want = attention.strip().lower()
            got = str(item.get("management_attention") or "").lower()
            if want == "required" and got != "required":
                continue
            if want in {"not_required", "not required"} and "not required" not in got:
                continue
        items.append(item)

    return {
        "total": total if not attention else len(items),
        "items": items,
        "limit": safe_limit,
        "offset": safe_offset,
    }


def summarize_admin_overview(db: Session, *, day_of_week: str | None = None) -> dict[str, Any]:
    """Roll-up for admins from the same limited workspace set (not a second heavy scan)."""
    data = list_conclusions(db, day_of_week=day_of_week, limit=60, offset=0)
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
            for name, counts in sorted(
                by_user.items(), key=lambda x: (-x[1]["attention_required"], x[0])
            )
        ],
        "items": items,
    }
