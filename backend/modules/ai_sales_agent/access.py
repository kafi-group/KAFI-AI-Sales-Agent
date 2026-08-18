"""Access code gate for the AI Sales Agent module."""

from __future__ import annotations

from config import settings


def access_code_valid(code: str | None) -> bool:
    expected = (settings.ai_sales_agent_access_code or "786786").strip()
    provided = (code or "").strip()
    return bool(expected) and provided == expected
