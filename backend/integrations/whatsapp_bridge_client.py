"""HTTP client for Baileys WhatsApp bridge — isolated per Sales Agent user session."""

from __future__ import annotations

import base64
from typing import Any

import httpx

from config import settings


def bridge_session_id(user_id: int) -> str:
    """Namespace sessions so bank-recon-demo and Sales Agent never share QR sessions."""
    prefix = (settings.whatsapp_bridge_session_prefix or "kafi-sales-agent").strip()
    return f"{prefix}-u{int(user_id)}"


def _headers() -> dict[str, str]:
    secret = (settings.whatsapp_bridge_secret or "").strip()
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if secret:
        headers["x-bridge-secret"] = secret
    return headers


def _base_url() -> str:
    url = (settings.whatsapp_bridge_url or "").strip().rstrip("/")
    if not url:
        raise RuntimeError("WhatsApp bridge is not configured (WHATSAPP_BRIDGE_URL)")
    return url


def _extract_phone_number(data: dict[str, Any]) -> str | None:
    for key in ("phone", "connectedPhone", "number", "wa_number", "waNumber", "jid", "wid"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            raw = val.split("@")[0].split(":")[0].strip()
            digits = "".join(ch for ch in raw if ch.isdigit())
            if len(digits) >= 8:
                return f"+{digits}"
    user_obj = data.get("user") or data.get("me") or data.get("info")
    if isinstance(user_obj, dict):
        return _extract_phone_number(user_obj)
    return None


def _normalize_status(data: dict[str, Any]) -> dict[str, Any]:
    """Bridge uses status: connected | qr-pending | disconnected — normalize for UI."""
    if "connected" not in data:
        raw = str(data.get("status") or "").strip().lower()
        if raw in {"qr-pending", "disconnected", "close", "closed", "logged_out"}:
            data["connected"] = False
        else:
            data["connected"] = raw in {"connected", "open", "ready"}
    phone = _extract_phone_number(data)
    if phone:
        data["phone"] = phone
        data["connectedPhone"] = phone
    return data


def _png_qr_payload(session: str, content: bytes) -> dict[str, Any]:
    b64 = base64.b64encode(content).decode("ascii")
    return {
        "session": session,
        "connected": False,
        "status": "qr-pending",
        "qr": b64,
        "qrDataUrl": f"data:image/png;base64,{b64}",
    }


def _response_is_png(resp: httpx.Response) -> bool:
    content_type = (resp.headers.get("content-type") or "").lower()
    if "image/" in content_type:
        return True
    body = resp.content or b""
    return len(body) >= 4 and body[:4] == b"\x89PNG"


def bridge_status(user_id: int) -> dict[str, Any]:
    session = bridge_session_id(user_id)
    with httpx.Client(timeout=20.0) as client:
        resp = client.get(
            f"{_base_url()}/status",
            params={"session": session},
            headers=_headers(),
        )
        if resp.status_code == 401:
            return {"connected": False, "session": session, "error": "Bridge unauthorized"}
        resp.raise_for_status()
        data = resp.json() if resp.content else {}
        if not isinstance(data, dict):
            data = {}
        data.setdefault("session", session)
        return _normalize_status(data)


def bridge_qr(user_id: int) -> dict[str, Any]:
    session = bridge_session_id(user_id)
    with httpx.Client(timeout=30.0) as client:
        resp = client.get(
            f"{_base_url()}/qr",
            params={"session": session},
            headers=_headers(),
        )
        if resp.status_code == 404:
            body: dict[str, Any] = {}
            try:
                parsed = resp.json()
                if isinstance(parsed, dict):
                    body = parsed
            except Exception:  # noqa: BLE001
                pass
            body.setdefault("session", session)
            err = str(body.get("error") or "").lower()
            if "connected" in err or body.get("status") == "connected":
                return _normalize_status({**body, "status": "connected", "qr": None})
            return {**body, "session": session, "connected": False, "qr": None}
        resp.raise_for_status()
        if _response_is_png(resp):
            return _png_qr_payload(session, resp.content)
        try:
            data = resp.json()
        except Exception:  # noqa: BLE001
            if resp.content:
                return _png_qr_payload(session, resp.content)
            return {"session": session, "connected": False, "qr": None}
        if isinstance(data, dict):
            data.setdefault("session", session)
            qr_val = data.get("qr") or data.get("qrDataUrl") or data.get("dataUrl")
            if isinstance(qr_val, str) and qr_val and not str(qr_val).startswith("data:"):
                if qr_val.startswith("iVBOR") or qr_val.startswith("/9j"):
                    data["qrDataUrl"] = f"data:image/png;base64,{qr_val}"
            return _normalize_status(data)
        return {"session": session, "connected": False, "qr": None}


def bridge_disconnect(user_id: int) -> dict[str, Any]:
    session = bridge_session_id(user_id)
    try:
        with httpx.Client(timeout=20.0) as client:
            client.post(
                f"{_base_url()}/disconnect",
                json={"session": session, "sessionId": session},
                headers=_headers(),
            )
            try:
                client.post(
                    f"{_base_url()}/logout",
                    json={"session": session, "sessionId": session},
                    headers=_headers(),
                )
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "session": session, "connected": False, "status": "disconnected"}


def bridge_send(user_id: int, *, to_phone: str, message: str) -> dict[str, Any]:
    session = bridge_session_id(user_id)
    phone = (to_phone or "").strip()
    text = (message or "").strip()
    if not phone:
        raise ValueError("Recipient phone is required")
    if not text:
        raise ValueError("Message body is required")
    payload = {
        "session": session,
        "sessionId": session,
        "to": phone,
        "phone": phone,
        "message": text,
        "text": text,
    }
    with httpx.Client(timeout=45.0) as client:
        resp = client.post(
            f"{_base_url()}/send",
            json=payload,
            headers=_headers(),
        )
        if resp.status_code >= 400:
            detail = resp.text[:300]
            raise RuntimeError(detail or f"Bridge send failed ({resp.status_code})")
        return resp.json() if resp.content else {"status": "sent"}
