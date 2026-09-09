"""AI Sales Agent (Rayan & Sara) queue & outbound calling router."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser, Buyer, Contact
from db.session import SessionLocal
from modules import sales_assistant as assistant_module

router = APIRouter(prefix="/ai-sales-agent", tags=["ai-sales-agent"])
webhooks_router = APIRouter(prefix="/webhooks/vapi", tags=["vapi-webhooks"])

_NO_ANSWER_STATUSES = {
    "no-answer",
    "no_answer",
    "busy",
    "failed",
    "canceled",
    "cancelled",
    "customer-did-not-answer",
    "customer-busy",
    "voicemail",
    "voicemail-reached",
    "twilio-failed-to-connect-call",
    "vonage-failed-to-connect-call",
    "silence-timed-out",
}


class UnlockRequest(BaseModel):
    access_code: str


class AssignTaskRequest(BaseModel):
    persona: str
    buyer_ids: list[int]
    contact_ids: list[int | None] | None = None


class SelfTestRequest(BaseModel):
    persona: str
    phone: str
    contact_name: str | None = None
    language: str | None = "en"
    dial_now: bool = True


class RunnerControlRequest(BaseModel):
    persona: str
    task_id: int | None = None
    sequence: bool = True


# Global mock/live runner state
_RUNNERS = [
    {
        "persona": "male",
        "display_name": "Rayan",
        "gender_label": "male",
        "app_username": "rayan",
        "voice": "en-US-Neural2-D",
        "status": "idle",
        "current_task_id": None,
        "current_task": None,
        "pending_count": 0,
        "twilio_ready": True,
        "sequence_mode": False,
        "operator_user_id": None,
    },
    {
        "persona": "female",
        "display_name": "Sara",
        "gender_label": "female",
        "app_username": "sara",
        "voice": "en-US-Neural2-F",
        "status": "idle",
        "current_task_id": None,
        "current_task": None,
        "pending_count": 0,
        "twilio_ready": True,
        "sequence_mode": False,
        "operator_user_id": None,
    },
]

_TASKS: list[dict[str, Any]] = []


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _next_task_id() -> int:
    if not _TASKS:
        return 1
    return max(int(t.get("id") or 0) for t in _TASKS) + 1


def _agent_name(persona: str) -> str:
    return "Sara" if persona == "female" else "Rayan"


def _get_runner(persona: str) -> dict[str, Any] | None:
    return next((r for r in _RUNNERS if r.get("persona") == persona), None)


def _find_task(task_id: int | None) -> dict[str, Any] | None:
    if not task_id:
        return None
    return next((t for t in _TASKS if t.get("id") == task_id), None)


def _contact_phone(contact: Contact | None) -> str | None:
    if not contact:
        return None
    for raw in (
        contact.phone,
        contact.primary_phone,
        contact.secondary_mobile,
        contact.secondary_phone,
        contact.wa_id,
    ):
        value = (raw or "").strip()
        if value:
            return value
    return None


def _contact_email(contact: Contact | None) -> str | None:
    if not contact:
        return None
    value = (contact.email or contact.secondary_email or "").strip()
    return value or None


def _is_no_answer(status: str | None, ended_reason: str | None, duration: Any) -> bool:
    blob = f"{status or ''} {ended_reason or ''}".strip().lower().replace("_", "-")
    tokens = {part for part in blob.replace("/", " ").split() if part}
    if tokens & _NO_ANSWER_STATUSES or blob in _NO_ANSWER_STATUSES:
        return True
    for flag in _NO_ANSWER_STATUSES:
        if flag in blob:
            return True
    try:
        seconds = int(float(duration)) if duration not in (None, "") else None
    except (TypeError, ValueError):
        seconds = None
    if seconds is not None and seconds < 8 and "completed" in blob:
        return True
    return False


def _auto_followup_after_call(
    db: Session,
    *,
    user: AppUser | None,
    agent_name: str,
    contact_name: str,
    phone: str | None,
    email: str | None,
    company_name: str | None = None,
    outcome: str = "connected",
) -> dict[str, Any]:
    """Send personal WhatsApp (Baileys) + mailbox email after a Sara/Rayan call.

    Does not use Meta WhatsApp Cloud API. Does not prompt the operator.
    """
    from integrations import whatsapp_bridge_client as bridge
    from integrations.mail_client import mail_client

    company = (company_name or "").strip()
    greet_name = (contact_name or "there").strip() or "there"
    no_answer = outcome == "no_answer"

    if no_answer:
        wa_text = (
            f"Hello {greet_name}, this is {agent_name} from Kafi Commodities "
            "(Brand: ESSENCE).\n\n"
            "We tried to reach you by phone just now but no one picked up. "
            "Please let me know a good time to talk on the phone.\n\n"
            f"Best regards,\n{agent_name}\nKafi Commodities Export Team"
        )
        if company:
            wa_text = wa_text.replace(
                "We tried to reach you by phone just now",
                f"We tried to reach {company} by phone just now",
                1,
            )
        subject = f"Tried reaching you — {agent_name}, Kafi Commodities"
        body = (
            f"<p>Dear {greet_name},</p>"
            "<p>We tried to reach out to you by phone but no one picked up. "
            "Please let me know a good time to talk on the phone.</p>"
            f"<p>This is <strong>{agent_name}</strong> from "
            "<strong>Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE)</strong>"
            f"{f' regarding {company}' if company else ''}.</p>"
            f"<p>Best regards,<br/><strong>{agent_name}</strong><br/>"
            "Kafi Commodities Export Team<br/>"
            '<a href="https://www.kafi-group.com">www.kafi-group.com</a></p>'
        )
    else:
        wa_text = (
            f"Hello {greet_name}, this is {agent_name} from Kafi Commodities "
            "(Brand: ESSENCE).\n\n"
            "Thank you for your time on the call. As discussed, I am sharing this "
            "note so we can continue over WhatsApp — catalogues, packaging, and "
            "CNF/FOB pricing whenever you are ready.\n\n"
            f"Best regards,\n{agent_name}\nKafi Commodities Export Team"
        )
        if company:
            wa_text = wa_text.replace(
                "Thank you for your time on the call.",
                f"Thank you for your time on the call regarding {company}.",
                1,
            )
        subject = f"Following our call — {agent_name}, Kafi Commodities"
        body = (
            f"<p>Dear {greet_name},</p>"
            f"<p>Thank you for speaking with <strong>{agent_name}</strong> from "
            "<strong>Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE)</strong>"
            f"{f' about {company}' if company else ''}.</p>"
            "<p>As discussed, please find this follow-up so we can share catalogues, "
            "packaging options, and CNF/FOB pricing at your convenience.</p>"
            f"<p>Best regards,<br/><strong>{agent_name}</strong><br/>"
            "Kafi Commodities Export Team<br/>"
            '<a href="https://www.kafi-group.com">www.kafi-group.com</a></p>'
        )

    result: dict[str, Any] = {
        "whatsapp_status": "skipped",
        "whatsapp_message": None,
        "email_status": "skipped",
        "email_message": None,
        "email_to": email,
        "outcome": outcome,
    }

    if not user:
        result["whatsapp_message"] = "No operator user on the call — follow-up not sent."
        result["email_message"] = result["whatsapp_message"]
        return result

    if phone:
        try:
            status = bridge.bridge_status(user.id, username=user.username)
            if not status.get("connected"):
                result["whatsapp_status"] = "not_connected"
                result["whatsapp_message"] = (
                    "Personal WhatsApp is not connected. Open WhatsApp Mobile and scan QR."
                )
            else:
                bridge.bridge_send(
                    user.id,
                    to_phone=phone,
                    message=wa_text,
                    username=user.username,
                )
                result["whatsapp_status"] = "sent"
                result["whatsapp_message"] = f"Personal WhatsApp sent to {phone}"
                try:
                    from db.models import (
                        Channel,
                        Direction,
                        HandledBy,
                        Interaction,
                        InteractionStatus,
                    )
                    from modules.comms_generator import get_comms

                    contact = get_comms()._ensure_whatsapp_contact(db, wa_id=phone)
                    outbound = Interaction(
                        contact_id=contact.id,
                        channel=Channel.whatsapp,
                        direction=Direction.outbound,
                        content=wa_text,
                        status=InteractionStatus.sent,
                        handled_by=HandledBy.agent,
                        provider_message_id="baileys_ai_call_followup",
                    )
                    db.add(outbound)
                    db.commit()
                except Exception:
                    pass
        except Exception as exc:  # noqa: BLE001
            result["whatsapp_status"] = "error"
            result["whatsapp_message"] = str(exc)[:300]

    if email:
        try:
            send_result = mail_client.send_approved(
                to=email,
                subject=subject,
                body=body,
                mailbox_user=user,
            )
            result["email_status"] = send_result.get("status") or "error"
            result["email_message"] = send_result.get("message") or result["email_status"]
            result["email_to"] = email
        except Exception as exc:  # noqa: BLE001
            result["email_status"] = "error"
            result["email_message"] = str(exc)[:300]
    else:
        result["email_message"] = "No email address on file for this contact."

    return result


def _load_operator(db: Session, user_id: int | None) -> AppUser | None:
    if not user_id:
        return None
    try:
        return db.get(AppUser, int(user_id))
    except Exception:
        return None


def _send_task_followup(
    db: Session,
    task: dict[str, Any],
    *,
    outcome: str,
    user: AppUser | None = None,
) -> dict[str, Any]:
    if task.get("followup_sent"):
        return task.get("followup") or {}
    operator = user
    if operator is None:
        operator = _load_operator(db, task.get("operator_user_id"))
    email = (task.get("contact_email") or "").strip() or None
    if task.get("is_test") and not email and operator:
        email = (operator.mailbox_email or "").strip() or None
    followup = _auto_followup_after_call(
        db,
        user=operator,
        agent_name=_agent_name(str(task.get("persona") or "female")),
        contact_name=task.get("contact_name") or "there",
        phone=task.get("contact_phone"),
        email=email,
        company_name=task.get("company_name"),
        outcome=outcome,
    )
    task["followup"] = followup
    task["followup_sent"] = True
    return followup


def _refresh_runner_counts() -> None:
    for r in _RUNNERS:
        persona_tasks = [t for t in _TASKS if t.get("persona") == r["persona"]]
        pending = [t for t in persona_tasks if t.get("status") in ("queued", "in_progress")]
        r["pending_count"] = len(pending)
        in_prog = next((t for t in persona_tasks if t.get("status") == "in_progress"), None)
        if in_prog:
            r["current_task_id"] = in_prog.get("id")
            r["current_task"] = in_prog
        elif pending:
            r["current_task_id"] = pending[0].get("id")
            r["current_task"] = pending[0]
        else:
            r["current_task_id"] = None
            r["current_task"] = None
            if r.get("status") == "running":
                r["status"] = "idle"
                r["sequence_mode"] = False


def _dial_task(
    db: Session,
    *,
    task: dict[str, Any],
    user: AppUser,
    language: str = "en",
) -> dict[str, Any]:
    from integrations.voice_client import voice_client

    phone = task.get("contact_phone")
    if not phone:
        task["status"] = "failed"
        task["ready"] = False
        task["remarks"] = "No phone on this contact."
        raise HTTPException(400, "This queue item has no phone number.")

    call_result = voice_client.place_outbound_ai_call(
        phone,
        persona=str(task.get("persona") or "female"),
        contact_name=task.get("contact_name") or "Purchasing Manager",
        language=language,
        task_id=task.get("id"),
    )
    if not call_result.get("ok"):
        task["status"] = "failed"
        task["remarks"] = f"Twilio Voice Error: {call_result.get('error')}"
        raise HTTPException(400, f"Twilio Voice Error: {call_result.get('error')}")

    task["status"] = "in_progress"
    task["call_sid"] = call_result.get("call_sid")
    task["call_engine"] = call_result.get("engine")
    task["started_at"] = _now_iso()
    task["operator_user_id"] = user.id
    task["outcome"] = "Calling"
    task["remarks"] = f"Calling {phone} live (SID: {call_result.get('call_sid')})..."
    task["followup_sent"] = False

    runner = _get_runner(str(task.get("persona")))
    if runner:
        runner["status"] = "running"
        runner["current_task_id"] = task["id"]
        runner["current_task"] = task
        runner["operator_user_id"] = user.id
    return call_result


def _next_queued(persona: str) -> dict[str, Any] | None:
    return next(
        (
            t
            for t in _TASKS
            if t.get("persona") == persona
            and t.get("status") == "queued"
            and t.get("ready")
            and t.get("contact_phone")
        ),
        None,
    )


def _advance_sequence(db: Session, persona: str, user: AppUser | None) -> None:
    runner = _get_runner(persona)
    if not runner:
        return
    if runner.get("_advancing"):
        return
    runner["_advancing"] = True
    try:
        _advance_sequence_locked(db, runner, persona, user)
    finally:
        runner["_advancing"] = False


def _advance_sequence_locked(
    db: Session,
    runner: dict[str, Any],
    persona: str,
    user: AppUser | None,
) -> None:
    if runner.get("status") != "running" or not runner.get("sequence_mode"):
        if runner.get("status") == "running":
            runner["status"] = "idle"
            runner["current_task_id"] = None
            runner["current_task"] = None
        return
    if any(
        t.get("persona") == persona and t.get("status") == "in_progress" for t in _TASKS
    ):
        return
    nxt = _next_queued(persona)
    if not nxt:
        runner["status"] = "idle"
        runner["sequence_mode"] = False
        runner["current_task_id"] = None
        runner["current_task"] = None
        return
    operator = user or _load_operator(db, runner.get("operator_user_id") or nxt.get("operator_user_id"))
    if not operator:
        runner["status"] = "idle"
        return
    try:
        _dial_task(db, task=nxt, user=operator)
    except HTTPException:
        nxt["status"] = "failed"
        _advance_sequence_locked(db, runner, persona, operator)


def _finish_task(
    db: Session,
    task: dict[str, Any],
    *,
    status: str | None = None,
    ended_reason: str | None = None,
    duration: Any = None,
    outcome_label: str | None = None,
    user: AppUser | None = None,
    hangup: bool = False,
) -> dict[str, Any]:
    from integrations.voice_client import voice_client

    if hangup and task.get("call_sid"):
        try:
            voice_client.end_call(str(task["call_sid"]))
        except Exception:
            pass

    no_answer = _is_no_answer(status, ended_reason, duration)
    outcome = "no_answer" if no_answer else "connected"
    if task.get("status") in ("queued",):
        return task
    if task.get("status") not in ("completed", "failed", "skipped"):
        task["status"] = "completed"
        task["completed_at"] = _now_iso()
        if no_answer:
            task["outcome"] = outcome_label or "No pickup"
            task["remarks"] = "No one picked up — missed-call follow-up sent."
        else:
            task["outcome"] = outcome_label or "Call ended"
            task["remarks"] = "Call ended — WhatsApp and email follow-up sent."

    followup = _send_task_followup(db, task, outcome=outcome, user=user)
    persona = str(task.get("persona") or "")
    operator = user or _load_operator(db, task.get("operator_user_id"))
    _advance_sequence(db, persona, operator)
    _refresh_runner_counts()
    return followup


def handle_ai_call_status(
    *,
    task_id: int | None,
    call_sid: str | None,
    status: str | None,
    duration: Any = None,
    ended_reason: str | None = None,
) -> dict[str, Any]:
    """Twilio / Vapi terminal status — send follow-up and dial the next queued lead."""
    terminal = {
        "completed",
        "busy",
        "failed",
        "no-answer",
        "canceled",
        "cancelled",
        "ended",
    }
    blob = f"{status or ''} {ended_reason or ''}".lower()
    is_terminal = any(token in blob for token in terminal) or _is_no_answer(
        status, ended_reason, duration
    )
    if not is_terminal:
        return {"ok": True, "ignored": True}

    task = _find_task(task_id)
    if task is None and call_sid:
        task = next((t for t in _TASKS if t.get("call_sid") == call_sid), None)
    if task is None or task.get("status") not in ("in_progress", "running"):
        return {"ok": True, "ignored": True}

    db = SessionLocal()
    try:
        _finish_task(
            db,
            task,
            status=status,
            ended_reason=ended_reason,
            duration=duration,
        )
        return {"ok": True, "task_id": task.get("id")}
    finally:
        db.close()


def _reconcile_live_calls(db: Session) -> None:
    """If webhooks were missed, poll Vapi/Twilio for ended calls."""
    from integrations.voice_client import voice_client

    live = [t for t in _TASKS if t.get("status") == "in_progress" and t.get("call_sid")]
    for task in live:
        started = task.get("started_at")
        if started:
            try:
                started_dt = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
                age = (datetime.now(timezone.utc) - started_dt).total_seconds()
            except Exception:
                age = 999
            if age < 25:
                continue
        info = voice_client.fetch_outbound_status(task.get("call_sid"))
        if not info.get("ended"):
            continue
        _finish_task(
            db,
            task,
            status=str(info.get("status") or ""),
            ended_reason=str(info.get("ended_reason") or ""),
            duration=info.get("duration"),
        )


@router.post("/unlock")
def unlock_ai_sales_agent(
    payload: UnlockRequest,
    user: AppUser = Depends(get_current_user),
) -> dict[str, bool]:
    _ = user
    code = (payload.access_code or "").strip()
    if not assistant_module.access_code_valid(code):
        raise HTTPException(403, "Invalid access code. Please use access code: 07860")
    return {"ok": True}


@router.get("/runners")
def list_runners(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    try:
        _reconcile_live_calls(db)
    except Exception:
        pass
    _refresh_runner_counts()
    return {"runners": _RUNNERS}


@router.get("/tasks")
def list_tasks(
    persona: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    filtered = _TASKS
    if persona:
        filtered = [t for t in filtered if t.get("persona") == persona]
    if status:
        filtered = [t for t in filtered if t.get("status") == status]
    return {"tasks": filtered[:limit]}


@router.post("/tasks/assign")
def assign_tasks(
    payload: AssignTaskRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    if payload.persona not in ("male", "female"):
        raise HTTPException(400, "Persona must be male (Rayan) or female (Sara).")
    created = []
    contact_ids = payload.contact_ids or []
    queued_keys = {
        (
            t.get("persona"),
            t.get("buyer_id"),
            t.get("contact_id"),
            t.get("contact_phone"),
        )
        for t in _TASKS
        if t.get("status") in ("queued", "in_progress")
    }
    for index, bid in enumerate(payload.buyer_ids):
        buyer = db.get(Buyer, bid)
        wanted_cid = contact_ids[index] if index < len(contact_ids) else None
        contact: Contact | None = None
        if wanted_cid:
            found = db.get(Contact, wanted_cid)
            if found and (buyer is None or found.buyer_id == bid):
                contact = found
        if contact is None and buyer and buyer.contacts:
            contact = buyer.contacts[0]
        company_name = buyer.company_name if buyer else f"Lead #{bid}"
        contact_name = (contact.full_name if contact else None) or "Purchasing Manager"
        contact_phone = _contact_phone(contact) or getattr(buyer, "phone", None)
        contact_email = _contact_email(contact)
        key = (payload.persona, bid, contact.id if contact else None, contact_phone)
        if key in queued_keys:
            continue
        queued_keys.add(key)
        task = {
            "id": _next_task_id(),
            "persona": payload.persona,
            "buyer_id": bid,
            "contact_id": contact.id if contact else None,
            "company_name": company_name,
            "contact_name": contact_name,
            "contact_phone": contact_phone,
            "contact_email": contact_email,
            "country": (buyer.country if buyer else None),
            "designation": (contact.designation if contact else None),
            "grading": (buyer.company_grading if buyer else None),
            "status": "queued",
            "ready": bool(contact_phone),
            "warnings": [] if contact_phone else ["No phone on this contact"],
            "created_at": _now_iso(),
            "followup_sent": False,
        }
        _TASKS.append(task)
        created.append(task)
    _refresh_runner_counts()
    return {"tasks": created}


@router.post("/tasks/self-test")
def queue_self_test(
    payload: SelfTestRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    agent_name = _agent_name(payload.persona)
    contact_name = payload.contact_name or "Mr. Khalid"

    contact_id = None
    contact_email = (user.mailbox_email or "").strip() or None
    if payload.phone:
        try:
            from sqlalchemy import or_

            digits = "".join(ch for ch in payload.phone if ch.isdigit())
            tail = digits[-10:] if len(digits) >= 8 else ""
            if tail:
                matched_contact = (
                    db.query(Contact)
                    .filter(
                        or_(
                            Contact.phone.contains(tail),
                            Contact.primary_phone.contains(tail),
                            Contact.secondary_mobile.contains(tail),
                            Contact.wa_id.contains(tail),
                        )
                    )
                    .first()
                )
                if matched_contact:
                    contact_id = matched_contact.id
                    contact_email = (
                        (matched_contact.email or matched_contact.secondary_email or "").strip()
                        or contact_email
                    )
        except Exception:
            pass

    task = {
        "id": _next_task_id(),
        "persona": payload.persona,
        "buyer_id": 0,
        "contact_id": contact_id,
        "company_name": "Direct AI Call",
        "contact_name": contact_name,
        "contact_phone": payload.phone,
        "contact_email": contact_email,
        "status": "queued",
        "ready": True,
        "is_test": True,
        "created_at": _now_iso(),
        "operator_user_id": user.id,
        "followup_sent": False,
    }
    _TASKS.insert(0, task)

    runner = _get_runner(payload.persona)
    if runner:
        runner["sequence_mode"] = False
        runner["operator_user_id"] = user.id

    call_result: dict[str, Any] = {}
    if payload.dial_now:
        call_result = _dial_task(
            db,
            task=task,
            user=user,
            language=payload.language or "en",
        )
    _refresh_runner_counts()

    try:
        from db.models import Channel, Direction, HandledBy, Interaction, InteractionStatus

        interaction = Interaction(
            contact_id=contact_id,
            channel=Channel.phone,
            direction=Direction.outbound,
            subject=f"AI Voice Call ({agent_name}) to {contact_name}",
            content=f"Interactive AI voice call to {payload.phone}. Twilio SID: {call_result.get('call_sid')}",
            handled_by=HandledBy.agent,
            status=InteractionStatus.sent,
            approved_by="dashboard",
        )
        db.add(interaction)
        db.commit()
        db.refresh(interaction)
    except Exception as exc:
        print(f"Could not log AI interaction to DB: {exc}", flush=True)

    return {"task": task, "call_result": call_result}


class EndCallRequest(BaseModel):
    persona: str | None = None
    call_sid: str | None = None
    task_id: int | None = None


@router.post("/end-call")
def end_ai_call(
    payload: EndCallRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    ended_task = None
    for t in _TASKS:
        matches = False
        if payload.task_id and t.get("id") == payload.task_id:
            matches = True
        elif (
            payload.persona
            and t.get("persona") == payload.persona
            and t.get("status") in ("in_progress", "running")
        ):
            matches = True
        elif (
            not payload.task_id
            and not payload.persona
            and t.get("status") in ("in_progress", "running")
        ):
            matches = True

        if matches:
            duration = None
            if t.get("started_at"):
                try:
                    started_dt = datetime.fromisoformat(str(t["started_at"]).replace("Z", "+00:00"))
                    duration = (datetime.now(timezone.utc) - started_dt).total_seconds()
                except Exception:
                    duration = None
            _finish_task(
                db,
                t,
                status="completed",
                duration=duration,
                outcome_label="Ended by user",
                user=user,
                hangup=True,
            )
            ended_task = t
            break

    return {"ok": True, "task": ended_task, "followup": (ended_task or {}).get("followup")}


@router.delete("/tasks/{task_id}")
def delete_task(
    task_id: int,
    user: AppUser = Depends(get_current_user),
) -> dict[str, bool]:
    _ = user
    global _TASKS
    _TASKS = [t for t in _TASKS if t.get("id") != task_id]
    _refresh_runner_counts()
    return {"ok": True}


@router.post("/tasks/{task_id}/skip")
def skip_task(
    task_id: int,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    for t in _TASKS:
        if t.get("id") == task_id:
            t["status"] = "skipped"
            _refresh_runner_counts()
            return t
    raise HTTPException(404, "Task not found")


@router.post("/runners/start")
def start_runner(
    payload: RunnerControlRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    runner = _get_runner(payload.persona)
    if not runner:
        raise HTTPException(404, "Runner persona not found")

    in_prog = next(
        (
            t
            for t in _TASKS
            if t.get("persona") == payload.persona and t.get("status") in ("in_progress", "running")
        ),
        None,
    )
    if in_prog:
        runner["status"] = "running"
        runner["sequence_mode"] = bool(payload.sequence) if payload.task_id is None else False
        runner["operator_user_id"] = user.id
        runner["current_task_id"] = in_prog.get("id")
        runner["current_task"] = in_prog
        return runner

    if payload.task_id:
        nxt = _find_task(payload.task_id)
        if not nxt:
            raise HTTPException(404, "Queue item not found")
        if nxt.get("persona") != payload.persona:
            raise HTTPException(400, "That queue item belongs to the other agent.")
        if nxt.get("status") != "queued":
            raise HTTPException(400, "That queue item is not waiting to be called.")
        runner["sequence_mode"] = False
    else:
        nxt = _next_queued(payload.persona)
        runner["sequence_mode"] = bool(payload.sequence)
        if not nxt:
            runner["status"] = "idle"
            raise HTTPException(400, "No ready contacts in this agent's queue.")

    runner["operator_user_id"] = user.id
    _dial_task(db, task=nxt, user=user)
    _refresh_runner_counts()
    return runner


@router.post("/runners/pause")
def pause_runner(
    payload: RunnerControlRequest,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    runner = _get_runner(payload.persona)
    if not runner:
        raise HTTPException(404, "Runner persona not found")
    runner["status"] = "paused"
    runner["sequence_mode"] = False
    return runner


class UpdateRulesRequest(BaseModel):
    rules: str


@router.get("/training")
def get_ai_training_info(db: Session = Depends(get_db), user: AppUser = Depends(get_current_user)):
    _ = user
    from modules.ai_agent_training import get_training_knowledge
    return get_training_knowledge(db)


@router.post("/train-from-history")
def train_ai_from_history(db: Session = Depends(get_db), user: AppUser = Depends(get_current_user)):
    _ = user
    from modules.ai_agent_training import train_agent_from_history
    return train_agent_from_history(db)


@router.post("/update-rules")
def update_ai_sales_rules(payload: UpdateRulesRequest, user: AppUser = Depends(get_current_user)):
    _ = user
    from modules.ai_agent_training import update_custom_rules
    return update_custom_rules(payload.rules)


@webhooks_router.post("/ai-agent")
async def vapi_ai_agent_status(request: Request) -> dict[str, Any]:
    """Vapi end-of-call / status-update — auto WhatsApp + email, then next in queue."""
    try:
        body = await request.json()
    except Exception:
        return {"ok": True}
    message = body.get("message") if isinstance(body, dict) else None
    if not isinstance(message, dict):
        message = body if isinstance(body, dict) else {}
    msg_type = str(message.get("type") or "")
    if msg_type and msg_type not in {"end-of-call-report", "status-update"}:
        return {"ok": True, "ignored": True}
    call = message.get("call") if isinstance(message.get("call"), dict) else body.get("call") or {}
    metadata = {}
    if isinstance(call, dict) and isinstance(call.get("metadata"), dict):
        metadata = call["metadata"]
    elif isinstance(message.get("metadata"), dict):
        metadata = message["metadata"]
    task_id = metadata.get("task_id") if isinstance(metadata, dict) else None
    try:
        task_id_int = int(task_id) if task_id is not None else None
    except (TypeError, ValueError):
        task_id_int = None
    call_sid = None
    if isinstance(call, dict):
        call_sid = call.get("id") or call.get("callId")
    ended_reason = message.get("endedReason") or message.get("ended_reason") or call.get("endedReason")
    status = message.get("status") or call.get("status") or ended_reason
    duration = (
        message.get("durationSeconds")
        or message.get("duration")
        or (call.get("duration") if isinstance(call, dict) else None)
    )
    if msg_type == "status-update" and str(status or "").lower() not in {
        "ended",
        "completed",
        "failed",
    }:
        return {"ok": True, "ignored": True}
    return handle_ai_call_status(
        task_id=task_id_int,
        call_sid=str(call_sid) if call_sid else None,
        status=str(status or ""),
        duration=duration,
        ended_reason=str(ended_reason or ""),
    )
