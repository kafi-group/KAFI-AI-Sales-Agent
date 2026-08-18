"""Gemini conversation turns for AI Sales Agent calls."""

from __future__ import annotations

import json
import re
from typing import Any

from modules import llm_client
from modules.ai_sales_agent.personas import PersonaProfile

_JSON_RE = re.compile(r"\{[^{}]*\"outcome\"[^{}]*\}", re.DOTALL)

_WHO_IS_THIS = re.compile(
    r"who\s+(is\s+this|are\s+you)|what\s+company|where\s+are\s+you\s+calling\s+from",
    re.I,
)
_OPERATOR = re.compile(
    r"operator|reception|front\s+desk|transfer|hold\s+on|connect\s+you|wrong\s+(number|person)",
    re.I,
)
_NOT_IMPORTING = re.compile(
    r"not yet|don't import|do not import|no we don't|not in this business|we don't have",
    re.I,
)
_CONFIRM = re.compile(
    r"^(yes|yeah|yep|speaking|this\s+is|correct|that'?s\s+me)\b",
    re.I,
)


def opening_history(opening: str) -> list[dict[str, str]]:
    text = (opening or "").strip()
    if not text:
        return []
    return [{"role": "assistant", "content": text}]


def template_reply_for_turn(
    persona: PersonaProfile,
    *,
    turn: int,
    user_text: str,
    history: list[dict[str, str]],
) -> str | None:
    """Deterministic short replies for common early turns (also used when LLM fails)."""
    lower = (user_text or "").strip().lower()
    if not lower:
        return None

    assistant_turns = sum(1 for item in history if item.get("role") == "assistant")

    if _WHO_IS_THIS.search(lower):
        return (
            f"This is {persona.display_name} from Kafi Commodities, a Pakistani food exporter. "
            "I'd like to speak with someone in procurement or imports — is that you, "
            "or could you transfer me?"
        )

    if assistant_turns <= 1 and _CONFIRM.search(lower):
        return (
            f"Thank you. This is {persona.display_name} from Kafi Commodities, "
            "a Pakistani food exporter. How are you doing today?"
        )

    if _NOT_IMPORTING.search(lower):
        return (
            "I understand. What line of products does your business focus on today? "
            "We may still be able to help with rice or Himalayan salt when the timing is right."
        )

    if assistant_turns <= 2 and _CONFIRM.search(lower):
        return (
            "Great. We export Himalayan salt, rice, spices, and FMCG products from Pakistan. "
            "Are you currently importing any of these?"
        )

    if _OPERATOR.search(lower) or "not procurement" in lower or "wrong department" in lower:
        return (
            "I understand — could you please transfer me to procurement or the import team? "
            "We export rice, chutneys, and FMCG lines from Pakistan."
        )

    if turn <= 2 and ("hello" in lower or "hi" in lower) and len(lower.split()) <= 4:
        return (
            f"Hello, this is {persona.display_name} from Kafi Commodities. "
            "Am I speaking with the right person for import enquiries?"
        )

    return None


def reprompt_for_empty_speech(*, turn: int, empty_reprompts: int) -> str:
    if empty_reprompts >= 1:
        return "I'm sorry, I'm having trouble hearing you. I'll try again another time. Goodbye."
    if turn <= 1:
        return "Sorry, I didn't catch that. Am I speaking with the right person?"
    return "I'm sorry, could you repeat that?"


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
    """Return (spoken_reply, outcome_meta, updated_history) via Gemini."""
    messages = list(history)
    if user_text.strip():
        messages.append({"role": "user", "content": user_text.strip()})

    prompt_parts = [system_prompt, ""]
    for turn_item in messages:
        role = turn_item.get("role", "user")
        label = "Caller" if role == "user" else "Agent"
        prompt_parts.append(f"{label}: {turn_item.get('content', '')}")
    prompt_parts.append("Agent:")

    raw = llm_client.generate("\n".join(prompt_parts))
    spoken, meta = parse_agent_response(raw)

    new_history = list(messages)
    if spoken:
        new_history.append({"role": "assistant", "content": spoken})
    return spoken, meta, new_history


def generate_reply_with_fallback(
    *,
    system_prompt: str,
    history: list[dict[str, str]],
    user_text: str,
    persona: PersonaProfile,
    turn: int,
) -> tuple[str, dict[str, Any], list[dict[str, str]]]:
    """Template for common turns, then Gemini, then safe fallback."""
    messages = list(history)
    if user_text.strip():
        messages.append({"role": "user", "content": user_text.strip()})

    scripted = template_reply_for_turn(
        persona,
        turn=turn,
        user_text=user_text,
        history=messages,
    )
    if scripted:
        messages.append({"role": "assistant", "content": scripted})
        return scripted, {}, messages

    try:
        return generate_reply(
            system_prompt=system_prompt,
            history=history,
            user_text=user_text,
        )
    except Exception:
        spoken = (
            f"This is {persona.display_name} from Kafi Commodities, a Pakistani food exporter. "
            "May I speak with someone in procurement or imports?"
        )
        messages.append({"role": "assistant", "content": spoken})
        return spoken, {}, messages


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
