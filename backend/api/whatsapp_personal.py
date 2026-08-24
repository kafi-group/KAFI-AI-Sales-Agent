"""Personal WhatsApp (Baileys bridge) — per-user QR sessions & 2-way sync."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from config import settings
from db.models import AppUser, Channel, Direction, HandledBy, Interaction, InteractionStatus
from integrations import whatsapp_bridge_client as bridge
from modules.comms_generator import get_comms

router = APIRouter(prefix="/whatsapp-personal", tags=["whatsapp-personal"])
comms = get_comms()


class WhatsAppPersonalSendRequest(BaseModel):
    to_phone: str = Field(min_length=6, max_length=32)
    message: str = Field(min_length=1, max_length=4096)


class WhatsAppPersonalInboundRequest(BaseModel):
    session_id: str | None = None
    from_phone: str
    wa_id: str
    message: str
    provider_message_id: str | None = None
    profile_name: str | None = None


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


@router.post("/pair")
def whatsapp_personal_pair(user: AppUser = Depends(get_current_user)) -> Any:
    """Reset session and return a fresh QR code for scanning."""
    try:
        bridge.bridge_disconnect(user.id)
        return bridge.bridge_qr(user.id)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not start WhatsApp pairing: {exc}") from exc


@router.post("/disconnect")
def whatsapp_personal_disconnect(user: AppUser = Depends(get_current_user)) -> Any:
    try:
        return bridge.bridge_disconnect(user.id)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not disconnect WhatsApp bridge: {exc}") from exc


@router.post("/send")
def whatsapp_personal_send(
    body: WhatsAppPersonalSendRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    try:
        status = bridge.bridge_status(user.id)
        if not status.get("connected"):
            raise HTTPException(
                409,
                "Personal WhatsApp is not connected. Open WhatsApp QR and scan with your phone.",
            )
        res = bridge.bridge_send(user.id, to_phone=body.to_phone, message=body.message)

        # Log outbound Interaction to DB so it shows up in Inbox & Activity
        try:
            contact = comms._ensure_whatsapp_contact(db, wa_id=body.to_phone)
            outbound = Interaction(
                contact_id=contact.id,
                channel=Channel.whatsapp,
                direction=Direction.outbound,
                content=body.message,
                status=InteractionStatus.sent,
                handled_by=HandledBy.human,
                provider_message_id=res.get("messageId") if isinstance(res, dict) else None,
            )
            db.add(outbound)
            db.commit()

            from modules import activity as activity_module

            activity_module.log_activity(
                db,
                user_id=user.id,
                activity_type=activity_module.PERSONAL_WHATSAPP_SENT,
                title="Personal WhatsApp sent",
                summary=f"Sent WhatsApp Mobile message to {body.to_phone}",
                quantity=1,
                entity_type="interaction",
                entity_id=outbound.id,
                details={"mode": "personal_mobile", "channel": "whatsapp", "to_phone": body.to_phone},
            )
        except Exception:  # noqa: BLE001
            pass

        return res
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Personal WhatsApp send failed: {exc}") from exc


@router.post("/inbound")
def whatsapp_personal_inbound(
    body: WhatsAppPersonalInboundRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    """Inbound webhook received from Baileys WhatsApp Mobile bridge."""
    secret = (settings.whatsapp_bridge_secret or "").strip()
    if secret:
        provided = request.headers.get("x-bridge-secret")
        if provided != secret:
            raise HTTPException(401, "Invalid bridge secret")

    wa_id = body.wa_id or body.from_phone
    if not wa_id or not body.message:
        raise HTTPException(400, "Missing wa_id or message")

    interaction = comms.record_inbound_whatsapp_message(
        db,
        wa_id=wa_id,
        message_text=body.message,
        provider_message_id=body.provider_message_id,
        profile_name=body.profile_name,
        create_reply_draft=False,
    )

    if interaction is not None:
        try:
            from db.models import Contact
            from modules import ai_mode as ai_mode_module

            contact = db.get(Contact, interaction.contact_id)
            if contact:
                ai_mode_module.maybe_auto_reply_whatsapp(
                    db,
                    contact=contact,
                    message_text=body.message,
                    provider_message_id=body.provider_message_id,
                )
        except Exception:  # noqa: BLE001
            pass

    return {"status": "ok"}

