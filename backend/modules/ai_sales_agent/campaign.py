"""Task queue, Twilio outbound, and runner control for AI Sales Agent."""

from __future__ import annotations

import html
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from config import settings
from db.models import (
    AiSalesAgentRunner,
    AiSalesAgentTask,
    AppUser,
    Channel,
    Direction,
    HandledBy,
    Interaction,
    InteractionStatus,
)
from integrations.voice_client import normalize_e164, voice_client
from modules import buyers as buyers_module
from modules.ai_sales_agent.context import build_lead_context, guidance_snippet_for_persona
from modules.ai_sales_agent.personas import VALID_PERSONAS, build_system_prompt, get_persona
from modules.calls import _lead_phone_from_contact, _prepare_call_interaction
from modules.audit import log_action

log = logging.getLogger(__name__)

TASK_PENDING = "pending"
TASK_CALLING = "calling"
TASK_COMPLETED = "completed"
TASK_FAILED = "failed"
TASK_SKIPPED = "skipped"

RUNNER_IDLE = "idle"
RUNNER_RUNNING = "running"
RUNNER_PAUSED = "paused"

MAX_CONVERSATION_TURNS = 14


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def ensure_runners(db: Session) -> None:
    for persona in sorted(VALID_PERSONAS):
        row = db.get(AiSalesAgentRunner, persona)
        if not row:
            db.add(AiSalesAgentRunner(persona=persona, status=RUNNER_IDLE))
    db.commit()


def get_runner(db: Session, persona: str) -> AiSalesAgentRunner:
    ensure_runners(db)
    pid = (persona or "").strip().lower()
    if pid not in VALID_PERSONAS:
        raise ValueError("persona must be 'male' or 'female'")
    row = db.get(AiSalesAgentRunner, pid)
    assert row is not None
    return row


def runner_snapshot(db: Session) -> list[dict[str, Any]]:
    ensure_runners(db)
    out: list[dict[str, Any]] = []
    for persona in sorted(VALID_PERSONAS):
        runner = get_runner(db, persona)
        profile = get_persona(persona)
        pending = (
            db.query(AiSalesAgentTask)
            .filter(
                AiSalesAgentTask.persona == persona,
                AiSalesAgentTask.status == TASK_PENDING,
            )
            .count()
        )
        current_task = None
        if runner.current_task_id:
            current_task = task_to_dict(get_task(db, runner.current_task_id))
        out.append(
            {
                "persona": persona,
                "display_name": profile.display_name,
                "gender_label": profile.gender_label,
                "app_username": profile.app_username,
                "voice": profile.voice,
                "status": runner.status,
                "current_task_id": runner.current_task_id,
                "current_task": current_task,
                "pending_count": pending,
                "twilio_ready": voice_client.is_configured and voice_client.webhooks_ready,
            }
        )
    return out


def get_task(db: Session, task_id: int) -> AiSalesAgentTask | None:
    return db.get(AiSalesAgentTask, task_id)


def task_to_dict(task: AiSalesAgentTask | None) -> dict[str, Any] | None:
    if not task:
        return None
    buyer = task.buyer
    contact = task.contact
    return {
        "id": task.id,
        "persona": task.persona,
        "buyer_id": task.buyer_id,
        "contact_id": task.contact_id,
        "company_name": buyer.company_name if buyer else None,
        "contact_name": contact.full_name if contact else None,
        "contact_phone": (contact.phone or contact.primary_phone) if contact else None,
        "status": task.status,
        "interaction_id": task.interaction_id,
        "call_sid": task.call_sid,
        "outcome": task.outcome,
        "remarks": task.remarks,
        "error_message": task.error_message,
        "created_at": task.created_at.isoformat() if task.created_at else None,
        "started_at": task.started_at.isoformat() if task.started_at else None,
        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
    }


def list_tasks(
    db: Session,
    *,
    persona: str | None = None,
    status: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    q = db.query(AiSalesAgentTask).order_by(AiSalesAgentTask.id.asc())
    if persona:
        q = q.filter(AiSalesAgentTask.persona == persona.strip().lower())
    if status:
        q = q.filter(AiSalesAgentTask.status == status.strip().lower())
    rows = q.limit(max(1, min(limit, 500))).all()
    result: list[dict[str, Any]] = []
    for task in rows:
        buyer = task.buyer
        contact = task.contact
        briefing = build_lead_context(db, buyer_id=task.buyer_id, contact_id=task.contact_id)
        result.append(
            {
                **(task_to_dict(task) or {}),
                "ready": briefing["ready"],
                "warnings": briefing["warnings"],
                "country": buyer.country if buyer else None,
            }
        )
    return result


def assign_tasks(
    db: Session,
    *,
    persona: str,
    buyer_ids: list[int],
    contact_ids: list[int | None] | None = None,
    assigned_by_user_id: int | None = None,
) -> list[dict[str, Any]]:
    pid = (persona or "").strip().lower()
    if pid not in VALID_PERSONAS:
        raise ValueError("persona must be 'male' or 'female'")
    created: list[AiSalesAgentTask] = []
    for idx, buyer_id in enumerate(buyer_ids):
        buyer = buyers_module.get_buyer(db, buyer_id)
        if not buyer:
            continue
        contact_id = None
        if contact_ids and idx < len(contact_ids):
            contact_id = contact_ids[idx]
        task = AiSalesAgentTask(
            persona=pid,
            buyer_id=buyer_id,
            contact_id=contact_id,
            assigned_by_user_id=assigned_by_user_id,
            status=TASK_PENDING,
        )
        db.add(task)
        created.append(task)
    db.commit()
    for task in created:
        db.refresh(task)
    return [task_to_dict(t) for t in created if task_to_dict(t)]


def remove_task(db: Session, task_id: int) -> bool:
    task = get_task(db, task_id)
    if not task:
        return False
    if task.status == TASK_CALLING:
        raise ValueError("Cannot remove a call in progress")
    db.delete(task)
    db.commit()
    return True


def skip_task(db: Session, task_id: int) -> dict[str, Any]:
    task = get_task(db, task_id)
    if not task:
        raise ValueError("Task not found")
    if task.status == TASK_CALLING:
        raise ValueError("Cannot skip a call in progress")
    task.status = TASK_SKIPPED
    task.completed_at = _utcnow()
    db.commit()
    db.refresh(task)
    return task_to_dict(task) or {}


def start_runner(db: Session, persona: str) -> dict[str, Any]:
    if not voice_client.is_configured or not voice_client.webhooks_ready:
        raise ValueError(
            "Twilio is not fully configured for server outbound calls. "
            "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_WEBHOOK_BASE_URL."
        )
    runner = get_runner(db, persona)
    if runner.status == RUNNER_RUNNING:
        snaps = runner_snapshot(db)
        for snap in snaps:
            if snap["persona"] == persona.strip().lower():
                return snap
    runner.status = RUNNER_RUNNING
    db.commit()
    dispatch_next(db, persona)
    snaps = runner_snapshot(db)
    for snap in snaps:
        if snap["persona"] == persona.strip().lower():
            return snap
    raise ValueError("Runner not found")


def pause_runner(db: Session, persona: str) -> dict[str, Any]:
    runner = get_runner(db, persona)
    runner.status = RUNNER_PAUSED
    db.commit()
    snaps = runner_snapshot(db)
    for snap in snaps:
        if snap["persona"] == persona.strip().lower():
            return snap
    raise ValueError("Runner not found")


def _resolve_app_user(db: Session, username: str) -> AppUser | None:
    return (
        db.query(AppUser)
        .filter(AppUser.username == username, AppUser.is_active.is_(True))
        .first()
    )


def _prepare_task_briefing(db: Session, task: AiSalesAgentTask) -> dict[str, Any]:
    persona = get_persona(task.persona)
    app_user = _resolve_app_user(db, persona.app_username)
    briefing = build_lead_context(db, buyer_id=task.buyer_id, contact_id=task.contact_id)
    guidance = guidance_snippet_for_persona(db, app_user_id=app_user.id if app_user else None)
    context_text = briefing["context_text"]
    if guidance:
        context_text = f"{context_text}\n\n{guidance}"
    contact = briefing["contact"]
    contact_name = (contact.full_name if contact else None) or "the procurement contact"
    opening = persona.opening_template.format(contact_name=contact_name)
    system_prompt = build_system_prompt(persona, context_text)
    return {
        "briefing": briefing,
        "system_prompt": system_prompt,
        "opening": opening,
        "contact": contact,
        "persona": persona,
    }


def _store_transcript_state(
    task: AiSalesAgentTask,
    *,
    system_prompt: str,
    opening: str,
    history: list[dict[str, str]] | None = None,
    turn: int = 0,
) -> None:
    task.transcript = {
        "system_prompt": system_prompt,
        "opening": opening,
        "history": history or [],
        "turn": turn,
    }


def prepare_and_dial_task(db: Session, task: AiSalesAgentTask) -> None:
    """Create interaction, briefing, and place Twilio outbound call."""
    briefing_pack = _prepare_task_briefing(db, task)
    briefing = briefing_pack["briefing"]
    if not briefing["ready"]:
        task.status = TASK_FAILED
        task.error_message = "; ".join(briefing["warnings"]) or "Lead not ready for AI call"
        task.completed_at = _utcnow()
        db.commit()
        dispatch_next(db, task.persona)
        return

    contact = briefing_pack["contact"]
    if not contact:
        task.status = TASK_FAILED
        task.error_message = "No contact with phone number"
        task.completed_at = _utcnow()
        db.commit()
        dispatch_next(db, task.persona)
        return

    buyer = briefing["buyer"]
    try:
        lead_phone = _lead_phone_from_contact(contact)
    except ValueError as exc:
        task.status = TASK_FAILED
        task.error_message = str(exc)
        task.completed_at = _utcnow()
        db.commit()
        dispatch_next(db, task.persona)
        return

    call_payload = _prepare_call_interaction(
        db,
        buyer=buyer,
        contact=contact,
        lead_phone=lead_phone,
        subject=f"AI call to {buyer.company_name}",
        content=f"AI outbound call to {lead_phone} ({contact.full_name}).",
    )
    interaction = db.get(Interaction, call_payload["id"])
    if interaction:
        interaction.handled_by = HandledBy.agent
        interaction.approved_by = f"ai_sales_agent:{task.persona}"

    task.interaction_id = call_payload["id"]
    task.status = TASK_CALLING
    task.started_at = _utcnow()
    task.error_message = None
    _store_transcript_state(
        task,
        system_prompt=briefing_pack["system_prompt"],
        opening=briefing_pack["opening"],
    )
    db.commit()

    voice_url = voice_client.webhook_url(
        f"/api/webhooks/twilio/ai-sales/voice?task_id={task.id}"
    )
    status_url = voice_client.webhook_url(
        f"/api/webhooks/twilio/ai-sales/status?task_id={task.id}"
    )
    recording_url = voice_client.webhook_url(
        f"/api/webhooks/twilio/ai-sales/recording?task_id={task.id}"
    )

    from twilio.rest import Client

    client = Client(settings.twilio_account_sid.strip(), settings.twilio_auth_token.strip())
    caller = normalize_e164(settings.twilio_phone_number) or settings.twilio_phone_number
    call = client.calls.create(
        to=lead_phone,
        from_=caller,
        url=voice_url,
        method="POST",
        status_callback=status_url,
        status_callback_method="POST",
        status_callback_event=["completed"],
        record=True,
        recording_status_callback=recording_url,
        recording_status_callback_method="POST",
        recording_status_callback_event=["completed"],
        timeout=45,
    )
    task.call_sid = call.sid
    db.commit()

    log_action(
        db,
        entity_type="ai_sales_agent_task",
        entity_id=task.id,
        action="call_started",
        actor=f"ai_sales_agent:{task.persona}",
        details={"call_sid": call.sid, "lead_phone": lead_phone, "interaction_id": task.interaction_id},
    )


def dispatch_next(db: Session, persona: str) -> None:
    runner = get_runner(db, persona)
    if runner.status != RUNNER_RUNNING:
        return
    if runner.current_task_id:
        current = get_task(db, runner.current_task_id)
        if current and current.status == TASK_CALLING:
            return

    next_task = (
        db.query(AiSalesAgentTask)
        .filter(
            AiSalesAgentTask.persona == persona.strip().lower(),
            AiSalesAgentTask.status == TASK_PENDING,
        )
        .order_by(AiSalesAgentTask.id.asc())
        .first()
    )
    if not next_task:
        runner.current_task_id = None
        runner.status = RUNNER_IDLE
        db.commit()
        return

    runner.current_task_id = next_task.id
    db.commit()
    try:
        prepare_and_dial_task(db, next_task)
    except Exception as exc:
        log.exception("AI sales dispatch failed persona=%s task=%s", persona, next_task.id)
        next_task.status = TASK_FAILED
        next_task.error_message = str(exc)[:500]
        next_task.completed_at = _utcnow()
        runner.current_task_id = None
        db.commit()
        dispatch_next(db, persona)


def mark_task_completed(
    db: Session,
    task_id: int,
    *,
    outcome: str | None = None,
    remarks: str | None = None,
) -> None:
    task = get_task(db, task_id)
    if not task:
        return
    if outcome:
        task.outcome = outcome.strip().lower()
    if remarks:
        task.remarks = remarks.strip()
    task.status = TASK_COMPLETED
    task.completed_at = _utcnow()
    runner = get_runner(db, task.persona)
    if runner.current_task_id == task_id:
        runner.current_task_id = None
    db.commit()


def save_turn_result(
    db: Session,
    task_id: int,
    *,
    history: list[dict[str, str]],
    turn: int,
    outcome: str | None = None,
    remarks: str | None = None,
) -> None:
    task = get_task(db, task_id)
    if not task:
        return
    state = dict(task.transcript or {})
    state["history"] = history
    state["turn"] = turn
    task.transcript = state
    if outcome:
        task.outcome = outcome.strip().lower()
    if remarks:
        task.remarks = remarks.strip()
    db.commit()


def get_transcript_state(task: AiSalesAgentTask) -> dict[str, Any]:
    return dict(task.transcript or {})


def build_gather_twiml(
    *,
    voice: str,
    spoken: str,
    task_id: int,
    final: bool = False,
) -> str:
    """TwiML: Say text then gather speech (or hang up if final)."""
    text = html.escape((spoken or "").strip()[:900])
    voice_xml = html.escape(voice, quote=True)
    if final or not spoken.strip():
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Say voice="{voice_xml}">{text or "Thank you. Goodbye."}</Say>'
            "<Hangup/>"
            "</Response>"
        )
    turn_url = html.escape(
        voice_client.webhook_url(f"/api/webhooks/twilio/ai-sales/turn?task_id={task_id}"),
        quote=True,
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        f'<Gather input="speech" action="{turn_url}" method="POST" speechTimeout="auto" language="en-US">'
        f'<Say voice="{voice_xml}">{text}</Say>'
        "</Gather>"
        f'<Say voice="{voice_xml}">Sorry, I did not catch that. Goodbye.</Say>'
        "<Hangup/>"
        "</Response>"
    )


def on_call_completed(
    db: Session,
    task_id: int,
    *,
    call_status: str | None = None,
    duration_seconds: int | None = None,
) -> None:
    from modules.ai_sales_agent import post_call as post_call_module

    task = get_task(db, task_id)
    if not task or task.status not in {TASK_CALLING, TASK_COMPLETED}:
        return
    if task.status == TASK_COMPLETED:
        dispatch_next(db, task.persona)
        return

    state = get_transcript_state(task)
    history = state.get("history") or []
    if not task.outcome and history:
        from modules.ai_sales_agent.conversation import analyze_transcript

        meta = analyze_transcript(
            system_prompt=str(state.get("system_prompt") or ""),
            transcript=history,
        )
        task.outcome = meta.get("outcome") or "follow_up"
        task.remarks = meta.get("remark") or task.remarks

    if task.interaction_id and call_status:
        from modules.calls import update_call_status

        update_call_status(
            db,
            interaction_id=task.interaction_id,
            call_status=call_status,
            call_duration=str(duration_seconds) if duration_seconds else None,
            call_sid=task.call_sid,
        )

    try:
        post_call_module.finalize_task(
            db,
            task_id=task_id,
            call_status=call_status,
            duration_seconds=duration_seconds,
        )
    except Exception:
        log.exception("AI sales post-call failed task=%s", task_id)
        mark_task_completed(db, task_id, outcome=task.outcome, remarks=task.remarks)

    persona = task.persona
    runner = get_runner(db, persona)
    if runner.current_task_id == task_id:
        runner.current_task_id = None
        db.commit()
    dispatch_next(db, persona)
