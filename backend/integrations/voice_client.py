"""Twilio Programmable Voice — browser calling from the sales dashboard."""

from __future__ import annotations

import re
from typing import Any

from config import settings


def normalize_e164(phone: str | None) -> str | None:
    """Normalize a phone string to E.164 (+country + number).

    Handles common Pakistan local mobiles (03XXXXXXXXX / 3XXXXXXXXX → +923…).
    """
    if not phone:
        return None
    raw = phone.strip()
    if not raw or raw.lower() in {"not found", "n/a", "na", "none", "-"}:
        return None

    cleaned = re.sub(r"[^\d+]", "", raw)
    if cleaned.startswith("00"):
        cleaned = f"+{cleaned[2:]}"

    # Digits only (no leading +) for regional heuristics.
    bare = cleaned[1:] if cleaned.startswith("+") else cleaned

    # Pakistan mobile: national 03XXXXXXXXX (11) or 3XXXXXXXXX (10) → +923…
    if not cleaned.startswith("+"):
        if re.fullmatch(r"03\d{9}", bare):
            cleaned = f"+92{bare[1:]}"
        elif re.fullmatch(r"3\d{9}", bare):
            cleaned = f"+92{bare}"
        elif re.fullmatch(r"92\d{10}", bare):
            cleaned = f"+{bare}"
        else:
            cleaned = f"+{bare}"
    elif cleaned.startswith("+0") and re.fullmatch(r"\+03\d{9}", cleaned):
        # Accidental +0307… from naive prefixing
        cleaned = f"+92{cleaned[2:]}"

    if re.fullmatch(r"\+\d{8,15}", cleaned):
        return cleaned
    return None


def mask_phone(phone: str | None) -> str | None:
    """Mask a phone number for display (e.g. +971****4567)."""
    normalized = normalize_e164(phone)
    if not normalized or len(normalized) < 8:
        return None
    return f"{normalized[:4]}****{normalized[-4:]}"


class VoiceClient:
    @property
    def is_configured(self) -> bool:
        return bool(
            settings.twilio_account_sid
            and settings.twilio_auth_token
            and settings.twilio_phone_number
        )

    @property
    def webhooks_ready(self) -> bool:
        return self.is_configured and bool(settings.twilio_webhook_base_url)

    @property
    def browser_ready(self) -> bool:
        return bool(
            self.webhooks_ready
            and settings.twilio_api_key_sid
            and settings.twilio_api_key_secret
            and settings.twilio_twiml_app_sid
        )

    def webhook_url(self, path: str) -> str:
        base = (settings.twilio_webhook_base_url or "").rstrip("/")
        if not base:
            raise RuntimeError(
                "TWILIO_WEBHOOK_BASE_URL is not set — Twilio needs a public HTTPS URL "
                "(use ngrok for local dev, or your Railway/production API URL)."
            )
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{base}{path}"

    def validate_webhook(
        self,
        url: str,
        params: dict[str, str],
        signature: str,
        *,
        alternate_urls: list[str] | None = None,
    ) -> bool:
        if not settings.twilio_validate_webhooks:
            return True
        if not settings.twilio_auth_token or not signature:
            return False
        from twilio.request_validator import RequestValidator

        validator = RequestValidator(settings.twilio_auth_token.strip())
        candidates: list[str] = []
        for candidate in [url, *(alternate_urls or [])]:
            raw = (candidate or "").strip()
            if not raw:
                continue
            # Twilio signs the exact URL it requested; proxies often differ by slash/scheme.
            for variant in (raw, raw.rstrip("/"), raw.replace("http://", "https://", 1)):
                if variant and variant not in candidates:
                    candidates.append(variant)

        for candidate in candidates:
            try:
                if validator.validate(candidate, params, signature):
                    return True
            except Exception:
                continue
        return False

    def create_access_token(self, *, identity: str = "sales-agent") -> str:
        if not self.browser_ready:
            raise RuntimeError(
                "Browser calling is not configured. Set TWILIO_API_KEY_SID, "
                "TWILIO_API_KEY_SECRET, and TWILIO_TWIML_APP_SID in backend/.env"
            )
        from twilio.jwt.access_token import AccessToken
        from twilio.jwt.access_token.grants import VoiceGrant

        token = AccessToken(
            settings.twilio_account_sid,
            settings.twilio_api_key_sid,
            settings.twilio_api_key_secret,
            identity=identity,
            ttl=3600,
        )
        grant = VoiceGrant(
            outgoing_application_sid=settings.twilio_twiml_app_sid,
            incoming_allow=False,
        )
        token.add_grant(grant)
        jwt = token.to_jwt()
        return jwt.decode("utf-8") if isinstance(jwt, bytes) else str(jwt)

    def say_twiml(self, message: str) -> str:
        """Safe spoken TwiML (never let Twilio fall back to 'application error')."""
        import html

        text = html.escape((message or "Call could not be completed.").strip()[:500])
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f"<Response><Say voice=\"alice\">{text}</Say><Hangup/></Response>"
        )

    def client_dial_twiml(self, lead_phone: str, interaction_id: int) -> str:
        """TwiML for browser-initiated outbound calls — dials the lead directly."""
        import html

        lead = normalize_e164(lead_phone)
        if not lead:
            return self.say_twiml(
                "The phone number is invalid. Please check the lead number and try again."
            )
        caller_id = normalize_e164(settings.twilio_phone_number) or (
            settings.twilio_phone_number or ""
        ).strip()
        if not caller_id.startswith("+"):
            return self.say_twiml(
                "Caller ID is not configured. Set TWILIO_PHONE_NUMBER on the server."
            )

        # Status/recording callbacks need a public base URL. If missing, still Dial
        # so the call can ring — omit callbacks rather than crashing TwiML fetch.
        status_url = ""
        recording_url = ""
        if settings.twilio_webhook_base_url:
            status_url = self.webhook_url(
                f"/api/webhooks/twilio/voice/status?interaction_id={interaction_id}"
            )
            recording_url = self.webhook_url(
                f"/api/webhooks/twilio/voice/recording?interaction_id={interaction_id}"
            )

        lead_xml = html.escape(lead, quote=True)
        caller_xml = html.escape(caller_id, quote=True)
        # timeout lets unanswered calls end cleanly (voicemail / no-answer) instead
        # of hanging the browser leg with a gateway error.
        dial_attrs = [
            f'callerId="{caller_xml}"',
            'answerOnBridge="true"',
            'timeout="45"',
            'record="record-from-answer"',
        ]
        if recording_url:
            recording_xml = html.escape(recording_url, quote=True)
            dial_attrs.extend(
                [
                    f'recordingStatusCallback="{recording_xml}"',
                    'recordingStatusCallbackMethod="POST"',
                    'recordingStatusCallbackEvent="completed"',
                ]
            )
        if status_url:
            status_xml = html.escape(status_url, quote=True)
            dial_attrs.extend([f'action="{status_xml}"', 'method="POST"'])

        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Dial {" ".join(dial_attrs)}>'
            f"<Number>{lead_xml}</Number>"
            "</Dial>"
            "</Response>"
        )

    def fetch_account_balance(self) -> dict[str, Any]:
        """Live Twilio prepaid balance (admin diagnostics)."""
        if not settings.twilio_account_sid or not settings.twilio_auth_token:
            return {
                "ok": False,
                "message": "Twilio is not configured on the server.",
            }
        try:
            from twilio.rest import Client

            client = Client(
                settings.twilio_account_sid.strip(),
                settings.twilio_auth_token.strip(),
            )
            record = client.api.v2010.accounts(settings.twilio_account_sid.strip()).balance.fetch()
            balance_raw = getattr(record, "balance", None)
            currency = (getattr(record, "currency", None) or "USD").upper()
            try:
                balance = float(balance_raw)
            except (TypeError, ValueError):
                return {
                    "ok": False,
                    "message": f"Unexpected balance value from Twilio: {balance_raw!r}",
                }
            return {
                "ok": True,
                "balance": balance,
                "currency": currency,
                "account_status": "active",
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "message": f"Could not fetch Twilio balance: {exc}",
            }

    def setup_hints(self) -> dict[str, Any]:
        missing: list[str] = []
        if not settings.twilio_account_sid:
            missing.append("TWILIO_ACCOUNT_SID")
        if not settings.twilio_auth_token:
            missing.append("TWILIO_AUTH_TOKEN")
        if not settings.twilio_phone_number:
            missing.append("TWILIO_PHONE_NUMBER")
        if not settings.twilio_webhook_base_url:
            missing.append("TWILIO_WEBHOOK_BASE_URL")
        if not settings.twilio_api_key_sid:
            missing.append("TWILIO_API_KEY_SID")
        if not settings.twilio_api_key_secret:
            missing.append("TWILIO_API_KEY_SECRET")
        if not settings.twilio_twiml_app_sid:
            missing.append("TWILIO_TWIML_APP_SID")
        return {"missing": missing, "browser_ready": self.browser_ready}


    def place_outbound_ai_call(self, to_phone: str, text_message: str | None = None) -> dict[str, Any]:
        """Initiate an outbound PSTN call via Twilio REST API."""
        if not self.is_configured:
            return {"ok": False, "error": "Twilio is not configured on the server. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER."}
        
        normalized = normalize_e164(to_phone)
        if not normalized:
            return {"ok": False, "error": f"Invalid destination phone number: '{to_phone}'. Must be in E.164 format (e.g. +923142867152)."}
        
        try:
            from twilio.rest import Client

            client = Client(
                settings.twilio_account_sid.strip(),
                settings.twilio_auth_token.strip(),
            )

            msg = text_message or "Hello, this is Sara calling on behalf of Mr. Khalid from Kafi Commodities. Thank you for connecting."
            twiml_content = self.say_twiml(msg)

            call = client.calls.create(
                to=normalized,
                from_=settings.twilio_phone_number.strip(),
                twiml=twiml_content,
            )
            return {"ok": True, "call_sid": call.sid, "status": call.status}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


voice_client = VoiceClient()
