"""Coaching for AI Sales Agent — Helpful Guidance + real human call patterns."""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session

from db.models import Buyer, Channel, Contact, Interaction
from modules.call_media import get_call_media
from modules.calls import parse_call_fields
from modules.helpful_guidance import generate_helpful_guidance

# Distilled from successful Kafi human calls (e.g. Asim/Anjum CC) — warm FMCG export style.
KAFI_HUMAN_CALL_STYLE = """
Successful Kafi rep call style (mirror this pace and warmth):
1. Confirm name → short greeting → "How are you doing today?" — wait for their reply.
2. Introduce: "This is [name] from Kafi Commodities." If lead remarks mention a referral
   (e.g. "Ms. Monica gave me this number"), say that before pitching.
3. One-line company scope, then ASK — do not list every product in one turn:
   "We export Himalayan salt, rice, spices, and FMCG lines. Are you importing any of these?"
4. If "not yet" or wrong category — explore their business first (e.g. frozen meat, retail).
   Acknowledge ("Right, I understand") before asking about salt/rice again.
5. Gatekeeper / operator — ask politely to transfer to procurement or purchasing manager.
6. When interest appears — offer quotation FOB + port name; ask destination port and product
   types (basmati 1121, parboiled, etc.); offer to send a product list by email/WhatsApp.
7. Close warmly — confirm their name, ask if the number is on WhatsApp, thank them.
Tone: patient, conversational, one question per turn. Never rush a product monologue.
""".strip()

_POSITIVE_OUTCOMES = frozenset({"interested", "follow_up"})
_EXCERPT_MAX_CHARS = 1400
_AI_SALES_APPROVED_PREFIX = "ai_sales_agent:"


def format_guidance_for_ai_calls(report: dict[str, Any]) -> str:
    """Turn Helpful Guidance report into pre-call coaching for Sara/Rayan."""
    blocks: list[str] = []

    recs = report.get("recommendations") or []
    if recs:
        lines = [f"- {r.get('title')}: {r.get('body')}" for r in recs[:4] if r.get("title")]
        if lines:
            blocks.append("Helpful Guidance — team coaching:\n" + "\n".join(lines))

    approach = report.get("approach_buyers") or []
    if approach:
        blocks.append(
            "Approach before/during calls:\n"
            + "\n".join(f"- {line}" for line in approach[:6])
        )

    gaps = report.get("gaps") or []
    if gaps:
        blocks.append("Watch-outs from recent KPI/remarks:\n" + "\n".join(f"- {g}" for g in gaps[:4]))

    patterns = (report.get("remark_patterns") or {}).get("pattern_counts") or {}
    if int(patterns.get("gatekeeper") or 0) >= 2:
        blocks.append(
            "- Gatekeepers are common on this team's list — ask for procurement/import "
            "manager and their email before ending the call."
        )
    if int(patterns.get("no_answer") or 0) >= 5:
        blocks.append(
            "- High no-answer rate — keep opening short; if voicemail, end quickly and log "
            "not_received_call."
        )

    if not blocks:
        return KAFI_HUMAN_CALL_STYLE
    return "\n\n".join(blocks) + "\n\n" + KAFI_HUMAN_CALL_STYLE


def _trim_transcript_excerpt(transcript: str, *, max_chars: int = _EXCERPT_MAX_CHARS) -> str:
    text = (transcript or "").strip()
    if len(text) <= max_chars:
        return text
    clipped = text[:max_chars]
    last_break = max(clipped.rfind("\n"), clipped.rfind(". "))
    if last_break > max_chars // 2:
        clipped = clipped[:last_break]
    return clipped.rstrip() + "\n… (excerpt)"


def fetch_rep_call_exemplars(
    db: Session,
    *,
    app_user_id: int | None,
    limit: int = 1,
) -> list[str]:
    """Recent successful human call CC excerpts from this rep's assigned leads."""
    if not app_user_id:
        return []

    candidates = (
        db.query(Interaction)
        .join(Contact, Interaction.contact_id == Contact.id)
        .join(Buyer, Contact.buyer_id == Buyer.id)
        .filter(
            Interaction.channel == Channel.phone,
            Buyer.assigned_to_user_id == app_user_id,
        )
        .order_by(Interaction.created_at.desc())
        .limit(80)
        .all()
    )

    excerpts: list[str] = []
    for interaction in candidates:
        approved = (interaction.approved_by or "").strip().lower()
        if approved.startswith(_AI_SALES_APPROVED_PREFIX):
            continue
        parsed = parse_call_fields(interaction.content)
        outcome = (parsed.get("call_outcome") or "").strip().lower()
        if outcome not in _POSITIVE_OUTCOMES:
            continue
        media = get_call_media(interaction)
        if not media:
            continue
        if (media.get("transcript_status") or "").lower() != "ready":
            continue
        transcript = (media.get("transcript") or "").strip()
        if len(transcript) < 200:
            continue
        company = ""
        contact = db.get(Contact, interaction.contact_id)
        if contact:
            buyer = db.get(Buyer, contact.buyer_id)
            if buyer:
                company = buyer.company_name or ""
        label = company or "assigned lead"
        excerpt = _trim_transcript_excerpt(transcript)
        excerpts.append(
            f"Real closed-caption excerpt ({label}, outcome: {outcome}):\n{excerpt}"
        )
        if len(excerpts) >= limit:
            break
    return excerpts


def build_ai_sales_coaching_context(
    db: Session,
    *,
    app_user_id: int | None,
    viewer=None,
    months: int = 3,
) -> str:
    """Full coaching block: Helpful Guidance + human CC exemplars + style guide."""
    from db.models import AppUser

    parts: list[str] = []

    if viewer is None and app_user_id:
        viewer = db.get(AppUser, app_user_id)

    if viewer:
        try:
            report = generate_helpful_guidance(
                db,
                viewer=viewer,
                months=months,
                user_id=app_user_id if viewer.id != app_user_id else None,
            )
            parts.append(format_guidance_for_ai_calls(report))
        except Exception:
            parts.append(KAFI_HUMAN_CALL_STYLE)
    else:
        parts.append(KAFI_HUMAN_CALL_STYLE)

    exemplars = fetch_rep_call_exemplars(db, app_user_id=app_user_id, limit=1)
    if exemplars:
        parts.append(
            "Learn phrasing and pacing from this recent successful human call on your queue:\n"
            + exemplars[0]
        )

    return "\n\n".join(p for p in parts if p.strip())


def referral_hint_from_remarks(remarks: str | None) -> str:
    """Surface referral contacts mentioned in buyer remarks for the opening."""
    text = (remarks or "").strip()
    if not text:
        return ""
    lower = text.lower()
    if not any(k in lower for k in ("gave me", "referred", "referral", "shared this number", "said to call")):
        return ""
    # Keep first sentence that looks like a referral.
    for sentence in re.split(r"[.!?]\s+", text):
        s = sentence.strip()
        if len(s) < 12:
            continue
        if any(k in s.lower() for k in ("gave", "refer", "introduc", "said", "told", "manager", "contact")):
            return f"Referral on file (mention if relevant after intro): {s[:220]}"
    return ""
