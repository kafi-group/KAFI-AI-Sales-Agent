"""Call follow-ups for AI Agents: situation groups + drafts (Email templates -> 3rd tab).

Storage/CRUD only for now: nothing here sends email/WhatsApp, dials, or changes any queue.
Every request opens its own short database connection (no request-long sessions).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from modules import call_followups as cf

router = APIRouter(prefix="/call-followups", tags=["call-followups"])


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    enabled: bool = True


class GroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    enabled: bool | None = None


class DraftCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    subject: str = Field(default="", max_length=500)
    body: str = ""
    whatsapp_text: str = ""
    attachment_mode: Literal["none", "auto", "catalogue"] = "none"
    catalogue_ids: list[str] = Field(default_factory=list)
    enabled: bool = True


class DraftUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    subject: str | None = Field(default=None, max_length=500)
    body: str | None = None
    whatsapp_text: str | None = None
    attachment_mode: Literal["none", "auto", "catalogue"] | None = None
    catalogue_ids: list[str] | None = None
    enabled: bool | None = None


class MarkSet(BaseModel):
    mark: Literal["do_not_disturb", "not_interested"]
    reason: str | None = None


@router.get("")
def list_followups() -> dict[str, Any]:
    return {"groups": cf.list_all(), "placeholders": cf.PLACEHOLDERS}


@router.post("/groups", status_code=201)
def create_group(payload: GroupCreate) -> dict[str, Any]:
    return cf.create_group(payload.name, payload.description, payload.enabled)


@router.patch("/groups/{group_id}")
def update_group(group_id: int, payload: GroupUpdate) -> dict[str, Any]:
    group = cf.update_group(group_id, payload.model_dump(exclude_unset=True))
    if group is None:
        raise HTTPException(404, "Situation group not found")
    return group


@router.delete("/groups/{group_id}")
def delete_group(group_id: int) -> dict[str, bool]:
    if not cf.delete_group(group_id):
        raise HTTPException(404, "Situation group not found")
    return {"ok": True}


@router.post("/groups/{group_id}/drafts", status_code=201)
def create_draft(group_id: int, payload: DraftCreate) -> dict[str, Any]:
    draft = cf.create_draft(group_id, payload.model_dump())
    if draft is None:
        raise HTTPException(404, "Situation group not found")
    return draft


@router.patch("/drafts/{draft_id}")
def update_draft(draft_id: int, payload: DraftUpdate) -> dict[str, Any]:
    draft = cf.update_draft(draft_id, payload.model_dump(exclude_unset=True))
    if draft is None:
        raise HTTPException(404, "Draft not found")
    return draft


@router.delete("/drafts/{draft_id}")
def delete_draft(draft_id: int) -> dict[str, bool]:
    if not cf.delete_draft(draft_id):
        raise HTTPException(404, "Draft not found")
    return {"ok": True}


@router.get("/marks/{buyer_id}")
def get_mark(buyer_id: int) -> dict[str, Any]:
    return {"mark": cf.get_mark(buyer_id)}


@router.put("/marks/{buyer_id}")
def set_mark(buyer_id: int, payload: MarkSet) -> dict[str, Any]:
    return {"mark": cf.set_mark(buyer_id, payload.mark, payload.reason)}


@router.delete("/marks/{buyer_id}")
def clear_mark(buyer_id: int) -> dict[str, bool]:
    return {"ok": cf.clear_mark(buyer_id)}
