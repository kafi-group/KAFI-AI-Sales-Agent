"""Persisted AI Sales Agent Auto Mode settings (Sara / Rayan)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "ai_sales_auto_mode.json"

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
}


def _ensure_file() -> None:
    _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not _DATA_PATH.exists():
        _DATA_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")


def get_auto_mode_settings() -> dict[str, Any]:
    _ensure_file()
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_SETTINGS)
    out = dict(DEFAULT_SETTINGS)
    if isinstance(raw, dict):
        for key, default in DEFAULT_SETTINGS.items():
            if key not in raw:
                continue
            if isinstance(default, bool):
                out[key] = bool(raw[key])
            elif isinstance(default, str):
                out[key] = str(raw[key] or default)
            else:
                out[key] = raw[key]
    return out


def update_auto_mode_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = get_auto_mode_settings()
    for key, default in DEFAULT_SETTINGS.items():
        if key not in patch:
            continue
        if isinstance(default, bool):
            current[key] = bool(patch[key])
        elif isinstance(default, str):
            current[key] = str(patch[key] if patch[key] is not None else default)
    _ensure_file()
    _DATA_PATH.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current
