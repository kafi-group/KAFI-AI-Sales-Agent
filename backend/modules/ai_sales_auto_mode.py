"""Persisted AI Sales Agent Auto Mode settings (Sara / Rayan)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "ai_sales_auto_mode.json"

DEFAULT_BULK_EMAIL_PERSONA: dict[str, Any] = {
    "template_id": None,
    "from_mailbox_email": "",
    "cc": "",
    "subject": "",
    "body": "",
}

DEFAULT_SETTINGS: dict[str, Any] = {
    "enabled": False,
    "study_contacts": True,
    "call_mode": True,
    "send_email_after_call": True,
    "send_whatsapp_after_call": True,
    "bulk_email_when_no_call": True,
    "study_products": True,
    "product_brief": (
        "Kafi Commodities (Brand: ESSENCE) exports Basmati and non-Basmati rice, "
        "Himalayan pink salt, pickles, chutneys, pastes, sauces, spices, recipe mixes, "
        "honey, and related staples. Emphasize ISO/HACCP/Halal certifications, export "
        "packaging (retail cartons and bulk), consistent quality, and flexible CNF/FOB "
        "quotations by destination port and MOQ."
    ),
    # Per-agent defaults for Start Sara/Rayan when call mode is OFF + bulk email ON.
    "bulk_email_by_persona": {
        "female": dict(DEFAULT_BULK_EMAIL_PERSONA),
        "male": dict(DEFAULT_BULK_EMAIL_PERSONA),
    },
}


def _ensure_file() -> None:
    _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not _DATA_PATH.exists():
        _DATA_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")


def _normalize_bulk_persona(raw: Any) -> dict[str, Any]:
    out = dict(DEFAULT_BULK_EMAIL_PERSONA)
    if not isinstance(raw, dict):
        return out
    tid = raw.get("template_id")
    if tid is None or tid == "":
        out["template_id"] = None
    else:
        try:
            out["template_id"] = int(tid)
        except (TypeError, ValueError):
            out["template_id"] = None
    out["from_mailbox_email"] = str(raw.get("from_mailbox_email") or "").strip()
    out["cc"] = str(raw.get("cc") or "").strip()
    out["subject"] = str(raw.get("subject") or "")
    out["body"] = str(raw.get("body") or "")
    return out


def _normalize_bulk_by_persona(raw: Any) -> dict[str, dict[str, Any]]:
    base = {
        "female": dict(DEFAULT_BULK_EMAIL_PERSONA),
        "male": dict(DEFAULT_BULK_EMAIL_PERSONA),
    }
    if not isinstance(raw, dict):
        return base
    for persona in ("female", "male"):
        if persona in raw:
            base[persona] = _normalize_bulk_persona(raw.get(persona))
    return base


def get_auto_mode_settings() -> dict[str, Any]:
    _ensure_file()
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return json.loads(json.dumps(DEFAULT_SETTINGS))
    out = json.loads(json.dumps(DEFAULT_SETTINGS))
    if isinstance(raw, dict):
        for key, default in DEFAULT_SETTINGS.items():
            if key not in raw:
                continue
            if key == "bulk_email_by_persona":
                out[key] = _normalize_bulk_by_persona(raw.get(key))
            elif isinstance(default, bool):
                out[key] = bool(raw[key])
            elif isinstance(default, str):
                out[key] = str(raw[key] or default)
            else:
                out[key] = raw[key]
    return out


def get_bulk_email_config(persona: str) -> dict[str, Any]:
    """Return Sara/Rayan bulk-email setup (template, from, cc, editable body)."""
    persona = "female" if persona not in ("male", "female") else persona
    settings = get_auto_mode_settings()
    by_persona = settings.get("bulk_email_by_persona") or {}
    return _normalize_bulk_persona(by_persona.get(persona))


def update_auto_mode_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = get_auto_mode_settings()
    for key, default in DEFAULT_SETTINGS.items():
        if key not in patch:
            continue
        if key == "bulk_email_by_persona":
            incoming = patch.get(key)
            if not isinstance(incoming, dict):
                continue
            merged = _normalize_bulk_by_persona(current.get("bulk_email_by_persona"))
            for persona in ("female", "male"):
                if persona in incoming:
                    # Allow partial persona patches (e.g. only cc).
                    prev = merged[persona]
                    chunk = incoming[persona]
                    if isinstance(chunk, dict):
                        merged[persona] = _normalize_bulk_persona({**prev, **chunk})
            current[key] = merged
        elif isinstance(default, bool):
            current[key] = bool(patch[key])
        elif isinstance(default, str):
            current[key] = str(patch[key] if patch[key] is not None else default)
    _ensure_file()
    _DATA_PATH.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current
