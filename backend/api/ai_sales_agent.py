"""AI Sales Agent — assigned outbound FMCG calling (male & female personas)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db, require_admin
from api.calls import _twilio_form, _twiml_response
from db.models import AppUser
from db.session import SessionLocal
from integrations.voice_client import voice_client
from modules.ai_sales_agent import campaign as campaign_module
from modules.ai_sales_agent.conversation import generate_reply
from modules.ai_sales_agent.context import build_lead_context
from modules.ai_sales_agent.personas import get_persona
from modules import calls as calls_module

router = APIRouter(prefix="/ai-sales-agent", tags=["ai-sales-agent"])
webhooks_router = APIRouter(prefix="/webhooks/twilio/ai-sales", tags=["ai-sales-webhooks"])
log = logging.getLogger(__name__)


class AssignTasksRequest(BaseModel):
    persona: str = Field(..., description="'male' (Rayan) or 'female' (Sara)")
    buyer_ids: list[int] = Field(..., min_length=1)
    contact_ids: list[int | None] | None = None


class PersonaActionRequest(BaseModel):
    persona: str


class LeadBriefingResponse(BaseModel):
    buyer_id: int
    ready: bool
    warnings: list[str]
    context_text: str


@router.get("/runners")
def list_runners(db: Session = Depends(get_db), _user: AppUser = Depends(get_current_user)):
    return {"runners": campaign_module.runner_snapshot(db)}


@router.get("/tasks")
def list_tasks(
    persona: str | None = None,
    status: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
):
    return {"tasks": campaign_module.list_tasks(db, persona=persona, status=status, limit=limit)}


@router.post("/tasks/assign")
def assign_tasks(
    payload: AssignTasksRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    try:
        tasks = campaign_module.assign_tasks(
            db,
            persona=payload.persona,
            buyer_ids=payload.buyer_ids,
            contact_ids=payload.contact_ids,
            assigned_by_user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"tasks": tasks}


@router.delete("/tasks/{task_id}", status_code=204)
def delete_task(
    task_id: int,
    db: Session = Depends(get_db),
    _admin: AppUser = Depends(require_admin),
):
    try:
        if not campaign_module.remove_task(db, task_id):
            raise HTTPException(404, "Task not found")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(status_code=204)


@router.post("/tasks/{task_id}/skip")
def skip_task(
    task_id: int,
    db: Session = Depends(get_db),
    _admin: AppUser = Depends(require_admin),
):
    try:
        return campaign_module.skip_task(db, task_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/runners/start")
def start_runner(
    payload: PersonaActionRequest,
    db: Session = Depends(get_db),
    _admin: AppUser = Depends(require_admin),
):
    try:
        return campaign_module.start_runner(db, payload.persona)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/runners/pause")
def pause_runner(
    payload: PersonaActionRequest,
    db: Session = Depends(get_db),
    _admin: AppUser = Depends(require_admin),
):
    try:
        return campaign_module.pause_runner(db, payload.persona)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/briefing/{buyer_id}", response_model=LeadBriefingResponse)
def lead_briefing(
    buyer_id: int,
    contact_id: int | None = None,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
):
    try:
        data = build_lead_context(db, buyer_id=buyer_id, contact_id=contact_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return LeadBriefingResponse(
        buyer_id=buyer_id,
        ready=data["ready"],
        warnings=data["warnings"],
        context_text=data["context_text"],
    )


def _finalize_in_background(task_id: int, call_status: str | None, duration: int | None) -> None:
    db = SessionLocal()
    try:
        campaign_module.on_call_completed(
            db,
            task_id,
            call_status=call_status,
            duration_seconds=duration,
        )
    except Exception:
        log.exception("AI sales background finalize failed task=%s", task_id)
    finally:
        db.close()


@webhooks_router.post("/voice")
async def ai_sales_voice(request: Request):
    """First TwiML — AI agent opening line."""
    task_id_raw = request.query_params.get("task_id")
    if not task_id_raw:
        return _twiml_response(voice_client.say_twiml("Missing task reference."))
    try:
        task_id = int(task_id_raw)
    except ValueError:
        return _twiml_response(voice_client.say_twiml("Invalid task reference."))

    db = SessionLocal()
    try:
        task = campaign_module.get_task(db, task_id)
        if not task:
            return _twiml_response(voice_client.say_twiml("Call task not found."))
        state = campaign_module.get_transcript_state(task)
        opening = str(state.get("opening") or "")
        persona = get_persona(task.persona)
        xml = campaign_module.build_gather_twiml(
            voice=persona.voice,
            spoken=opening,
            task_id=task_id,
        )
        return _twiml_response(xml)
    except Exception as exc:
        log.exception("ai-sales voice webhook failed: %s", exc)
        return _twiml_response(voice_client.say_twiml("The AI agent could not start this call."))
    finally:
        db.close()


@webhooks_router.post("/turn")
async def ai_sales_turn(request: Request):
    """Speech turn — Gemini reply then Say + Gather."""
    task_id_raw = request.query_params.get("task_id")
    if not task_id_raw:
        return _twiml_response(voice_client.say_twiml("Missing task reference."))
    try:
        task_id = int(task_id_raw)
    except ValueError:
        return _twiml_response(voice_client.say_twiml("Invalid task reference."))

    try:
        form = await _twilio_form(request)
    except HTTPException:
        return _twiml_response(voice_client.say_twiml("Webhook verification failed."))

    user_text = str(form.get("SpeechResult") or "").strip()

    db = SessionLocal()
    try:
        task = campaign_module.get_task(db, task_id)
        if not task:
            return _twiml_response(voice_client.say_twiml("Call task not found."))

        state = campaign_module.get_transcript_state(task)
        system_prompt = str(state.get("system_prompt") or "")
        history = list(state.get("history") or [])
        turn = int(state.get("turn") or 0) + 1
        persona = get_persona(task.persona)

        spoken, meta, history = generate_reply(
            system_prompt=system_prompt,
            history=history,
            user_text=user_text,
        )
        outcome = meta.get("outcome")
        remark = meta.get("remark")
        end_call = "[END_CALL]" in (spoken or "") or turn >= campaign_module.MAX_CONVERSATION_TURNS
        if outcome in {"interested", "not_interested", "not_received_call", "follow_up"}:
            end_call = True

        campaign_module.save_turn_result(
            db,
            task_id,
            history=history,
            turn=turn,
            outcome=str(outcome) if outcome else None,
            remarks=str(remark) if remark else None,
        )

        if end_call:
            closing = spoken or "Thank you for your time. Goodbye."
            xml = campaign_module.build_gather_twiml(
                voice=persona.voice,
                spoken=closing,
                task_id=task_id,
                final=True,
            )
            return _twiml_response(xml)

        xml = campaign_module.build_gather_twiml(
            voice=persona.voice,
            spoken=spoken or "Could you tell me a bit more about your import needs?",
            task_id=task_id,
        )
        return _twiml_response(xml)
    except Exception as exc:
        log.exception("ai-sales turn webhook failed: %s", exc)
        return _twiml_response(voice_client.say_twiml("Sorry, we had a technical issue. Goodbye."))
    finally:
        db.close()


@webhooks_router.post("/status")
async def ai_sales_status(
    request: Request,
    background_tasks: BackgroundTasks,
):
    task_id_raw = request.query_params.get("task_id")
    if not task_id_raw:
        return {"ok": True}
    try:
        task_id = int(task_id_raw)
    except ValueError:
        return {"ok": True}

    try:
        form = await _twilio_form(request)
    except HTTPException:
        return {"ok": True}

    status = str(form.get("CallStatus") or "unknown")
    duration_raw = str(form.get("CallDuration") or "")
    duration = int(duration_raw) if duration_raw.isdigit() else None

    if status != "completed":
        # no-answer, busy, failed — still finalize
        if status in {"busy", "no-answer", "failed", "canceled"}:
            background_tasks.add_task(_finalize_in_background, task_id, status, duration)
        return {"ok": True}

    background_tasks.add_task(_finalize_in_background, task_id, status, duration)
    return {"ok": True}


@webhooks_router.post("/recording")
async def ai_sales_recording(request: Request):
    form = await _twilio_form(request)
    task_id_raw = request.query_params.get("task_id")
    if not task_id_raw:
        return {"ok": True}
    try:
        task_id = int(task_id_raw)
    except ValueError:
        return {"ok": True}

    db = SessionLocal()
    try:
        task = campaign_module.get_task(db, task_id)
        if not task or not task.interaction_id:
            return {"ok": True}
        recording_sid = str(form.get("RecordingSid") or "")
        recording_url = str(form.get("RecordingUrl") or "")
        if recording_sid and recording_url:
            calls_module.save_call_recording(
                db,
                interaction_id=task.interaction_id,
                recording_sid=recording_sid,
                recording_url=recording_url,
                recording_status=str(form.get("RecordingStatus") or "completed"),
                recording_duration=str(form.get("RecordingDuration") or "") or None,
            )
    except Exception:
        log.exception("ai-sales recording webhook failed task=%s", task_id_raw)
    finally:
        db.close()
    return {"ok": True}
