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


LANGUAGE_CONFIGS: dict[str, dict[str, str]] = {
    "en": {
        "name": "English",
        "voice_female": "en-US-JennyNeural",
        "voice_male": "en-US-GuyNeural",
        "greeting": "Hello, am I speaking with {c_name}?",
        "instruction": "Conduct this conversation fluently and naturally in English.",
    },
    "ur": {
        "name": "Urdu",
        "voice_female": "ur-PK-UzmaNeural",
        "voice_male": "ur-PK-AsadNeural",
        "greeting": "سلام! کیا میری بات {c_name} سے ہو رہی ہے؟",
        "instruction": "Conduct this entire conversation fluently, politely, and naturally in Urdu (اردو).",
    },
    "fr": {
        "name": "French",
        "voice_female": "fr-FR-DeniseNeural",
        "voice_male": "fr-FR-HenriNeural",
        "greeting": "Bonjour, est-ce que je parle à {c_name} ?",
        "instruction": "Conduct this entire conversation fluently and naturally in French (Français).",
    },
    "ar": {
        "name": "Arabic",
        "voice_female": "ar-SA-ZariyahNeural",
        "voice_male": "ar-SA-HamedNeural",
        "greeting": "مرحباً، هل أتحدث مع {c_name}؟",
        "instruction": "Conduct this entire conversation fluently and naturally in formal B2B Arabic (العربية).",
    },
    "de": {
        "name": "German",
        "voice_female": "de-DE-KatjaNeural",
        "voice_male": "de-DE-ConradNeural",
        "greeting": "Hallo, spreche ich mit {c_name}?",
        "instruction": "Conduct this entire conversation fluently and naturally in German (Deutsch).",
    },
    "ru": {
        "name": "Russian",
        "voice_female": "ru-RU-SvetlanaNeural",
        "voice_male": "ru-RU-DmitryNeural",
        "greeting": "Здравствуйте, я говорю с {c_name}?",
        "instruction": "Conduct this entire conversation fluently and naturally in Russian (Русский).",
    },
    "zh": {
        "name": "Chinese",
        "voice_female": "zh-CN-XiaoxiaoNeural",
        "voice_male": "zh-CN-YunxiNeural",
        "greeting": "您好，请问是 {c_name} 先生/女士吗？",
        "instruction": "Conduct this entire conversation fluently and naturally in Mandarin Chinese (中文).",
    },
}


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


    def ai_gather_twiml(self, message: str, action_url: str, voice: str = "Polly.Joanna-Neural") -> str:
        """Build TwiML with <Gather input='speech'> for interactive voice conversation."""
        import html
        text = html.escape((message or "").strip()[:500])
        action_xml = html.escape(action_url, quote=True)
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Response>'
            f'<Gather input="speech" action="{action_xml}" method="POST" speechTimeout="auto" timeout="6">'
            f'<Say voice="{voice}">{text}</Say>'
            '</Gather>'
            f'<Say voice="{voice}">I did not catch a response. Thank you for your time with Kafi Commodities and have a great day!</Say>'
            '<Hangup/>'
            '</Response>'
        )

    def place_outbound_ai_call(
        self,
        to_phone: str,
        text_message: str | None = None,
        persona: str = "female",
        contact_name: str | None = None,
        language: str | None = "en",
    ) -> dict[str, Any]:
        """Initiate an outbound PSTN call via Vapi AI Voice Engine (or Twilio fallback)."""
        normalized = normalize_e164(to_phone)
        if not normalized:
            return {"ok": False, "error": f"Invalid destination phone number: '{to_phone}'. Must be in E.164 format (e.g. +923142867152)."}

        # Try Vapi Voice Engine first for sub-second conversational AI calling (if enabled)
        vapi_key = settings.vapi_api_key if getattr(settings, "vapi_enabled", True) else None
        vapi_phone_id = settings.vapi_phone_number_id

        lang_code = (language or "en").strip().lower()
        lang_cfg = LANGUAGE_CONFIGS.get(lang_code, LANGUAGE_CONFIGS["en"])

        if vapi_key:
            try:
                import json
                import urllib.request
                agent_name = "Sara" if persona == "female" else "Rayan"
                c_name = contact_name or "there"
                first_msg = text_message or lang_cfg["greeting"].format(c_name=c_name)

                eleven_key = getattr(settings, "elevenlabs_api_key", None)
                eleven_on = getattr(settings, "elevenlabs_enabled", False)
                if eleven_on and eleven_key and eleven_key.strip():
                    voice_config = {
                        "provider": "11labs",
                        "voiceId": "21m00Tcm4TlvDq8ikWAM" if persona == "female" else "ErXwobaYiN019PkySvjV",
                    }
                else:
                    voice_config = {
                        "provider": "azure",
                        "voiceId": lang_cfg["voice_female"] if persona == "female" else lang_cfg["voice_male"],
                    }

                try:
                    from modules.ai_agent_training import get_training_knowledge
                    t_data = get_training_knowledge(None)
                    insights_txt = t_data.get("learned_insights", "")
                    rules_txt = t_data.get("custom_rules", "")
                except Exception:
                    insights_txt, rules_txt = "", ""

                system_prompt = (
                    f"You are {agent_name}, a friendly, natural, and sharp B2B AI Sales Representative for Kafi Commodities. "
                    "Kafi Commodities is a leading global exporter of White Rice (Basmati 1121 & 5% Broken), Sesame Seeds (99% Purity), Yellow Corn, Spices, and Edible Oils.\n\n"
                    f"LANGUAGE INSTRUCTION:\n{lang_cfg['instruction']}\n\n"
                    "STRICT CONVERSATIONAL PROTOCOL & RULES:\n"
                    f"1. OPENING GREETING: You start the call by asking '{first_msg}'. Once the customer confirms, introduce {agent_name} from Kafi Commodities and offer our product catalogue and price list.\n"
                    "2. DO NOT REPEAT THE CUSTOMER'S NAME: You already asked for their name in the greeting. NEVER repeat their name in every sentence during the call.\n"
                    "3. DO NOT ASK FOR EMAIL OR PHONE NUMBER: We ALREADY have the customer's email and phone number in our system. NEVER ask the buyer to give you their email or phone number.\n"
                    "4. CATALOGUE & PRICE LIST DELIVERY: Tell the buyer: 'I am going to send our full product catalogue and CNF price list directly to your WhatsApp and email so you can go through it. Please take a look when you get a chance!'\n"
                    "5. SHORT SPOKEN RESPONSES: Speak concisely in 1 to 2 spoken sentences so the conversation feels natural over the phone.\n\n"
                    f"LEARNED SALES PLAYBOOK:\n{insights_txt}\n\n"
                    f"CUSTOM SALES RULES:\n{rules_txt}"
                )

                payload = {
                    "customer": {"number": normalized, "name": c_name},
                    "assistant": {
                        "name": agent_name,
                        "firstMessage": first_msg,
                        "model": {
                            "provider": "openai",
                            "model": "gpt-4o-mini",
                            "messages": [
                                {
                                    "role": "system",
                                    "content": system_prompt,
                                }
                            ],
                        },
                        "voice": voice_config,
                    },
                }

                if vapi_phone_id:
                    payload["phoneNumberId"] = vapi_phone_id

                data = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(
                    "https://api.vapi.ai/call",
                    data=data,
                    headers={
                        "Authorization": f"Bearer {vapi_key}",
                        "Content-Type": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    },
                )
                with urllib.request.urlopen(req, timeout=12) as res:
                    resp_data = json.loads(res.read().decode("utf-8"))
                    return {
                        "ok": True,
                        "call_sid": resp_data.get("id"),
                        "status": resp_data.get("status", "queued"),
                        "engine": "vapi",
                    }
            except Exception as exc:
                print(f"Vapi call failed, falling back to Twilio TwiML: {exc}", flush=True)

        if not self.is_configured:
            return {"ok": False, "error": "Neither Vapi nor Twilio is configured on the server."}
        
        try:
            from twilio.rest import Client
            import urllib.parse

            client = Client(
                settings.twilio_account_sid.strip(),
                settings.twilio_auth_token.strip(),
            )

            q_persona = urllib.parse.quote(persona or "female")
            q_name = urllib.parse.quote(contact_name or "there")

            if settings.twilio_webhook_base_url:
                webhook_url = self.webhook_url(f"/api/webhooks/twilio/ai-agent/intro?persona={q_persona}&name={q_name}")
                call = client.calls.create(
                    to=normalized,
                    from_=settings.twilio_phone_number.strip(),
                    url=webhook_url,
                )
            else:
                msg = text_message or f"Hello {contact_name or 'there'}, this is {persona} from Kafi Commodities. Thank you for connecting."
                twiml_content = self.say_twiml(msg)
                call = client.calls.create(
                    to=normalized,
                    from_=settings.twilio_phone_number.strip(),
                    twiml=twiml_content,
                )
            return {"ok": True, "call_sid": call.sid, "status": call.status, "engine": "twilio"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


voice_client = VoiceClient()
