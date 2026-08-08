"""Personalized post-call follow-up drafts (Mail → Personalized Emails)."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser, PersonalizedFollowupDraft
from modules import personalized_followups as pf_module

router = APIRouter(prefix="/personalized-followups", tags=["personalized-followups"])


class PersonalizedFollowupUpdate(BaseModel):
    subject: Optional[str] = Field(default=None, max_length=500)
    email_body: Optional[str] = None
    whatsapp_body: Optional[str] = None


class PersonalizedFollowupSend(BaseModel):
    """Send one or both channels. Use template_* when outside the 24h WA window."""

    channels: str = Field(
        default="both",
        description="email | whatsapp | both",
    )
    template_name: Optional[str] = None
    template_language: str = "en_US"
    template_variables: list[str] = Field(default_factory=list)


def _generate_in_background(draft_id: int) -> None:
    from db.session import SessionLocal

    db = SessionLocal()
    try:
        pf_module.generate_draft_content(db, draft_id)
    except Exception:  # noqa: BLE001
        pass
    finally:
        db.close()


@router.get("")
def list_personalized_followups(
    status: Optional[str] = None,
    limit: int = Query(100, ge=1, le=200),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    return pf_module.list_drafts(db, viewer=user, status=status, limit=limit)


@router.get("/by-interaction/{interaction_id}")
def get_personalized_followup_by_interaction(
    interaction_id: int,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    draft = pf_module.get_draft_for_interaction(db, interaction_id=interaction_id)
    if not draft:
        raise HTTPException(404, "No call confirmation draft for this interaction")
    return draft


@router.get("/{draft_id}")
def get_personalized_followup(
    draft_id: int,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise HTTPException(404, "Personalized draft not found")
    return pf_module.draft_to_dict(db, draft)


@router.patch("/{draft_id}")
def update_personalized_followup(
    draft_id: int,
    payload: PersonalizedFollowupUpdate,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        draft = pf_module.update_draft(
            db,
            draft_id,
            subject=payload.subject,
            email_body=payload.email_body,
            whatsapp_body=payload.whatsapp_body,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return pf_module.draft_to_dict(db, draft)


@router.post("/{draft_id}/regenerate")
def regenerate_personalized_followup(
    draft_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise HTTPException(404, "Personalized draft not found")
    if draft.status == "sent":
        raise HTTPException(400, "Already sent")
    draft.status = "generating"
    db.commit()
    background_tasks.add_task(_generate_in_background, draft_id)
    db.refresh(draft)
    return pf_module.draft_to_dict(db, draft)


@router.post("/{draft_id}/send")
def send_personalized_followup(
    draft_id: int,
    payload: PersonalizedFollowupSend | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    body = payload or PersonalizedFollowupSend()
    try:
        return pf_module.send_draft(
            db,
            draft_id,
            user=user,
            channels=body.channels,
            template_name=body.template_name,
            template_language=body.template_language,
            template_variables=body.template_variables,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/{draft_id}/dismiss")
def dismiss_personalized_followup(
    draft_id: int,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        draft = pf_module.dismiss_draft(db, draft_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return pf_module.draft_to_dict(db, draft)
