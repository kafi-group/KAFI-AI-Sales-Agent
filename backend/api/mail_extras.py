"""Mail labels + compose drafts API (nested under /inbox)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser
from modules import mail_drafts as drafts_module
from modules import mail_labels as labels_module

router = APIRouter(prefix="/inbox", tags=["inbox"])


class MailLabelRead(BaseModel):
    id: int
    name: str
    color: str
    match_query: Optional[str] = None
    match_keyword: Optional[str] = None
    count: int = 0

    model_config = {"from_attributes": True}


class MailLabelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field(default="#34d399", max_length=32)
    match_query: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Domain or full email — routes by sender/recipient address only",
    )
    match_keyword: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Keyword — routes when found in subject, preview, or body",
    )


class MailLabelAssignRequest(BaseModel):
    label_id: int
    folder: str = "inbox"
    message_uid: str
    message_id: Optional[str] = None
    thread_id: Optional[str] = None
    from_email: Optional[str] = None
    subject: Optional[str] = None
    apply_similar: bool = False


class MailLabelUnassignRequest(BaseModel):
    label_id: int
    folder: str = "inbox"
    message_uid: str


class MailDraftRead(BaseModel):
    id: int
    to_addrs: str
    cc_addrs: str
    subject: str
    body: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class MailDraftUpsert(BaseModel):
    id: Optional[int] = None
    to_addrs: str = ""
    cc_addrs: str = ""
    subject: str = ""
    body: str = ""


@router.get("/labels", response_model=list[MailLabelRead])
def list_mail_labels(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    counts = labels_module.label_display_counts(db, user)
    return [
        MailLabelRead(
            id=label.id,
            name=label.name,
            color=label.color,
            match_query=label.match_query,
            match_keyword=label.match_keyword,
            count=counts.get(label.id, 0),
        )
        for label in labels_module.list_labels(db, user.id)
    ]


@router.post("/labels", response_model=MailLabelRead, status_code=201)
def create_mail_label(
    body: MailLabelCreate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    try:
        label = labels_module.create_label(
            db,
            user.id,
            name=body.name,
            color=body.color,
            match_query=body.match_query,
            match_keyword=body.match_keyword,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return MailLabelRead(
        id=label.id,
        name=label.name,
        color=label.color,
        match_query=label.match_query,
        match_keyword=label.match_keyword,
        count=0,
    )


@router.delete("/labels/{label_id}", status_code=204)
def delete_mail_label(
    label_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> None:
    if not labels_module.delete_label(db, user.id, label_id):
        raise HTTPException(404, "Label not found")


@router.post("/labels/assign")
def assign_mail_label(
    body: MailLabelAssignRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    try:
        return labels_module.assign_label(
            db,
            user.id,
            label_id=body.label_id,
            folder=body.folder,
            message_uid=body.message_uid,
            message_id=body.message_id,
            thread_id=body.thread_id,
            from_email=body.from_email,
            subject=body.subject,
            apply_similar=body.apply_similar,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/labels/unassign")
def unassign_mail_label(
    body: MailLabelUnassignRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    ok = labels_module.unassign_label(
        db,
        user.id,
        label_id=body.label_id,
        folder=body.folder,
        message_uid=body.message_uid,
    )
    return {"removed": ok}


@router.get("/labels/map/by-uids")
def map_labels_by_uids(
    folder: str = "inbox",
    uids: str = "",
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    uid_list = [u.strip() for u in (uids or "").split(",") if u.strip()]
    return labels_module.labels_for_messages(db, user.id, folder=folder, message_uids=uid_list)


@router.get("/labels/{label_id}/messages")
def list_label_messages(
    label_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    try:
        return labels_module.message_keys_for_label(db, user.id, label_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/drafts", response_model=list[MailDraftRead])
def list_compose_drafts(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    return drafts_module.list_drafts(db, user.id)


@router.get("/drafts/count")
def compose_draft_count(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    return {"count": drafts_module.draft_count(db, user.id)}


@router.post("/drafts", response_model=MailDraftRead)
def upsert_compose_draft(
    body: MailDraftUpsert,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    # Skip empty drafts
    if not any(
        [
            (body.to_addrs or "").strip(),
            (body.cc_addrs or "").strip(),
            (body.subject or "").strip(),
            (body.body or "").strip(),
        ]
    ):
        raise HTTPException(400, "Draft is empty")
    draft = drafts_module.upsert_draft(
        db,
        user.id,
        draft_id=body.id,
        to_addrs=body.to_addrs,
        cc_addrs=body.cc_addrs,
        subject=body.subject,
        body=body.body,
    )
    return draft


@router.delete("/drafts/{draft_id}", status_code=204)
def delete_compose_draft(
    draft_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> None:
    if not drafts_module.delete_draft(db, user.id, draft_id):
        raise HTTPException(404, "Draft not found")
