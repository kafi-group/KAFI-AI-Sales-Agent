"""AI Sales Agent (Rayan & Sara) queue & outbound calling router."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query
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
        contact_phone = buyer.contacts[0].mobile if (buyer and buyer.contacts) else getattr(buyer, "phone", None)
        task = {
            "id": len(_TASKS) + 1,
            "persona": payload.persona,
            "buyer_id": bid,
            "contact_id": buyer.contacts[0].id if (buyer and buyer.contacts) else None,
            "company_name": company_name,
            "contact_name": contact_name,
            "contact_phone": contact_phone,
            "status": "queued",
            "ready": bool(contact_phone),
            "created_at": "2026-08-24T13:00:00Z",
        }
        _TASKS.append(task)
        created.append(task)
    return {"tasks": created}


@router.post("/tasks/self-test")
def queue_self_test(
    payload: SelfTestRequest,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    task = {
        "id": len(_TASKS) + 1,
        "persona": payload.persona,
        "buyer_id": 0,
        "contact_id": None,
        "company_name": "Direct AI Call",
        "contact_name": payload.contact_name or "Self Test Contact",
        "contact_phone": payload.phone,
        "status": "in_progress",
        "ready": True,
        "is_test": True,
        "created_at": "2026-08-24T13:00:00Z",
        "started_at": "2026-08-24T13:00:00Z",
        "outcome": "Calling",
        "remarks": f"Calling {payload.phone} live...",
    }
    _TASKS.insert(0, task)
    for r in _RUNNERS:
        if r.get("persona") == payload.persona:
            r["status"] = "running"
            r["current_task_id"] = task["id"]
            r["current_task"] = task
    return {"task": task}


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
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    for r in _RUNNERS:
        if r.get("persona") == payload.persona:
            r["status"] = "running"
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
