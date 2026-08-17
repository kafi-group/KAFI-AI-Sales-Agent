"""Helpful Guidance — coaching report from client history, KPI, and call patterns."""

from __future__ import annotations

import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from db.models import AppUser, AppUserRole, Buyer
from modules.activity import get_kpi_report


_REMARK_PATTERNS: list[tuple[str, str]] = [
    (r"not pick|no answer|did not receive|didn't pick|unanswered", "no_answer"),
    (r"wrong number|invalid number|disconnected|not in service", "wrong_number"),
    (r"voicemail|voice mail|left message", "voicemail"),
    (r"not interested|declined|no requirement", "not_interested"),
    (r"interested|follow up|callback|call back|quotation|quote|rfq", "positive_signal"),
    (r"head office|operator|reception", "gatekeeper"),
]


def _normalize_period_months(months: int) -> int:
    return max(1, min(months, 12))


def _scan_remark_patterns(db: Session, *, assigned_to_user_id: int | None) -> dict[str, Any]:
    query = db.query(Buyer.id, Buyer.company_name, Buyer.remarks_history, Buyer.remarks)
    if assigned_to_user_id is not None:
        query = query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)
    counts: Counter[str] = Counter()
    samples: dict[str, list[str]] = {key: [] for key, _ in _REMARK_PATTERNS}
    scanned = 0
    for _bid, company, history, remarks in query.all():
        texts: list[str] = []
        if remarks and str(remarks).strip():
            texts.append(str(remarks).strip())
        for entry in history or []:
            if isinstance(entry, dict) and (entry.get("text") or "").strip():
                texts.append(str(entry["text"]).strip())
        for text in texts:
            scanned += 1
            lower = text.lower()
            for pattern, key in _REMARK_PATTERNS:
                if re.search(pattern, lower):
                    counts[key] += 1
                    if len(samples[key]) < 5:
                        samples[key].append(f"{company}: {text[:120]}")
    return {"scanned_remarks": scanned, "pattern_counts": dict(counts), "samples": samples}


def _monthly_kpi_rollups(
    db: Session,
    *,
    viewer: AppUser,
    target_user_id: int | None,
    months: int,
) -> list[dict[str, Any]]:
    today = date.today()
    rollups: list[dict[str, Any]] = []
    cursor = today
    for _ in range(months):
        try:
            report = get_kpi_report(
                db,
                report_date=cursor,
                viewer=viewer,
                user_id=target_user_id,
                period="month",
            )
            rollups.append(
                {
                    "period_label": report.get("period_label") or cursor.strftime("%B %Y"),
                    "counts": report.get("counts") or {},
                }
            )
        except ValueError:
            pass
        cursor = cursor.replace(day=1) - timedelta(days=1)
    return rollups


def _build_recommendations(
    pattern_counts: dict[str, int],
    kpi_totals: dict[str, int],
) -> list[dict[str, str]]:
    recs: list[dict[str, str]] = []
    calls = int(kpi_totals.get("calls_logged") or 0)
    no_answer = int(kpi_totals.get("outcomes_not_received_call") or 0)
    interested = int(kpi_totals.get("outcomes_interested") or 0)
    follow_up = int(kpi_totals.get("outcomes_follow_up") or 0)

    if calls > 0 and no_answer / max(calls, 1) >= 0.35:
        recs.append(
            {
                "title": "High no-answer rate",
                "body": (
                    "More than a third of logged calls are “did not receive call”. "
                    "Use Quick Dial → Valid to call now, call in local 10 AM–5 PM windows, "
                    "and avoid redialing the same number within 48 hours. "
                    "Send a short WhatsApp or email before the second attempt to cut voicemail charges."
                ),
            }
        )

    if pattern_counts.get("voicemail", 0) >= 5:
        recs.append(
            {
                "title": "Voicemail is costing connect time",
                "body": (
                    "Many remarks mention voicemail. Prefer WhatsApp template or email first for cold leads; "
                    "reserve calls for “Valid to call now” slots. "
                    "If you must leave voicemail, keep batches smaller (10) and log outcome as Did not receive call."
                ),
            }
        )

    if pattern_counts.get("wrong_number", 0) >= 3:
        recs.append(
            {
                "title": "Wrong numbers in the list",
                "body": (
                    "Clean spreadsheet phones before import. "
                    "Move name-only / phone-only rows to Incomplete Data from Archives until verified."
                ),
            }
        )

    if pattern_counts.get("positive_signal", 0) >= interested + follow_up and calls > 10:
        recs.append(
            {
                "title": "Interest in remarks but low formal outcomes",
                "body": (
                    "Reps are noting interest in remarks but not always selecting Client is interested / Follow up. "
                    "Always pick an outcome in post-call remarks so KPI and Follow up clients stay accurate."
                ),
            }
        )

    if not recs:
        recs.append(
            {
                "title": "Keep momentum",
                "body": (
                    "Log every call outcome, use Assigned list for your daily queue, "
                    "and coordinate before calling another rep’s assigned contacts."
                ),
            }
        )
    return recs


def generate_helpful_guidance(
    db: Session,
    *,
    viewer: AppUser,
    months: int = 3,
    user_id: int | None = None,
) -> dict[str, Any]:
    """Build a coaching report for the viewer or a selected user (admin)."""
    role = viewer.role.value if isinstance(viewer.role, AppUserRole) else str(viewer.role)
    is_admin = role == AppUserRole.admin.value
    target_user_id = viewer.id if not is_admin else user_id

    months = _normalize_period_months(months)
    remark_scan = _scan_remark_patterns(db, assigned_to_user_id=target_user_id)

    kpi_months = _monthly_kpi_rollups(
        db, viewer=viewer, target_user_id=target_user_id, months=months
    )
    kpi_totals: dict[str, int] = {}
    for row in kpi_months:
        for key, val in (row.get("counts") or {}).items():
            if isinstance(val, int):
                kpi_totals[key] = kpi_totals.get(key, 0) + val

    recommendations = _build_recommendations(
        remark_scan.get("pattern_counts") or {},
        kpi_totals,
    )

    strengths: list[str] = []
    if int(kpi_totals.get("outcomes_interested") or 0) > 0:
        strengths.append("Logged interested clients — keep nurturing with quotations.")
    if int(kpi_totals.get("calls_logged") or 0) >= 20:
        strengths.append("Consistent calling activity — focus on connect rate and outcomes.")
    if int(kpi_totals.get("bulk_emails_sent") or 0) + int(kpi_totals.get("personal_emails_sent") or 0) > 0:
        strengths.append("Email outreach in use — pair with call windows for warmer conversations.")

    gaps: list[str] = []
    pc = remark_scan.get("pattern_counts") or {}
    if pc.get("no_answer", 0) >= 10:
        gaps.append("Frequent no-answer / not picking up — timing and list quality.")
    if pc.get("gatekeeper", 0) >= 3:
        gaps.append("Gatekeeper blocks — ask for procurement/import manager email before calling again.")
    if int(kpi_totals.get("outcomes_not_interested") or 0) > int(kpi_totals.get("outcomes_interested") or 0):
        gaps.append("More not-interested than interested — refine country/product fit in Old clients filters.")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "months": months,
        "user_id": target_user_id,
        "is_team_view": is_admin and user_id is None,
        "kpi_by_month": kpi_months,
        "kpi_totals": kpi_totals,
        "remark_patterns": remark_scan,
        "strengths": strengths or ["Building history — keep logging every touchpoint."],
        "gaps": gaps or ["No major gaps detected from remark patterns yet."],
        "recommendations": recommendations,
        "approach_buyers": [
            "Research company + product fit (salt, rice, sauces) before first call.",
            "Use Valid to call now in Quick Dial for the buyer’s country.",
            "Warm up with WhatsApp template or email when cold; call when they reply or in-window.",
            "Always log outcome + one-line remark — powers Follow up clients and this guidance.",
            "Check Assigned before dialing; coordinate if another rep owns the lead.",
        ],
        "save_phone_bill": [
            "Filter Valid to call now — fewer rings to voicemail abroad.",
            "Smaller bulk batches (10) with Skip & next when no answer — don’t chain 25 voicemails.",
            "WhatsApp first for repeat no-answer numbers within 7 days.",
            "Remove wrong numbers via Full clean / dedupe on Old clients.",
        ],
    }
