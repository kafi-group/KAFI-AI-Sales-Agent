"""Persist Sara/Rayan AI Sales Agent queue across process restarts."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "ai_sales_agent_queue.json"
_LOCK = threading.Lock()
_MAX_TASKS = 300


def _ensure_file() -> None:
    _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not _DATA_PATH.exists():
        _DATA_PATH.write_text(
            json.dumps({"tasks": [], "runners": []}, indent=2),
            encoding="utf-8",
        )


def load_queue_state() -> dict[str, Any]:
    _ensure_file()
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"tasks": [], "runners": []}
    if not isinstance(raw, dict):
        return {"tasks": [], "runners": []}
    tasks = raw.get("tasks") if isinstance(raw.get("tasks"), list) else []
    runners = raw.get("runners") if isinstance(raw.get("runners"), list) else []
    return {"tasks": tasks, "runners": runners}


def save_queue_state(*, tasks: list[dict[str, Any]], runners: list[dict[str, Any]]) -> None:
    """Write queue atomically. Keeps newest tasks within _MAX_TASKS."""
    trimmed = list(tasks[-_MAX_TASKS:]) if len(tasks) > _MAX_TASKS else list(tasks)
    # Do not persist live dial locks across restart as in_progress — re-queue them.
    for t in trimmed:
        if t.get("status") == "in_progress":
            t["status"] = "queued"
            t["outcome"] = None
            t["call_sid"] = None
            t["remarks"] = "Re-queued after server restart (call was interrupted)."
            t.pop("started_at", None)
    runner_snap = []
    for r in runners:
        snap = {
            "persona": r.get("persona"),
            "status": "idle",
            "sequence_mode": False,
            "operator_user_id": r.get("operator_user_id"),
            "pending_count": r.get("pending_count") or 0,
            "current_task_id": None,
            "current_task": None,
        }
        runner_snap.append(snap)
    payload = {"tasks": trimmed, "runners": runner_snap}
    with _LOCK:
        _ensure_file()
        tmp = _DATA_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
        tmp.replace(_DATA_PATH)
