"""Upload, store, and load email attachments for outbound Outlook sends."""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import UploadFile

_BACKEND_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = _BACKEND_DIR / "storage" / "email_attachments"

MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_FILES_PER_EMAIL = 8

ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
}

_EXTENSION_TO_TYPE = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain",
    ".csv": "text/csv",
}


def _sanitize_filename(name: str) -> str:
    base = Path(name).name
    cleaned = re.sub(r"[^\w.\- ]+", "_", base).strip(" .")
    return cleaned or "attachment"


def _guess_content_type(filename: str, content_type: str | None) -> str:
    if content_type and content_type in ALLOWED_CONTENT_TYPES:
        return content_type
    ext = Path(filename).suffix.lower()
    return _EXTENSION_TO_TYPE.get(ext, content_type or "application/octet-stream")


def public_attachment(meta: dict) -> dict:
    return {
        "id": meta["id"],
        "filename": meta["filename"],
        "content_type": meta["content_type"],
        "size": meta["size"],
    }


def public_attachments(items: list | None) -> list[dict]:
    if not items:
        return []
    return [public_attachment(item) for item in items if isinstance(item, dict) and item.get("id")]


async def save_upload(file: UploadFile) -> dict:
    filename = _sanitize_filename(file.filename or "attachment")
    content_type = _guess_content_type(filename, file.content_type)
    if content_type not in ALLOWED_CONTENT_TYPES:
        allowed = ", ".join(sorted(ALLOWED_CONTENT_TYPES))
        raise ValueError(
            f"File type not allowed for '{filename}'. Supported: images, PDF, Word, Excel, TXT, CSV."
        )

    data = await file.read()
    if not data:
        raise ValueError(f"File '{filename}' is empty")
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(f"File '{filename}' exceeds 10 MB limit")

    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    att_id = str(uuid.uuid4())
    storage_name = f"{att_id}_{filename}"
    abs_path = STORAGE_DIR / storage_name
    abs_path.write_bytes(data)

    return {
        "id": att_id,
        "filename": filename,
        "content_type": content_type,
        "size": len(data),
        "storage_path": f"email_attachments/{storage_name}",
    }


def register_attachment_from_path(
    source_path: Path, filename: str | None = None, content_type: str = "application/pdf"
) -> dict:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    clean_name = _sanitize_filename(filename or source_path.name)
    att_id = str(uuid.uuid4())
    storage_name = f"{att_id}_{clean_name}"
    abs_path = STORAGE_DIR / storage_name
    abs_path.write_bytes(source_path.read_bytes())
    return {
        "id": att_id,
        "filename": clean_name,
        "content_type": content_type,
        "size": source_path.stat().st_size,
        "storage_path": f"email_attachments/{storage_name}",
    }


def register_attachment_from_bytes(
    data: bytes, filename: str, content_type: str = "application/pdf"
) -> dict:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    clean_name = _sanitize_filename(filename)
    att_id = str(uuid.uuid4())
    storage_name = f"{att_id}_{clean_name}"
    abs_path = STORAGE_DIR / storage_name
    abs_path.write_bytes(data)
    return {
        "id": att_id,
        "filename": clean_name,
        "content_type": content_type,
        "size": len(data),
        "storage_path": f"email_attachments/{storage_name}",
    }


def resolve_path(storage_path: str) -> Path:
    rel = storage_path.replace("\\", "/").lstrip("/")
    if rel.startswith("email_attachments/"):
        target = _BACKEND_DIR / "storage" / rel
        if target.is_file():
            return target
        flat = _BACKEND_DIR / "storage" / rel.split("/", 1)[1]
        if flat.is_file():
            return flat
        return target
    cand1 = STORAGE_DIR / rel
    if cand1.is_file():
        return cand1
    return _BACKEND_DIR / "storage" / rel


def load_bytes(meta: dict) -> tuple[bytes, str, str]:
    path = resolve_path(str(meta.get("storage_path", "")))
    if not path.is_file():
        raise FileNotFoundError(f"Attachment file missing: {meta.get('filename', 'unknown')}")
    return path.read_bytes(), str(meta.get("filename", path.name)), str(meta.get("content_type", "application/octet-stream"))


def copy_attachments(items: list | None) -> list[dict]:
    """Copy attachment files so each draft owns its files (bulk sends)."""
    if not items:
        return []
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    copied: list[dict] = []
    for item in items:
        if not isinstance(item, dict) or not item.get("storage_path"):
            continue
        try:
            data, filename, content_type = load_bytes(item)
        except FileNotFoundError:
            continue
        att_id = str(uuid.uuid4())
        storage_name = f"{att_id}_{_sanitize_filename(filename)}"
        abs_path = STORAGE_DIR / storage_name
        abs_path.write_bytes(data)
        copied.append(
            {
                "id": att_id,
                "filename": filename,
                "content_type": content_type,
                "size": len(data),
                "storage_path": f"email_attachments/{storage_name}",
            }
        )
    return copied


def resolve_attachment(meta: dict, existing: list | None = None) -> dict | None:
    if meta.get("storage_path"):
        return meta
    att_id = str(meta.get("id") or "")
    if not att_id:
        return None
    for item in existing or []:
        if isinstance(item, dict) and item.get("id") == att_id and item.get("storage_path"):
            return item
    if not STORAGE_DIR.is_dir():
        return None
    matches = list(STORAGE_DIR.glob(f"{att_id}_*"))
    if not matches:
        return None
    path = matches[0]
    return {
        "id": att_id,
        "filename": meta.get("filename") or path.name.split("_", 1)[-1],
        "content_type": meta.get("content_type") or _guess_content_type(path.name, None),
        "size": meta.get("size") or path.stat().st_size,
        "storage_path": f"email_attachments/{path.name}",
    }


def resolve_attachment_list(items: list | None, existing: list | None = None) -> list[dict]:
    resolved: list[dict] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        meta = resolve_attachment(item, existing)
        if meta:
            resolved.append(meta)
        if len(resolved) >= MAX_FILES_PER_EMAIL:
            break
    return resolved


def merge_attachments(*groups: list | None) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    for group in groups:
        for item in group or []:
            if not isinstance(item, dict):
                continue
            key = str(item.get("id") or item.get("storage_path") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(item)
            if len(merged) >= MAX_FILES_PER_EMAIL:
                return merged
    return merged
