"""Personal WhatsApp (Baileys bridge) — per-user QR sessions."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.deps import get_current_user
from db.models import AppUser
from integrations import whatsapp_bridge_client as bridge

router = APIRouter(prefix="/whatsapp-personal", tags=["whatsapp-personal"])


class WhatsAppPersonalSendRequest(BaseModel):
    to_phone: str = Field(min_length=6, max_length=32)
    message: str = Field(min_length=1, max_length=4096)


@router.get("/status")
def whatsapp_personal_status(user: AppUser = Depends(get_current_user)) -> Any:
    try:
        return bridge.bridge_status(user.id)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not reach WhatsApp bridge: {exc}") from exc


@router.get("/qr")
def whatsapp_personal_qr(user: AppUser = Depends(get_current_user)) -> Any:
    try:
        return bridge.bridge_qr(user.id)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not load QR from bridge: {exc}") from exc


@router.get("/session")
def whatsapp_personal_session(user: AppUser = Depends(get_current_user)) -> dict[str, str]:
    return {"session_id": bridge.bridge_session_id(user.id)}


@router.post("/send")
def whatsapp_personal_send(
    body: WhatsAppPersonalSendRequest,
    user: AppUser = Depends(get_current_user),
) -> Any:
    try:
        status = bridge.bridge_status(user.id)
        if not status.get("connected"):
            raise HTTPException(
                409,
                "Personal WhatsApp is not connected. Open WhatsApp QR and scan with your phone.",
            )
        return bridge.bridge_send(user.id, to_phone=body.to_phone, message=body.message)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Personal WhatsApp send failed: {exc}") from exc
