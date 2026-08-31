"""WhatsApp Cloud API client (Meta Graph API) — text/template sends + webhook verification.

Setup reference: developers.facebook.com/docs/whatsapp/cloud-api. Requires:
  WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN (see backend/.env.example).
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any

import httpx

from config import settings
from integrations.voice_client import normalize_e164


class WhatsAppClient:
    @property
    def is_configured(self) -> bool:
        return bool(settings.whatsapp_access_token and settings.whatsapp_phone_number_id)

    @property
    def webhook_configured(self) -> bool:
        return bool(settings.whatsapp_webhook_verify_token)

    def _base_url(self) -> str:
        version = settings.whatsapp_api_version or "v21.0"
        return f"https://graph.facebook.com/{version}"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {settings.whatsapp_access_token}",
            "Content-Type": "application/json",
        }

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url()}/{path}"
        try:
            response = httpx.post(url, headers=self._headers(), json=payload, timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"WhatsApp request failed: {exc}"}

        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = {}

        if response.status_code == 200:
            messages = body.get("messages") or []
            message_id = messages[0].get("id") if messages else None
            return {
                "status": "sent",
                "message": "Message accepted by WhatsApp Cloud API",
                "provider_message_id": message_id,
                "raw": body,
            }

        detail = ((body.get("error") or {}).get("message")) or response.text
        return {
            "status": "error",
            "message": f"WhatsApp API {response.status_code}: {detail}",
            "raw": body,
        }

    def send_text(self, *, phone: str, message: str) -> dict[str, Any]:
        """Free-form text — only deliverable within the 24h customer service window."""
        if not self.is_configured:
            return {
                "status": "not_configured",
                "message": "WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN "
                "and WHATSAPP_PHONE_NUMBER_ID in backend/.env",
            }
        to = normalize_e164(phone)
        if not to:
            return {"status": "error", "message": f"Invalid WhatsApp number: {phone!r}"}

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to.lstrip("+"),
            "type": "text",
            "text": {"body": message, "preview_url": False},
        }
        return self._post(f"{settings.whatsapp_phone_number_id}/messages", payload)

    def send_template(
        self,
        *,
        phone: str,
        template_name: str,
        language: str = "en_US",
        components: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Approved template message — required outside the 24h session window, or for any
        business-initiated bulk/marketing send."""
        if not self.is_configured:
            return {
                "status": "not_configured",
                "message": "WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN "
                "and WHATSAPP_PHONE_NUMBER_ID in backend/.env",
            }
        to = normalize_e164(phone)
        if not to:
            return {"status": "error", "message": f"Invalid WhatsApp number: {phone!r}"}

        template: dict[str, Any] = {
            "name": template_name,
            "language": {"code": language},
        }
        if components:
            template["components"] = components

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to.lstrip("+"),
            "type": "template",
            "template": template,
        }
        return self._post(f"{settings.whatsapp_phone_number_id}/messages", payload)

    def create_message_template(
        self,
        *,
        name: str,
        language: str,
        category: str,
        components: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Submit a new message template to Meta for review (returns PENDING until approved)."""
        if not settings.whatsapp_access_token or not settings.whatsapp_business_account_id:
            return {
                "status": "not_configured",
                "message": "Set WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN "
                "in backend/.env to submit templates.",
            }
        payload = {
            "name": name,
            "language": language,
            "category": (category or "UTILITY").upper(),
            "components": components,
        }
        path = f"{settings.whatsapp_business_account_id}/message_templates"
        url = f"{self._base_url()}/{path}"
        try:
            response = httpx.post(url, headers=self._headers(), json=payload, timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"WhatsApp template submit failed: {exc}"}

        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = {}

        if response.status_code in {200, 201}:
            return {
                "status": "submitted",
                "message": "Template submitted to Meta for review",
                "meta_template_id": str(body.get("id") or ""),
                "meta_status": (body.get("status") or "PENDING"),
                "raw": body,
            }

        detail = ((body.get("error") or {}).get("message")) or response.text
        friendly = _friendly_whatsapp_api_error(response.status_code, detail, body)
        return {
            "status": "error",
            "message": friendly,
            "raw": body,
        }

    def verify_api_access(self) -> dict[str, Any]:
        """Lightweight check that the Meta token and WABA ID are valid."""
        result = self.list_templates()
        if result.get("status") == "ok":
            count = len(result.get("templates") or [])
            return {
                "ok": True,
                "message": f"Connected to Meta ({count} template(s) visible).",
            }
        return {
            "ok": False,
            "message": result.get("message") or "Could not reach Meta WhatsApp API.",
        }

    def send_approved(
        self,
        *,
        phone: str,
        message: str,
        template_name: str | None = None,
        template_language: str = "en_US",
        template_components: list[dict[str, Any]] | None = None,
        within_session_window: bool = False,
    ) -> dict[str, Any]:
        """Dispatch for an approved draft — free text if inside the session window and no
        template was specified, otherwise an approved template is required."""
        if template_name:
            return self.send_template(
                phone=phone,
                template_name=template_name,
                language=template_language,
                components=template_components,
            )
        if within_session_window:
            return self.send_text(phone=phone, message=message)
        return {
            "status": "error",
            "message": (
                "Outside the 24h customer-service window — select an approved template "
                "to send this WhatsApp message."
            ),
        }

    def mark_read(self, message_id: str) -> dict[str, Any]:
        if not self.is_configured or not message_id:
            return {"status": "skipped"}
        payload = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id,
        }
        return self._post(f"{settings.whatsapp_phone_number_id}/messages", payload)

    def list_templates(self) -> dict[str, Any]:
        """Pull message templates from the WABA (for syncing into whatsapp_templates)."""
        if not settings.whatsapp_access_token or not settings.whatsapp_business_account_id:
            return {
                "status": "not_configured",
                "message": "Set WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN "
                "in backend/.env to sync templates.",
                "templates": [],
            }
        url = (
            f"{self._base_url()}/{settings.whatsapp_business_account_id}/message_templates"
            "?fields=name,category,language,status,components&limit=200"
        )
        try:
            response = httpx.get(url, headers=self._headers(), timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"Template fetch failed: {exc}", "templates": []}

        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = {}

        if response.status_code != 200:
            detail = ((body.get("error") or {}).get("message")) or response.text
            return {
                "status": "error",
                "message": _friendly_whatsapp_api_error(response.status_code, detail, body),
                "templates": [],
            }

        return {"status": "ok", "templates": body.get("data") or []}

    def verify_webhook_signature(self, *, payload: bytes, signature_header: str | None) -> bool:
        """Validate X-Hub-Signature-256 using the Meta app secret."""
        if not settings.whatsapp_validate_webhooks:
            return True
        if not settings.whatsapp_app_secret:
            # No app secret configured — cannot verify; caller should treat as unverified.
            return False
        if not signature_header or not signature_header.startswith("sha256="):
            return False
        expected = hmac.new(
            settings.whatsapp_app_secret.encode("utf-8"), payload, hashlib.sha256
        ).hexdigest()
        provided = signature_header.split("=", 1)[1]
        return hmac.compare_digest(expected, provided)


whatsapp_client = WhatsAppClient()


def _friendly_whatsapp_api_error(
    status_code: int, detail: str, body: dict[str, Any] | None = None
) -> str:
    """Turn Meta Graph API errors into actionable dashboard messages."""
    text = (detail or "").strip()
    lower = text.lower()
    error_obj = (body or {}).get("error") or {}
    code = error_obj.get("code")

    if code in {131026, 131051} or "not a valid whatsapp user" in lower or "not on whatsapp" in lower or "undeliverable" in lower or "not registered" in lower:
        return f"Recipient number is not registered on WhatsApp. ({text})"
    if status_code == 401 or code == 190 or "expired" in lower or "session has expired" in lower:
        return (
            "Your WHATSAPP_ACCESS_TOKEN has expired. In Meta Business Settings → System users, "
            "generate a new permanent token with whatsapp_business_management, update "
            "backend/.env, then restart the backend."
        )
    if status_code == 403 or "permission" in lower:
        return (
            f"Meta rejected the request (permissions): {text or 'missing whatsapp_business_management scope'}"
        )
    if text:
        return f"WhatsApp API {status_code}: {text}"
    return f"WhatsApp API error {status_code}"
