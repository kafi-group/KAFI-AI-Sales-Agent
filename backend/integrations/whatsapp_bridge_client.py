"""HTTP client for Baileys WhatsApp bridge — isolated per Sales Agent user session."""

from __future__ import annotations

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


def _normalize_status(data: dict[str, Any]) -> dict[str, Any]:
    """Bridge returns {status: 'connected'} — normalize to {connected: bool} for the UI."""
    if "connected" not in data:
        raw = str(data.get("status") or "").strip().lower()
        data["connected"] = raw in {"connected", "open", "ready"}
    return data


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
        data = resp.json() if resp.content else {}
        if isinstance(data, dict):
            data.setdefault("session", session)
            return _normalize_status(data)
        return {"session": session, "connected": False, "qr": None}


def bridge_disconnect(user_id: int) -> dict[str, Any]:
    session = bridge_session_id(user_id)
    with httpx.Client(timeout=20.0) as client:
        resp = client.post(
            f"{_base_url()}/disconnect",
            json={"session": session, "sessionId": session},
            headers=_headers(),
        )
        resp.raise_for_status()
        data = resp.json() if resp.content else {"ok": True}
        if isinstance(data, dict):
            data.setdefault("session", session)
            data["connected"] = False
        return data if isinstance(data, dict) else {"ok": True, "session": session, "connected": False}


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
