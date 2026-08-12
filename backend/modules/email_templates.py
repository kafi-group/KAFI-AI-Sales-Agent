"""Email templates with merge-field personalization for bulk outreach."""

from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy.orm import Session

from config import settings
from db.models import Buyer, Contact, EmailTemplate

SUPPORTED_PLACEHOLDERS = [
    "company_name",
    "contact_name",
    "country",
    "industry",
    "designation",
    "website_url",
    "email",
]

# Bracket/brace aliases → canonical key (case/spacing insensitive).
_PLACEHOLDER_ALIASES: dict[str, tuple[str, ...]] = {
    "company_name": ("company_name", "company name", "company"),
    "contact_name": ("contact_name", "contact name", "contact", "name"),
    "country": ("country",),
    "industry": ("industry",),
    "designation": ("designation", "title"),
    "website_url": ("website_url", "website url", "website"),
    "email": ("email", "contact_email", "contact email"),
}


def _normalize_placeholder_key(raw: str) -> str | None:
    key = (raw or "").strip().lower().replace("_", " ")
    key = re.sub(r"\s+", " ", key)
    for canonical, aliases in _PLACEHOLDER_ALIASES.items():
        for alias in aliases:
            if key == alias.replace("_", " "):
                return canonical
    return None


def render_template_text(text: str, *, buyer: Buyer, contact: Contact) -> str:
    """Replace [placeholder] and {{placeholder}} tokens (incl. [Company Name])."""
    values = {
        "company_name": buyer.company_name or "",
        "contact_name": contact.full_name or "Sir/Madam",
        "country": buyer.country or "your market",
        "industry": buyer.industry or "",
        "designation": contact.designation or "",
        "website_url": buyer.website_url or "",
        "email": contact.email or "",
    }

    def _replace_brace(match: re.Match[str]) -> str:
        canonical = _normalize_placeholder_key(match.group(1))
        if not canonical:
            return match.group(0)
        return values.get(canonical, "")

    def _replace_bracket(match: re.Match[str]) -> str:
        canonical = _normalize_placeholder_key(match.group(1))
        if not canonical:
            return match.group(0)
        return values.get(canonical, "")

    rendered = re.sub(r"\{\{\s*([^}]+?)\s*\}\}", _replace_brace, text or "")
    rendered = re.sub(r"\[([^\]]+)\]", _replace_bracket, rendered)
    return rendered


def list_templates(db: Session) -> list[EmailTemplate]:
    return db.query(EmailTemplate).order_by(EmailTemplate.updated_at.desc()).all()


def get_template(db: Session, template_id: int) -> EmailTemplate | None:
    return db.get(EmailTemplate, template_id)


from modules.email_attachments import resolve_attachment_list


def create_template(db: Session, data: dict) -> EmailTemplate:
    record = EmailTemplate(
        name=data["name"],
        subject=data["subject"],
        body=data["body"],
        attachments=resolve_attachment_list(data.get("attachments") or []),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def update_template(db: Session, template_id: int, data: dict) -> EmailTemplate | None:
    record = get_template(db, template_id)
    if not record:
        return None
    for key in ("name", "subject", "body", "attachments"):
        if key in data and data[key] is not None:
            value = data[key]
            if key == "attachments":
                value = resolve_attachment_list(value, record.attachments)
            setattr(record, key, value)
    db.commit()
    db.refresh(record)
    return record


def delete_template(db: Session, template_id: int) -> bool:
    record = get_template(db, template_id)
    if not record:
        return False
    db.delete(record)
    db.commit()
    return True


def preview_text(
    db: Session,
    *,
    buyer_id: int,
    subject: str,
    body: str,
) -> dict[str, str] | None:
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        return None

    from modules.buyers import primary_contact_with_email

    contact = primary_contact_with_email(db, buyer_id)
    if not contact:
        contact = Contact(
            buyer_id=buyer_id,
            full_name="Sample Contact",
            email="contact@example.com",
        )

    return {
        "subject": render_template_text(subject, buyer=buyer, contact=contact),
        "body": render_template_text(body, buyer=buyer, contact=contact),
        "company_name": buyer.company_name,
        "contact_email": contact.email or "",
    }


def preview_template(
    db: Session,
    template_id: int,
    buyer_id: int,
) -> dict[str, str] | None:
    template = get_template(db, template_id)
    buyer = db.get(Buyer, buyer_id)
    if not template or not buyer:
        return None

    from modules.buyers import primary_contact_with_email

    contact = primary_contact_with_email(db, buyer_id)
    if not contact:
        contact = Contact(
            buyer_id=buyer_id,
            full_name="Sample Contact",
            email="contact@example.com",
        )

    return {
        "subject": render_template_text(template.subject, buyer=buyer, contact=contact),
        "body": render_template_text(template.body, buyer=buyer, contact=contact),
        "company_name": buyer.company_name,
        "contact_email": contact.email or "",
    }


def _template_api_keys() -> list[str]:
    keys = _collect_template_keys(
        settings.email_template_gemini_api_key,
        settings.email_template_gemini_api_keys,
    )
    if keys:
        return keys
    for candidate in (settings.gemini_api_key, settings.llm_api_key):
        key = (candidate or "").strip()
        if key:
            return _collect_template_keys(key, settings.gemini_api_keys)
    return _collect_template_keys(None, settings.gemini_api_keys)


def _collect_template_keys(primary: str | None, extras_csv: str | None) -> list[str]:
    keys = _parse_csv(extras_csv)
    primary_key = (primary or "").strip()
    if primary_key and primary_key not in keys:
        keys.insert(0, primary_key)
    return keys


def template_llm_enabled() -> bool:
    return bool(_template_api_keys())


def _parse_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _template_model_chain() -> list[str]:
    from modules.llm_client import DEFAULT_FALLBACK_MODELS, DEFAULT_MODEL, _resolve_model_name

    primary = _resolve_model_name(settings.email_template_gemini_model or DEFAULT_MODEL)
    fallbacks = _parse_csv(settings.email_template_gemini_fallback_models) or list(
        DEFAULT_FALLBACK_MODELS
    )
    chain: list[str] = []
    for name in [primary, *fallbacks]:
        resolved = _resolve_model_name(name)
        if resolved and resolved not in chain:
            chain.append(resolved)
    return chain or [DEFAULT_MODEL]


def _generate_template_text(*, system: str, prompt: str) -> str:
    from modules.llm_client import _is_retryable_model_error

    api_keys = _template_api_keys()
    if not api_keys:
        raise RuntimeError(
            "EMAIL_TEMPLATE_GEMINI_API_KEY (or GEMINI_API_KEY) is not set. "
            "Add it to backend/.env to enable AI template creation."
        )

    try:
        from google import genai  # type: ignore[import]
        from google.genai import types as genai_types  # type: ignore[import]
    except Exception as exc:
        raise RuntimeError("Google GenAI SDK is not installed.") from exc

    clients = [genai.Client(api_key=key) for key in api_keys]
    max_tokens = max(256, int(settings.email_template_gemini_max_output_tokens or 2048))
    config = genai_types.GenerateContentConfig(
        max_output_tokens=max_tokens,
        system_instruction=system,
    )

    last_error: Exception | None = None
    retryable = False
    for client in clients:
        for model in _template_model_chain():
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=config,
                )
                text = (response.text or "").strip()
                if text:
                    return text
                raise RuntimeError("Empty model response")
            except Exception as exc:
                last_error = exc
                if _is_retryable_model_error(exc):
                    retryable = True
                    continue
                raise RuntimeError(f"Gemini generation failed ({model}): {exc}") from exc

    if retryable:
        raise RuntimeError(
            "Gemini failed on all configured models (rate limit or unavailable model)."
        ) from last_error
    raise RuntimeError(f"Gemini generation failed: {last_error}") from last_error


def _parse_json_object(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        lines = text.split("\n")
        end = -1 if lines[-1].startswith("```") else len(lines)
        text = "\n".join(lines[1:end])
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        text = match.group(0)
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("Model response was not a JSON object")
    return data


def generate_template_from_title(title: str) -> dict[str, str]:
    """Use Gemini to draft subject + body from a short template title/name."""
    cleaned = (title or "").strip()
    if len(cleaned) < 2:
        raise ValueError("Template title is required")

    placeholders = ", ".join(f"[{key}]" for key in SUPPORTED_PLACEHOLDERS)
    system = (
        "You write reusable B2B email templates for Kafi Commodities (Pvt) Ltd, "
        "a Pakistani food exporter (rice, ESSENCE Himalayan pink salt, chutneys, "
        "sauces, pickles, spices, honey). Tone: professional, concise, warm — "
        "sales co-pilot drafts for human review, not pushy spam."
    )
    prompt = (
        f'Template title / purpose: "{cleaned}"\n\n'
        "Create one reusable outbound email template for that purpose.\n"
        "Rules:\n"
        f"- Use merge placeholders where personalization helps: {placeholders}\n"
        "- Prefer [contact_name] and [company_name] in the greeting and opening.\n"
        "- Keep subject under ~90 characters; body 120–220 words unless the title "
        "clearly needs a short note.\n"
        "- Plain text only (no HTML).\n"
        "- Sign off as Kafi Commodities Export Team.\n"
        "- Do not invent fake certifications, prices, or MOQs.\n\n"
        "Respond with ONLY valid JSON (no markdown):\n"
        '{"name":"...","subject":"...","body":"..."}\n'
        "Use the given title as name (you may lightly polish capitalization)."
    )

    raw = _generate_template_text(system=system, prompt=prompt)
    data = _parse_json_object(raw)

    name = str(data.get("name") or cleaned).strip() or cleaned
    subject = str(data.get("subject") or "").strip()
    body = str(data.get("body") or "").strip()
    if not subject or not body:
        raise RuntimeError("AI returned an incomplete template — try again.")

    return {"name": name[:200], "subject": subject[:500], "body": body}


def generate_compose_draft_from_prompt(
    prompt: str,
    *,
    to_hint: str | None = None,
    context: str | None = None,
) -> dict[str, str]:
    """Draft a one-off compose email (subject + body) from a free-form user prompt."""
    from pathlib import Path

    cleaned = (prompt or "").strip()
    if len(cleaned) < 8:
        raise ValueError("Describe what the email should say (at least a short prompt).")

    system_path = (
        Path(__file__).resolve().parent.parent / "prompts" / "mailer_compose_draft_prompt.md"
    )
    try:
        system = system_path.read_text(encoding="utf-8").strip()
    except OSError:
        system = (
            "You draft professional B2B emails for Kafi Commodities. "
            'Respond with ONLY JSON: {"subject":"...","body":"..."}.'
        )

    extras: list[str] = []
    if (to_hint or "").strip():
        extras.append(f"Recipient email / To field: {(to_hint or '').strip()}")
    if (context or "").strip():
        extras.append(f"Extra context: {(context or '').strip()}")
    extra_block = ("\n".join(extras) + "\n\n") if extras else ""

    user_prompt = (
        f"{extra_block}"
        f"User request:\n{cleaned}\n\n"
        "Draft one outbound email matching that request.\n"
        'Respond with ONLY valid JSON: {"subject":"...","body":"..."}'
    )

    raw = _generate_template_text(system=system, prompt=user_prompt)
    data = _parse_json_object(raw)
    subject = str(data.get("subject") or "").strip()
    body = str(data.get("body") or "").strip()
    if not subject or not body:
        raise RuntimeError("AI returned an incomplete draft — try again.")

    return {"subject": subject[:500], "body": body}
