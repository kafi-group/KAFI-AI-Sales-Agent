"""Post-call: remarks, lifecycle, KPI, follow-up email."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from db.models import AppUser, Interaction
from modules.ai_sales_agent.personas import get_persona
from modules import activity as activity_module
from modules import ai_mode as ai_mode_module
from modules import inbox as inbox_module
from modules import llm_client
from modules.calls import update_call_followup

log = logging.getLogger(__name__)


def _resolve_app_user(db: Session, username: str) -> AppUser | None:
    return (
        db.query(AppUser)
        .filter(AppUser.username == username, AppUser.is_active.is_(True))
        .first()
    )


def _draft_follow_up_email(
    *,
    company_name: str,
    contact_name: str,
    persona_name: str,
    remark: str,
) -> tuple[str, str]:
    subject = f"Kafi Commodities — FMCG export follow-up ({company_name})"
    prompt = (
        "Write a short professional follow-up email after a phone call.\n"
        f"From: {persona_name}, Kafi Commodities (Pvt) Ltd, Pakistani FMCG exporter.\n"
        f"To contact: {contact_name} at {company_name}.\n"
        f"Call summary: {remark}\n"
        "Mention rice, sauces, pickles, Himalayan salt. Invite them to reply with product interest.\n"
        "Return JSON: {\"subject\":\"...\",\"body\":\"plain text, 2-3 short paragraphs\"}"
    )
    raw = llm_client.generate(prompt)
    try:
        import json

        data = json.loads(raw.strip().strip("`").replace("json", ""))
        return (
            str(data.get("subject") or subject),
            str(data.get("body") or raw),
        )
    except Exception:
        body = (
            f"Dear {contact_name},\n\n"
            f"Thank you for speaking with us today. {remark}\n\n"
            "Kafi Commodities exports FMCG products including basmati rice, chutneys, sauces, "
            "and Himalayan pink salt under ISO, HACCP, and Halal certification.\n\n"
            f"Best regards,\n{persona_name}\nKafi Commodities (Pvt) Ltd"
        )
        return subject, body


def finalize_task(
    db: Session,
    *,
    task_id: int,
    call_status: str | None = None,
    duration_seconds: int | None = None,
) -> dict[str, Any]:
    from modules.ai_sales_agent import campaign as campaign_module

    task = campaign_module.get_task(db, task_id)
    if not task:
        raise ValueError("Task not found")

    persona = get_persona(task.persona)
    app_user = _resolve_app_user(db, persona.app_username)
    app_user_id = app_user.id if app_user else None

    outcome = (task.outcome or "").strip() or None
    remark = (task.remarks or "").strip() or "AI sales call completed."

    status = (call_status or "").lower()
    if status in {"busy", "no-answer", "failed", "canceled"} and not outcome:
        outcome = "not_received_call"
        remark = f"No connect ({status})."

    interaction_id = task.interaction_id
    if interaction_id:
        update_call_followup(
            db,
            interaction_id=interaction_id,
            notes=remark,
            call_outcome=outcome or "follow_up",
            app_user_id=app_user_id,
        )
        if app_user_id:
            activity_module.log_activity(
                db,
                user_id=app_user_id,
                activity_type=activity_module.CALL_LOGGED,
                title="AI sales call logged",
                summary=f"{persona.display_name} called {task.buyer.company_name}",
                entity_type="interaction",
                entity_id=interaction_id,
                details={"persona": persona.id, "ai_sales_agent": True},
            )
            ai_mode_module.record_call_activity(
                db,
                user_id=app_user_id,
                company_name=task.buyer.company_name,
                buyer_id=task.buyer_id,
                interaction_id=interaction_id,
                user_label=persona.display_name,
            )

    email_result: dict[str, Any] | None = None
    contact = task.contact
    if app_user and contact and (contact.email or "").strip() and outcome != "not_received_call":
        subject, body = _draft_follow_up_email(
            company_name=task.buyer.company_name,
            contact_name=contact.full_name or "Sir/Madam",
            persona_name=persona.display_name,
            remark=remark,
        )
        try:
            email_result = inbox_module.compose(
                app_user,
                to=contact.email.strip(),
                subject=subject,
                body=body,
            )
        except Exception as exc:
            log.exception("AI sales agent email failed task=%s", task_id)
            email_result = {"status": "error", "message": str(exc)}

    campaign_module.mark_task_completed(db, task_id, outcome=outcome, remarks=remark)

    return {
        "task_id": task_id,
        "outcome": outcome,
        "remark": remark,
        "email": email_result,
        "interaction_id": interaction_id,
    }
