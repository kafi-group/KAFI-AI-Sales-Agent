"""AI Sales Agent (Rayan & Sara) queue & outbound calling router."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser, Buyer
from modules import sales_assistant as assistant_module

router = APIRouter(prefix="/ai-sales-agent", tags=["ai-sales-agent"])


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


class RunnerControlRequest(BaseModel):
    persona: str


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
    },
]

_TASKS: list[dict[str, Any]] = []


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _auto_followup_after_call(
    db: Session,
    *,
    user: AppUser,
    agent_name: str,
    contact_name: str,
    phone: str | None,
    email: str | None,
    company_name: str | None = None,
) -> dict[str, Any]:
    """Send personal WhatsApp (Baileys) + email when Sara/Rayan place a call.

    Does not use Meta WhatsApp Cloud API.
    """
    from integrations import whatsapp_bridge_client as bridge
    from integrations.mail_client import mail_client

    company = (company_name or "").strip()
    greet_name = (contact_name or "there").strip() or "there"
    wa_text = (
        f"Hello {greet_name}, this is {agent_name} from Kafi Commodities (Brand: ESSENCE).\n\n"
        "I am calling you now regarding our export range — Basmati Rice, Himalayan Pink Salt, "
        "spices, pickles, and more.\n\n"
        "Please pick up if you can. If we miss each other, reply here and I will share catalogues and pricing.\n\n"
        f"Best regards,\n{agent_name}\nKafi Commodities Export Team"
    )
    if company:
        wa_text = wa_text.replace(
            "regarding our export range",
            f"regarding supply for {company} — our export range",
            1,
        )

    result: dict[str, Any] = {
        "whatsapp_status": "skipped",
        "whatsapp_message": None,
        "email_status": "skipped",
        "email_message": None,
        "email_to": email,
    }

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
            subject = f"{agent_name} from Kafi Commodities is calling you"
            body = (
                f"<p>Dear {greet_name},</p>"
                f"<p>This is <strong>{agent_name}</strong> from "
                f"<strong>Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE)</strong>.</p>"
                "<p>I am calling you now regarding our export range — Basmati Rice, "
                "Himalayan Pink Salt, spices, pickles, chutneys, and more.</p>"
                "<p>If we miss each other on the call, please reply to this email and we will "
                "share catalogues, packaging options, and CNF/FOB pricing.</p>"
                f"<p>Best regards,<br/><strong>{agent_name}</strong><br/>"
                "Kafi Commodities Export Team<br/>"
                '<a href="https://www.kafi-group.com">www.kafi-group.com</a></p>'
            )
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
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
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
    created = []
    for bid in payload.buyer_ids:
        buyer = db.get(Buyer, bid)
        company_name = buyer.company_name if buyer else f"Lead #{bid}"
        contact_name = buyer.contacts[0].full_name if (buyer and buyer.contacts) else "Purchasing Manager"
        first_contact = buyer.contacts[0] if (buyer and buyer.contacts) else None
        contact_phone = None
        contact_email = None
        if first_contact:
            contact_phone = first_contact.phone or first_contact.primary_phone or first_contact.wa_id
            contact_email = (first_contact.email or first_contact.secondary_email or "").strip() or None
        if not contact_phone:
            contact_phone = getattr(buyer, "phone", None)
        task = {
            "id": len(_TASKS) + 1,
            "persona": payload.persona,
            "buyer_id": bid,
            "contact_id": first_contact.id if first_contact else None,
            "company_name": company_name,
            "contact_name": contact_name,
            "contact_phone": contact_phone,
            "contact_email": contact_email,
            "status": "queued",
            "ready": bool(contact_phone),
            "created_at": _now_iso(),
        }
        _TASKS.append(task)
        created.append(task)
    return {"tasks": created}


@router.post("/tasks/self-test")
def queue_self_test(
    payload: SelfTestRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    from integrations.voice_client import voice_client

    agent_name = "Sara" if payload.persona == "female" else "Rayan"
    contact_name = payload.contact_name or "Mr. Khalid"

    call_result = voice_client.place_outbound_ai_call(
        payload.phone,
        persona=payload.persona,
        contact_name=contact_name,
        language=payload.language or "en",
    )

    if not call_result.get("ok"):
        raise HTTPException(
            status_code=400,
            detail=f"Twilio Voice Error: {call_result.get('error')}",
        )

    # Match contact by phone if present so the call links to this lead's profile
    contact_id = None
    contact_email = (user.mailbox_email or "").strip() or None
    if payload.phone:
        try:
            from db.models import Contact
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

    followup = _auto_followup_after_call(
        db,
        user=user,
        agent_name=agent_name,
        contact_name=contact_name,
        phone=payload.phone,
        email=contact_email,
        company_name=None,
    )

    # Log interaction to DB for Call Center & Client History
    try:
        from db.models import Interaction, Channel, Direction, HandledBy, InteractionStatus
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

    task = {
        "id": len(_TASKS) + 1,
        "persona": payload.persona,
        "buyer_id": 0,
        "contact_id": contact_id,
        "company_name": "Direct AI Call",
        "contact_name": contact_name,
        "contact_phone": payload.phone,
        "contact_email": contact_email,
        "call_sid": call_result.get("call_sid"),
        "status": "in_progress",
        "ready": True,
        "is_test": True,
        "created_at": _now_iso(),
        "started_at": _now_iso(),
        "outcome": "Calling",
        "remarks": f"Calling {payload.phone} live (SID: {call_result.get('call_sid')})...",
        "followup": followup,
    }
    _TASKS.insert(0, task)
    for r in _RUNNERS:
        if r.get("persona") == payload.persona:
            r["status"] = "running"
            r["current_task_id"] = task["id"]
            r["current_task"] = task
    return {"task": task, "call_result": call_result, "followup": followup}


class EndCallRequest(BaseModel):
    persona: str | None = None
    call_sid: str | None = None
    task_id: int | None = None


@router.post("/end-call")
def end_ai_call(
    payload: EndCallRequest,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    from integrations.voice_client import voice_client

    ended_task = None
    for t in _TASKS:
        matches = False
        if payload.task_id and t.get("id") == payload.task_id:
            matches = True
        elif payload.persona and t.get("persona") == payload.persona and t.get("status") in ("in_progress", "running", "queued"):
            matches = True
        elif not payload.task_id and not payload.persona and t.get("status") in ("in_progress", "running"):
            matches = True

        if matches:
            t["status"] = "completed"
            t["outcome"] = "Ended by user"
            t["remarks"] = "Call ended manually by user."
            ended_task = t
            sid = payload.call_sid or t.get("call_sid")
            if sid:
                voice_client.end_call(sid)
            break

    target_persona = payload.persona or (ended_task.get("persona") if ended_task else None)
    for r in _RUNNERS:
        if not target_persona or r.get("persona") == target_persona:
            r["status"] = "idle"
            r["current_task_id"] = None
            r["current_task"] = None

    return {"ok": True, "task": ended_task}


@router.delete("/tasks/{task_id}")
def delete_task(
    task_id: int,
    user: AppUser = Depends(get_current_user),
) -> dict[str, bool]:
    _ = user
    global _TASKS
    _TASKS = [t for t in _TASKS if t.get("id") != task_id]
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
            return t
    raise HTTPException(404, "Task not found")


@router.post("/runners/start")
def start_runner(
    payload: RunnerControlRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    from integrations.voice_client import voice_client

    for r in _RUNNERS:
        if r.get("persona") != payload.persona:
            continue
        r["status"] = "running"
        in_prog = next(
            (
                t
                for t in _TASKS
                if t.get("persona") == payload.persona and t.get("status") in ("in_progress", "running")
            ),
            None,
        )
        if in_prog:
            return r

        nxt = next(
            (
                t
                for t in _TASKS
                if t.get("persona") == payload.persona
                and t.get("status") == "queued"
                and t.get("ready")
                and t.get("contact_phone")
            ),
            None,
        )
        if not nxt:
            return r

        agent_name = "Sara" if payload.persona == "female" else "Rayan"
        contact_name = nxt.get("contact_name") or "Purchasing Manager"
        phone = nxt.get("contact_phone")
        call_result = voice_client.place_outbound_ai_call(
            phone,
            persona=payload.persona,
            contact_name=contact_name,
            language="en",
        )
        if not call_result.get("ok"):
            nxt["status"] = "failed"
            nxt["remarks"] = f"Twilio Voice Error: {call_result.get('error')}"
            r["status"] = "idle"
            raise HTTPException(400, f"Twilio Voice Error: {call_result.get('error')}")

        email = nxt.get("contact_email") or (user.mailbox_email or "").strip() or None
        followup = _auto_followup_after_call(
            db,
            user=user,
            agent_name=agent_name,
            contact_name=contact_name,
            phone=phone,
            email=email,
            company_name=nxt.get("company_name"),
        )
        nxt["status"] = "in_progress"
        nxt["call_sid"] = call_result.get("call_sid")
        nxt["started_at"] = _now_iso()
        nxt["followup"] = followup
        nxt["remarks"] = f"Calling {phone} live (SID: {call_result.get('call_sid')})..."
        r["current_task_id"] = nxt["id"]
        r["current_task"] = nxt
        return r
    raise HTTPException(404, "Runner persona not found")


@router.post("/runners/pause")
def pause_runner(
    payload: RunnerControlRequest,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    for r in _RUNNERS:
        if r.get("persona") == payload.persona:
            r["status"] = "paused"
            return r
    raise HTTPException(404, "Runner persona not found")


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
