"""Telegram Mobile — personal Telegram user account via MTProto bridge."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.deps import get_current_user
from db.models import AppUser
from integrations import telegram_bridge_client as bridge

router = APIRouter(prefix="/telegram-personal", tags=["telegram-personal"])


class PhoneLoginBody(BaseModel):
    phone: str = Field(..., min_length=8, max_length=32)


class CodeBody(BaseModel):
    code: str = Field(..., min_length=3, max_length=16)


class PasswordBody(BaseModel):
    password: str = Field(..., min_length=1, max_length=128)


class SendBody(BaseModel):
    to_phone: str = Field(..., min_length=5, max_length=64)
    message: str = Field(..., min_length=1, max_length=4000)


def _session(user: AppUser) -> str:
    return bridge.bridge_session_id(int(user.id), user.username)


@router.get("/session")
def get_session(user: AppUser = Depends(get_current_user)):
    return {
        "session_id": _session(user),
        "bridge_configured": bridge.bridge_configured(),
    }


@router.get("/status")
def get_status(user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        return {
            "connected": False,
            "status": "unconfigured",
            "configured": False,
            "message": (
                "Telegram bridge not configured. Deploy telegram_bridge, set TELEGRAM_API_ID / "
                "TELEGRAM_API_HASH on the bridge and TELEGRAM_BRIDGE_URL on Sales Agent."
            ),
        }
    try:
        data = bridge.get_status(_session(user))
        data["configured"] = True
        data["bridge_configured"] = True
        return data
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/start-login")
def start_login(body: PhoneLoginBody, user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.start_login(_session(user), body.phone.strip())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/confirm-code")
def confirm_code(body: CodeBody, user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.confirm_code(_session(user), body.code.strip())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/confirm-password")
def confirm_password(body: PasswordBody, user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.confirm_password(_session(user), body.password)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/disconnect")
def disconnect(user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.disconnect(_session(user))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/send")
def send_message(body: SendBody, user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.send_message(_session(user), body.to_phone.strip(), body.message.strip())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc
