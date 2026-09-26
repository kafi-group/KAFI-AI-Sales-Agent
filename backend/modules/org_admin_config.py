"""Org admin config: Active Master Lists + AI Sales Agents registry.

Stored as JSON under backend/data/ — does not alter queues, Twilio, WhatsApp, or mail.
Sara (female) and Rayan (male) are seeded and protected (rename/active only; no delete).
"""

from __future__ import annotations

import json
import re
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "org_admin_config.json"
_LOCK = threading.Lock()

_DEFAULT_MASTER_LISTS: list[dict[str, Any]] = [
    {"key": "fmcg", "label": "Master FMCG", "enabled": True, "sort_order": 0},
    {"key": "minerals_ores", "label": "Minerals & Ores", "enabled": True, "sort_order": 1},
    {"key": "other_items", "label": "Other Items", "enabled": True, "sort_order": 2},
]

_DEFAULT_AGENTS: list[dict[str, Any]] = [
    {
        "id": "female",
        "name": "Sara",
        "active": True,
        "product_focus": "",
        "voice": "en-US-Neural2-F",
        "gender_label": "female",
        "protected": True,
    },
    {
        "id": "male",
        "name": "Rayan",
        "active": True,
        "product_focus": "",
        "voice": "en-US-Neural2-D",
        "gender_label": "male",
        "protected": True,
    },
]


def _default_store() -> dict[str, Any]:
    return {
        "master_lists": deepcopy(_DEFAULT_MASTER_LISTS),
        # user_id (str) -> list of master list keys; missing user = all enabled lists
        "user_master_access": {},
        "ai_sales_agents": deepcopy(_DEFAULT_AGENTS),
    }


def _ensure_file() -> None:
    _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not _DATA_PATH.exists():
        _DATA_PATH.write_text(json.dumps(_default_store(), indent=2), encoding="utf-8")


def _load() -> dict[str, Any]:
    _ensure_file()
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _default_store()
    if not isinstance(raw, dict):
        return _default_store()
    base = _default_store()
    lists = raw.get("master_lists")
    if isinstance(lists, list) and lists:
        cleaned: list[dict[str, Any]] = []
        for i, row in enumerate(lists):
            if not isinstance(row, dict):
                continue
            key = _slug_key(str(row.get("key") or row.get("label") or f"list_{i}"))
            if not key:
                continue
            cleaned.append(
                {
                    "key": key,
                    "label": str(row.get("label") or key).strip() or key,
                    "enabled": bool(row.get("enabled", True)),
                    "sort_order": int(row.get("sort_order") if row.get("sort_order") is not None else i),
                }
            )
        if cleaned:
            base["master_lists"] = cleaned
    access = raw.get("user_master_access")
    if isinstance(access, dict):
        out_access: dict[str, list[str]] = {}
        for uid, keys in access.items():
            if isinstance(keys, list):
                out_access[str(uid)] = [str(k) for k in keys if str(k).strip()]
        base["user_master_access"] = out_access
    agents = raw.get("ai_sales_agents")
    if isinstance(agents, list) and agents:
        cleaned_a: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in agents:
            if not isinstance(row, dict):
                continue
            aid = str(row.get("id") or "").strip()
            if not aid or aid in seen:
                continue
            seen.add(aid)
            cleaned_a.append(
                {
                    "id": aid,
                    "name": str(row.get("name") or aid).strip() or aid,
                    "active": bool(row.get("active", True)),
                    "product_focus": str(row.get("product_focus") or "").strip(),
                    "voice": str(row.get("voice") or "en-US-Neural2-D").strip() or "en-US-Neural2-D",
                    "gender_label": str(row.get("gender_label") or aid).strip() or aid,
                    "protected": bool(row.get("protected", aid in ("female", "male"))),
                }
            )
        # Always keep Sara/Rayan present
        for seed in _DEFAULT_AGENTS:
            if seed["id"] not in seen:
                cleaned_a.insert(0 if seed["id"] == "female" else 1, deepcopy(seed))
        if cleaned_a:
            base["ai_sales_agents"] = cleaned_a
    return base


def _save(data: dict[str, Any]) -> None:
    _ensure_file()
    _DATA_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _slug_key(raw: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (raw or "").strip().lower()).strip("_")
    return s[:64]


def get_master_lists(*, include_disabled: bool = False) -> list[dict[str, Any]]:
    data = _load()
    rows = list(data.get("master_lists") or [])
    rows.sort(key=lambda r: (int(r.get("sort_order") or 0), str(r.get("label") or "")))
    if include_disabled:
        return rows
    return [r for r in rows if r.get("enabled")]


def master_keys_for_user(user_id: int | None, *, is_admin: bool = False) -> list[str]:
    """Keys the user may select. Admin / unset access → all enabled lists."""
    enabled = get_master_lists(include_disabled=False)
    enabled_keys = [str(r["key"]) for r in enabled]
    if is_admin or user_id is None:
        return enabled_keys
    data = _load()
    access = data.get("user_master_access") or {}
    raw = access.get(str(int(user_id)))
    if raw is None:
        return enabled_keys
    allowed = {str(k) for k in raw}
    return [k for k in enabled_keys if k in allowed]


def get_user_master_access() -> dict[str, list[str]]:
    return dict(_load().get("user_master_access") or {})


def upsert_master_list(
    *,
    key: str | None,
    label: str,
    enabled: bool = True,
    sort_order: int | None = None,
) -> dict[str, Any]:
    label = (label or "").strip()
    if not label:
        raise ValueError("Label is required")
    with _LOCK:
        data = _load()
        rows = list(data.get("master_lists") or [])
        k = _slug_key(key or label)
        if not k:
            raise ValueError("Invalid list key")
        existing = next((r for r in rows if r.get("key") == k), None)
        if existing:
            existing["label"] = label
            existing["enabled"] = bool(enabled)
            if sort_order is not None:
                existing["sort_order"] = int(sort_order)
            row = existing
        else:
            order = (
                int(sort_order)
                if sort_order is not None
                else (max((int(r.get("sort_order") or 0) for r in rows), default=-1) + 1)
            )
            row = {"key": k, "label": label, "enabled": bool(enabled), "sort_order": order}
            rows.append(row)
        data["master_lists"] = rows
        _save(data)
        return row


def delete_master_list(key: str) -> None:
    k = _slug_key(key)
    if k in {"fmcg", "minerals_ores", "other_items"}:
        raise ValueError("Built-in master lists cannot be deleted — disable them instead.")
    with _LOCK:
        data = _load()
        rows = [r for r in (data.get("master_lists") or []) if r.get("key") != k]
        if len(rows) == len(data.get("master_lists") or []):
            raise ValueError("Master list not found")
        data["master_lists"] = rows
        access = data.get("user_master_access") or {}
        for uid, keys in list(access.items()):
            access[uid] = [x for x in keys if x != k]
        data["user_master_access"] = access
        _save(data)


def set_user_master_access(user_id: int, keys: list[str]) -> list[str]:
    valid = {str(r["key"]) for r in get_master_lists(include_disabled=True)}
    cleaned = [k for k in keys if k in valid]
    with _LOCK:
        data = _load()
        access = dict(data.get("user_master_access") or {})
        access[str(int(user_id))] = cleaned
        data["user_master_access"] = access
        _save(data)
    return cleaned


def list_ai_sales_agents(*, active_only: bool = False) -> list[dict[str, Any]]:
    rows = list(_load().get("ai_sales_agents") or [])
    if active_only:
        rows = [r for r in rows if r.get("active")]
    return rows


def get_ai_agent(agent_id: str) -> dict[str, Any] | None:
    aid = str(agent_id or "").strip()
    return next((r for r in list_ai_sales_agents() if r.get("id") == aid), None)


def agent_display_name(agent_id: str) -> str:
    row = get_ai_agent(agent_id)
    if row:
        return str(row.get("name") or agent_id)
    if agent_id == "female":
        return "Sara"
    if agent_id == "male":
        return "Rayan"
    return agent_id or "Agent"


def active_agent_ids() -> list[str]:
    return [str(r["id"]) for r in list_ai_sales_agents(active_only=True)]


def upsert_ai_sales_agent(
    *,
    agent_id: str | None,
    name: str,
    active: bool = True,
    product_focus: str = "",
    voice: str | None = None,
) -> dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("Agent name is required")
    with _LOCK:
        data = _load()
        rows = list(data.get("ai_sales_agents") or [])
        if agent_id:
            aid = str(agent_id).strip()
        else:
            aid = _slug_key(f"agent_{name}")
            if not aid or aid in ("female", "male", "pipeline"):
                aid = f"agent_{abs(hash(name)) % 10_000_000}"
            base = aid
            n = 2
            existing_ids = {str(r.get("id")) for r in rows}
            while aid in existing_ids:
                aid = f"{base}_{n}"
                n += 1
        existing = next((r for r in rows if r.get("id") == aid), None)
        if existing:
            existing["name"] = name
            existing["active"] = bool(active)
            existing["product_focus"] = (product_focus or "").strip()
            if voice:
                existing["voice"] = voice.strip()
            row = existing
        else:
            row = {
                "id": aid,
                "name": name,
                "active": bool(active),
                "product_focus": (product_focus or "").strip(),
                "voice": (voice or "en-US-Neural2-D").strip(),
                "gender_label": aid,
                "protected": aid in ("female", "male"),
            }
            rows.append(row)
        data["ai_sales_agents"] = rows
        _save(data)
        return row


def delete_ai_sales_agent(agent_id: str) -> None:
    aid = str(agent_id or "").strip()
    row = get_ai_agent(aid)
    if not row:
        raise ValueError("Agent not found")
    if row.get("protected") or aid in ("female", "male"):
        raise ValueError("Sara and Rayan cannot be removed — set them inactive instead.")
    with _LOCK:
        data = _load()
        data["ai_sales_agents"] = [r for r in (data.get("ai_sales_agents") or []) if r.get("id") != aid]
        _save(data)


def admin_snapshot() -> dict[str, Any]:
    data = _load()
    return {
        "master_lists": get_master_lists(include_disabled=True),
        "user_master_access": get_user_master_access(),
        "ai_sales_agents": list_ai_sales_agents(active_only=False),
    }
