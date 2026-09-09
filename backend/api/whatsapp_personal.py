"""Personal WhatsApp (Baileys bridge) — per-user QR sessions & 2-way sync."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import func as sa_func

from api.deps import get_current_user, get_db
from api.schemas import (
    InteractionRead,
    WhatsAppConversationListResponse,
    WhatsAppConversationRead,
)
from config import settings
from db.models import AppUser, Buyer, Channel, Direction, HandledBy, Interaction, InteractionStatus
from integrations import whatsapp_bridge_client as bridge
from modules.comms_generator import get_comms

router = APIRouter(prefix="/whatsapp-personal", tags=["whatsapp-personal"])
comms = get_comms()


class WhatsAppPersonalSendRequest(BaseModel):
    to_phone: str = Field(min_length=6, max_length=32)
    message: str = Field(min_length=1, max_length=4096)


class WhatsAppPersonalBulkSendRequest(BaseModel):
    buyer_ids: list[int] = Field(default_factory=list)
    phones: list[str] = Field(default_factory=list)
    message: str = Field(min_length=1, max_length=4096)


class WhatsAppPersonalInboundRequest(BaseModel):
    session_id: str | None = None
    from_phone: str
    wa_id: str
    message: str
    provider_message_id: str | None = None
    profile_name: str | None = None


class WhatsAppPersonalReplyRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4096)


def _user_id_from_bridge_session(db: Session, session_id: str | None) -> int | None:
    raw = (session_id or "").strip()
    if not raw:
        return None
    prefix = (settings.whatsapp_bridge_session_prefix or "kafi-sales-agent").strip()
    name = raw
    lowered = raw.lower()
    prefix_l = prefix.lower()
    if lowered.startswith(f"{prefix_l}-"):
        name = raw[len(prefix) + 1 :]
    if name.lower().startswith("u") and name[1:].isdigit():
        return int(name[1:])
    user = (
        db.query(AppUser)
        .filter(sa_func.lower(AppUser.username) == name.lower())
        .first()
    )
    return int(user.id) if user else None


def _interaction_read(db: Session, interaction) -> InteractionRead:
    return InteractionRead(**comms.interaction_to_dict(db, interaction))


@router.get("/status")
def whatsapp_personal_status(user: AppUser = Depends(get_current_user)) -> Any:
    try:
        return bridge.bridge_status(user.id, username=user.username)
    except Exception:  # noqa: BLE001
        return {
            "connected": False,
            "status": "disconnected",
            "session": bridge.bridge_session_id(user.id, username=user.username),
        }


@router.get("/qr")
def whatsapp_personal_qr(user: AppUser = Depends(get_current_user)) -> Any:
    try:
        return bridge.bridge_qr(user.id, username=user.username)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not load QR from bridge: {exc}") from exc


@router.get("/session")
def whatsapp_personal_session(user: AppUser = Depends(get_current_user)) -> dict[str, str]:
    return {"session_id": bridge.bridge_session_id(user.id, username=user.username)}


@router.get("/conversations", response_model=WhatsAppConversationListResponse)
def list_personal_conversations(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> WhatsAppConversationListResponse:
    try:
        rows, total = comms.list_whatsapp_conversations(
            db,
            page=page,
            page_size=page_size,
            personal_user_id=user.id,
        )
    except Exception:  # noqa: BLE001
        rows, total = [], 0
    total_pages = max(1, (total + page_size - 1) // page_size)
    return WhatsAppConversationListResponse(
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
        rows=[WhatsAppConversationRead(**row) for row in rows],
    )


@router.get("/conversations/{contact_id}/messages", response_model=list[InteractionRead])
def list_personal_conversation_messages(
    contact_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> list[InteractionRead]:
    try:
        rows = comms.list_whatsapp_messages(
            db, contact_id=contact_id, personal_user_id=user.id
        )
    except Exception:  # noqa: BLE001
        rows = []
    return [_interaction_read(db, row) for row in rows]


@router.post("/conversations/{contact_id}/reply")
def reply_personal_conversation(
    contact_id: int,
    payload: WhatsAppPersonalReplyRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    from db.models import Contact

    status = bridge.bridge_status(user.id, username=user.username)
    if not status.get("connected"):
        raise HTTPException(
            409,
            "Personal WhatsApp is not connected. Open Scan & connect and scan QR.",
        )
    contact = db.get(Contact, contact_id)
    if not contact:
        raise HTTPException(404, "Contact not found")
    phone = (contact.phone or contact.wa_id or "").strip()
    if not phone:
        raise HTTPException(400, "Contact has no phone number on file")
    res = bridge.bridge_send(user.id, to_phone=phone, message=payload.content, username=user.username)
    outbound = Interaction(
        contact_id=contact.id,
        channel=Channel.whatsapp,
        direction=Direction.outbound,
        content=payload.content,
        status=InteractionStatus.sent,
        handled_by=HandledBy.human,
        provider_message_id=(
            f"baileys_{res.get('messageId')}"
            if isinstance(res, dict) and res.get("messageId")
            else "baileys_mobile"
        ),
        personal_whatsapp_user_id=user.id,
    )
    db.add(outbound)
    db.commit()
    db.refresh(outbound)
    try:
        from modules import activity as activity_module

        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.PERSONAL_WHATSAPP_SENT,
            title="Personal WhatsApp sent",
            summary=f"Replied on WhatsApp Mobile to {phone}",
            quantity=1,
            entity_type="interaction",
            entity_id=outbound.id,
            details={"mode": "personal_mobile", "channel": "whatsapp", "to_phone": phone},
        )
    except Exception:  # noqa: BLE001
        pass
    return {
        "interaction": _interaction_read(db, outbound).model_dump(mode="json"),
        "sent": True,
    }


@router.post("/pair")
def whatsapp_personal_pair(user: AppUser = Depends(get_current_user)) -> Any:
    """Reset session and return a fresh QR code for scanning.

    The dedicated Baileys bridge waits internally for the first QR (up to 10 s).
    We still retry briefly in case the container is cold-starting.
    """
    try:
        last_result: dict = {}
        deadline = time.monotonic() + 12.0
        last_result = bridge.bridge_pair(user.id, username=user.username)
        if last_result.get("qr") or last_result.get("qrDataUrl") or last_result.get("connected"):
            return last_result
        while time.monotonic() < deadline:
            time.sleep(0.8)
            last_result = bridge.bridge_qr(user.id, username=user.username)
            if last_result.get("qr") or last_result.get("qrDataUrl") or last_result.get("connected"):
                return last_result
        return last_result
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not start WhatsApp pairing: {exc}") from exc


@router.post("/disconnect")
def whatsapp_personal_disconnect(user: AppUser = Depends(get_current_user)) -> Any:
    """Disconnect the current user's personal WhatsApp Mobile session only."""
    try:
        return bridge.bridge_disconnect(user.id, username=user.username)
    except Exception:  # noqa: BLE001
        return {
            "ok": True,
            "connected": False,
            "status": "disconnected",
            "session": bridge.bridge_session_id(user.id, username=user.username),
        }


@router.get("/team-status")
def whatsapp_personal_team_status(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Return mobile WhatsApp status for the team without blocking other API work."""
    snapshots = [
        (u.id, u.username, u.full_name, u.role)
        for u in db.query(AppUser).filter(AppUser.is_active == True).all()  # noqa: E712
    ]
    current_id = user.id

    def _fetch(snap: tuple[int, str | None, str | None, Any]) -> dict[str, Any]:
        uid, uname, fname, role = snap
        try:
            st = bridge.bridge_status(uid, username=uname)
        except Exception:  # noqa: BLE001
            st = {"connected": False, "status": "disconnected", "phone": None}
        raw_st = str(st.get("status") or "").lower()
        is_conn = bool(st.get("connected")) and raw_st in {"connected", "open", "ready"}
        phone_val = (st.get("phone") or st.get("connectedPhone")) if is_conn else None
        return {
            "user_id": uid,
            "username": uname,
            "full_name": fname or uname,
            "role": role,
            "session_id": bridge.bridge_session_id(uid, username=uname),
            "connected": is_conn,
            "phone": phone_val,
            "profile_picture_url": (
                st.get("profilePictureUrl") or st.get("profile_picture_url") if is_conn else None
            ),
            "status": "connected" if is_conn else (raw_st if raw_st else "disconnected"),
            "is_current_user": uid == current_id,
        }

    if not snapshots:
        return []
    workers = min(6, len(snapshots))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(_fetch, snapshots))


@router.post("/disconnect-user/{target_user_id}")
def whatsapp_personal_disconnect_target_user(
    target_user_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    """Disconnect specific user's WhatsApp session. Only Admin can disconnect other users."""
    if user.id != target_user_id and str(user.role).lower() != "admin":
        raise HTTPException(403, "Only Admin can disconnect another user's WhatsApp session.")
    target_user = db.get(AppUser, target_user_id)
    target_username = target_user.username if target_user else None
    try:
        return bridge.bridge_disconnect(target_user_id, username=target_username)
    except Exception:  # noqa: BLE001
        return {
            "ok": True,
            "connected": False,
            "status": "disconnected",
            "session": bridge.bridge_session_id(target_user_id, username=target_username),
        }


@router.post("/send")
def whatsapp_personal_send(
    body: WhatsAppPersonalSendRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    try:
        status = bridge.bridge_status(user.id, username=user.username)
        if not status.get("connected"):
            raise HTTPException(
                409,
                "Personal WhatsApp is not connected. Open WhatsApp QR and scan with your phone.",
            )
        res = bridge.bridge_send(user.id, to_phone=body.to_phone, message=body.message, username=user.username)

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
                provider_message_id=f"baileys_{res.get('messageId')}" if isinstance(res, dict) and res.get("messageId") else "baileys_mobile",
                personal_whatsapp_user_id=user.id,
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


@router.post("/bulk-send")
def whatsapp_personal_bulk_send(
    body: WhatsAppPersonalBulkSendRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    """Send personal WhatsApp message to multiple selected leads/buyers via Baileys QR."""
    import time
    from modules import buyers as buyers_module
    from modules import activity as activity_module

    try:
        status = bridge.bridge_status(user.id, username=user.username)
        if not status.get("connected"):
            raise HTTPException(
                409,
                "Personal WhatsApp is not connected. Open WhatsApp QR and scan with your phone.",
            )

        targets: list[dict[str, Any]] = []
        for bid in body.buyer_ids:
            b = db.get(Buyer, bid)
            if not b:
                continue
            c = buyers_module.primary_contact_with_phone(db, bid)
            phone = (c.phone or c.wa_id) if c else None
            if phone:
                targets.append({
                    "buyer_id": bid,
                    "company_name": b.company_name,
                    "contact_name": c.full_name if c else None,
                    "phone": phone.strip(),
                })

        for ph in body.phones:
            cleaned = ph.strip()
            if cleaned and not any(t["phone"] == cleaned for t in targets):
                targets.append({
                    "buyer_id": None,
                    "company_name": "Lead",
                    "contact_name": None,
                    "phone": cleaned,
                })

        if not targets:
            raise HTTPException(400, "No valid phone numbers found for the selected leads.")

        sent_count = 0
        failed_count = 0
        results: list[dict[str, Any]] = []

        for idx, t in enumerate(targets):
            if idx > 0:
                time.sleep(1.2)  # spacing to prevent flood/rate limits
            phone = t["phone"]
            try:
                msg_text = body.message
                if t.get("contact_name"):
                    msg_text = msg_text.replace("{{name}}", t["contact_name"]).replace("{{contact_name}}", t["contact_name"])
                else:
                    msg_text = msg_text.replace("{{name}}", "Sir/Madam").replace("{{contact_name}}", "Sir/Madam")
                if t.get("company_name"):
                    msg_text = msg_text.replace("{{company}}", t["company_name"]).replace("{{company_name}}", t["company_name"])

                res = bridge.bridge_send(user.id, to_phone=phone, message=msg_text, username=user.username)
                sent_count += 1
                results.append({"phone": phone, "status": "sent", "company": t.get("company_name")})

                try:
                    contact = comms._ensure_whatsapp_contact(db, wa_id=phone)
                    outbound = Interaction(
                        contact_id=contact.id,
                        channel=Channel.whatsapp,
                        direction=Direction.outbound,
                        content=msg_text,
                        status=InteractionStatus.sent,
                        handled_by=HandledBy.human,
                        provider_message_id=f"baileys_{res.get('messageId')}" if isinstance(res, dict) and res.get("messageId") else "baileys_bulk",
                        personal_whatsapp_user_id=user.id,
                    )
                    db.add(outbound)
                    db.commit()
                except Exception:
                    pass
            except Exception as exc:
                failed_count += 1
                results.append({"phone": phone, "status": "failed", "error": str(exc), "company": t.get("company_name")})

        if sent_count > 0:
            activity_module.log_activity(
                db,
                user_id=user.id,
                activity_type=activity_module.PERSONAL_WHATSAPP_SENT,
                title="Bulk Personal WhatsApp sent",
                summary=f"Sent {sent_count} WhatsApp message(s) via personal scanned QR",
                quantity=sent_count,
                details={"mode": "personal_bulk", "channel": "whatsapp", "sent_count": sent_count, "failed_count": failed_count},
            )

        return {
            "sent_count": sent_count,
            "failed_count": failed_count,
            "skipped_count": 0,
            "results": results,
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Bulk Personal WhatsApp send failed: {exc}") from exc


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

    pmid = (body.provider_message_id or "").strip() or None
    if pmid and not pmid.lower().startswith("baileys"):
        pmid = f"baileys_{pmid}"

    comms.record_inbound_whatsapp_message(
        db,
        wa_id=wa_id,
        message_text=body.message,
        provider_message_id=pmid,
        profile_name=body.profile_name,
        create_reply_draft=False,
        personal_whatsapp_user_id=_user_id_from_bridge_session(db, body.session_id),
    )
    return {"status": "ok"}

