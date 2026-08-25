"""Helpful Guidance API."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from api.auth import get_current_user
from db.models import AppUser
from db.session import get_db
from modules.helpful_guidance import generate_helpful_guidance

router = APIRouter(prefix="/guidance", tags=["guidance"])


@router.get("/helpful")
def get_helpful_guidance(
    months: int = Query(3, ge=1, le=12),
    user_id: str | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    return generate_helpful_guidance(
        db,
        viewer=user,
        months=months,
        user_id=user_id,
    )
