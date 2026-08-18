"""Gemini conversation turns for AI Sales Agent calls."""

from __future__ import annotations

import json
import re
from typing import Any

from modules import llm_client

_JSON_RE = re.compile(r"\{[^{}]*\"outcome\"[^{}]*\}", re.DOTALL)


def parse_agent_response(raw: str) -> tuple[str, dict[str, Any]]:
    """Split spoken text, optional outcome JSON."""
    text = (raw or "").strip()
    outcome_data: dict[str, Any] = {}
    match = _JSON_RE.search(text)
    if match:
        try:
            outcome_data = json.loads(match.group(0))
        except json.JSONDecodeError:
            outcome_data = {}
        text = text[: match.start()].strip()
    text = text.replace("[END_CALL]", "").strip()
    return text, outcome_data


def generate_reply(
    *,
    system_prompt: str,
    history: list[dict[str, str]],
    user_text: str,
) -> tuple[str, dict[str, Any], list[dict[str, str]]]:
    """Return (spoken_reply, outcome_meta, updated_history)."""
    messages = list(history)
    if user_text.strip():
        messages.append({"role": "user", "content": user_text.strip()})

    prompt_parts = [system_prompt, ""]
    for turn in messages:
        role = turn.get("role", "user")
        label = "Caller" if role == "user" else "Agent"
        prompt_parts.append(f"{label}: {turn.get('content', '')}")
    prompt_parts.append("Agent:")

    raw = llm_client.generate("\n".join(prompt_parts))
    spoken, meta = parse_agent_response(raw)

    new_history = list(messages)
    if spoken:
        new_history.append({"role": "assistant", "content": spoken})
    return spoken, meta, new_history


def analyze_transcript(
    *,
    system_prompt: str,
    transcript: list[dict[str, str]],
) -> dict[str, Any]:
    """Post-call outcome when gather ended abruptly."""
    lines = []
    for turn in transcript:
        role = "Caller" if turn.get("role") == "user" else "Agent"
        lines.append(f"{role}: {turn.get('content', '')}")
    convo = "\n".join(lines) or "(no speech captured)"
    prompt = (
        f"{system_prompt}\n\n"
        "The call has ended. Based on the transcript below, respond with JSON only:\n"
        '{"outcome":"interested|follow_up|not_interested|not_received_call",'
        '"remark":"one line summary for CRM"}\n\n'
        f"Transcript:\n{convo}"
    )
    raw = llm_client.generate(prompt)
    _, meta = parse_agent_response(raw)
    if not meta.get("outcome"):
        try:
            meta = json.loads(raw.strip())
        except json.JSONDecodeError:
            meta = {"outcome": "follow_up", "remark": "AI call completed — review transcript."}
    return meta
