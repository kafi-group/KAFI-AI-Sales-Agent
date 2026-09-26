"""Shared mailer picture library — groups of hosted images for compose/bulk.

Images are stored via existing email attachment / inline-media hosting.
Metadata lives in backend/data/mailer_picture_library.json so every user
sees the same library (not local PC files).
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "mailer_picture_library.json"
_LOCK = threading.Lock()
_MEMORY: dict[str, Any] | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(raw: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (raw or "").strip().lower()).strip("_")
    return (s or "group")[:48]


def _default() -> dict[str, Any]:
    return {"groups": []}


def _ensure() -> None:
    global _MEMORY
    try:
        _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
        if not _DATA_PATH.exists():
            _DATA_PATH.write_text(json.dumps(_default(), indent=2), encoding="utf-8")
    except OSError:
        if _MEMORY is None:
            _MEMORY = _default()


def _load() -> dict[str, Any]:
    global _MEMORY
    _ensure()
    if _MEMORY is not None and not _DATA_PATH.exists():
        return deepcopy(_MEMORY)
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return deepcopy(_MEMORY) if _MEMORY is not None else _default()
    if not isinstance(raw, dict):
        return _default()
    groups_raw = raw.get("groups")
    groups: list[dict[str, Any]] = []
    if isinstance(groups_raw, list):
        for g in groups_raw:
            if not isinstance(g, dict):
                continue
            gid = str(g.get("id") or "").strip() or str(uuid.uuid4())
            images: list[dict[str, Any]] = []
            for img in g.get("images") or []:
                if not isinstance(img, dict):
                    continue
                mid = str(img.get("id") or "").strip()
                url = str(img.get("url") or "").strip()
                if not mid or not url:
                    continue
                images.append(
                    {
                        "id": mid,
                        "url": url,
                        "filename": str(img.get("filename") or f"{mid}.png"),
                        "content_type": str(img.get("content_type") or "image/png"),
                        "size": int(img.get("size") or 0),
                        "uploaded_by": str(img.get("uploaded_by") or ""),
                        "created_at": str(img.get("created_at") or ""),
                    }
                )
            groups.append(
                {
                    "id": gid,
                    "name": str(g.get("name") or gid).strip() or gid,
                    "created_at": str(g.get("created_at") or ""),
                    "created_by": str(g.get("created_by") or ""),
                    "images": images,
                }
            )
    store = {"groups": groups}
    _MEMORY = deepcopy(store)
    return store


def _save(data: dict[str, Any]) -> None:
    global _MEMORY
    _MEMORY = deepcopy(data)
    try:
        _ensure()
        _DATA_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        pass


def list_library() -> dict[str, Any]:
    data = _load()
    return {"groups": list(data.get("groups") or [])}


def create_group(*, name: str, created_by: str = "") -> dict[str, Any]:
    label = (name or "").strip()
    if not label:
        raise ValueError("Group name is required")
    with _LOCK:
        data = _load()
        groups = list(data.get("groups") or [])
        base = _slug(label)
        gid = base
        n = 2
        existing = {str(g.get("id")) for g in groups}
        while gid in existing:
            gid = f"{base}_{n}"
            n += 1
        row = {
            "id": gid,
            "name": label,
            "created_at": _now(),
            "created_by": (created_by or "").strip(),
            "images": [],
        }
        groups.append(row)
        data["groups"] = groups
        _save(data)
        return row


def rename_group(group_id: str, name: str) -> dict[str, Any]:
    label = (name or "").strip()
    if not label:
        raise ValueError("Group name is required")
    with _LOCK:
        data = _load()
        for g in data.get("groups") or []:
            if g.get("id") == group_id:
                g["name"] = label
                _save(data)
                return g
    raise ValueError("Group not found")


def delete_group(group_id: str) -> None:
    with _LOCK:
        data = _load()
        before = list(data.get("groups") or [])
        after = [g for g in before if g.get("id") != group_id]
        if len(after) == len(before):
            raise ValueError("Group not found")
        data["groups"] = after
        _save(data)


def add_image(
    group_id: str,
    *,
    media_id: str,
    url: str,
    filename: str,
    content_type: str = "image/png",
    size: int = 0,
    uploaded_by: str = "",
) -> dict[str, Any]:
    mid = str(media_id or "").strip()
    href = str(url or "").strip()
    if not mid or not href:
        raise ValueError("Image id and url are required")
    with _LOCK:
        data = _load()
        for g in data.get("groups") or []:
            if g.get("id") != group_id:
                continue
            images = list(g.get("images") or [])
            # Replace if same media id re-uploaded
            images = [i for i in images if i.get("id") != mid]
            row = {
                "id": mid,
                "url": href,
                "filename": (filename or f"{mid}.png").strip(),
                "content_type": content_type or "image/png",
                "size": int(size or 0),
                "uploaded_by": (uploaded_by or "").strip(),
                "created_at": _now(),
            }
            images.append(row)
            g["images"] = images
            _save(data)
            return row
    raise ValueError("Group not found")


def delete_image(group_id: str, media_id: str) -> None:
    with _LOCK:
        data = _load()
        for g in data.get("groups") or []:
            if g.get("id") != group_id:
                continue
            before = list(g.get("images") or [])
            after = [i for i in before if i.get("id") != media_id]
            if len(after) == len(before):
                raise ValueError("Image not found")
            g["images"] = after
            _save(data)
            return
    raise ValueError("Group not found")
