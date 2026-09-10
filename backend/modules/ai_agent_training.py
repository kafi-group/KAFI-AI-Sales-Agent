"""AI Agent Training module for Sara & Rayan (RAG learning from past call history)."""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from sqlalchemy.orm import Session
from db.models import Interaction, Channel
from modules.llm_client import llm_client

STORAGE_FILE = Path(__file__).parent.parent / "data" / "ai_training_knowledge.json"

_TRAINING_STORE: dict[str, Any] = {
    "last_trained_at": None,
    "total_calls_analyzed": 0,
    "selected_calls_used": 0,
    "learned_insights": (
        "• Call Opening: Start call by verifying identity ('Hello, am I speaking with [Name]?'). Upon confirmation, introduce yourself clearly as Sara/Rayan from Kafi Commodities.\n"
        "• Pitch Strategy: Lead with high quality Basmati 1121, 5% Broken White Rice, 99% Purity Sesame Seeds, and Yellow Corn before quoting prices.\n"
        "• Catalogue Delivery: NEVER ask the customer for their email address or phone number (we already have it on file!). Tell them: 'I will send our official product catalogue and CNF price list directly to your WhatsApp and email for you to go through.'\n"
        "• Name Usage: Mention the customer's name once in the greeting. Do NOT repeat their name repeatedly in every spoken sentence."
    ),
    "custom_rules": (
        "1. First ask: 'Hello, am I speaking with [Name]?'. After confirmation, introduce Sara/Rayan from Kafi Commodities.\n"
        "2. Do NOT ask for the customer's email or phone number. We already have their info in our system.\n"
        "3. Offer to send product catalogue and CNF price list to their WhatsApp and email.\n"
        "4. Do NOT repeat the customer's name repeatedly during the call."
    ),
}


def _load_store() -> None:
    if STORAGE_FILE.exists():
        try:
            with open(STORAGE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                _TRAINING_STORE.update(data)
        except Exception as e:
            print(f"Error loading training knowledge JSON: {e}", flush=True)


def _save_store() -> None:
    try:
        STORAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(STORAGE_FILE, "w", encoding="utf-8") as f:
            json.dump(_TRAINING_STORE, f, indent=2)
    except Exception as e:
        print(f"Error saving training knowledge JSON: {e}", flush=True)


# Load persistent store at startup
_load_store()


def get_training_knowledge(db: Session = None) -> dict[str, Any]:
    _ = db
    return dict(_TRAINING_STORE)


def _call_training_snippet(interaction: Interaction) -> str | None:
    """Prefer closed captions + remarks for curated training examples."""
    from modules.call_media import get_call_media
    from modules.calls import parse_call_fields

    parsed = parse_call_fields(interaction.content or "")
    notes = (parsed.get("notes") or "").strip()
    media = get_call_media(interaction) or {}
    transcript = ""
    if (media.get("transcript_status") or "").lower() == "ready":
        transcript = (media.get("transcript") or "").strip()
    body_parts = []
    if transcript:
        body_parts.append(f"Closed captions:\n{transcript[:3500]}")
    if notes:
        body_parts.append(f"Rep remarks:\n{notes[:800]}")
    if not body_parts:
        content = (interaction.content or "").strip()
        if not content:
            return None
        body_parts.append(f"Call log:\n{content[:800]}")
    subj = interaction.subject or "Phone Call"
    outcome = parsed.get("call_outcome") or ""
    header = f"- Call Subject: {subj}"
    if outcome:
        header += f" | Outcome: {outcome}"
    return f"{header}\n  " + "\n  ".join(body_parts)


def train_agent_from_history(db: Session = None) -> dict[str, Any]:
    """Learn from curated (Train Sara & Rayan) calls first; otherwise recent calls."""
    transcripts_sample: list[str] = []
    selected_used = 0
    if db is not None:
        try:
            selected = (
                db.query(Interaction)
                .filter(
                    Interaction.channel == Channel.phone,
                    Interaction.ai_training_selected.is_(True),
                )
                .order_by(Interaction.created_at.desc())
                .limit(40)
                .all()
            )
            for c in selected:
                snippet = _call_training_snippet(c)
                if snippet:
                    transcripts_sample.append(snippet)
                    selected_used += 1

            # If none curated yet, fall back to recent calls (legacy behaviour).
            if not transcripts_sample:
                calls = (
                    db.query(Interaction)
                    .filter(Interaction.channel == Channel.phone)
                    .order_by(Interaction.created_at.desc())
                    .limit(30)
                    .all()
                )
                for c in calls:
                    snippet = _call_training_snippet(c)
                    if snippet:
                        transcripts_sample.append(snippet)
        except Exception as exc:
            print(f"DB query in training failed: {exc}", flush=True)
            # Column may be deferred / not migrated — fall back without curated filter.
            try:
                calls = (
                    db.query(Interaction)
                    .filter(Interaction.channel == Channel.phone)
                    .order_by(Interaction.created_at.desc())
                    .limit(30)
                    .all()
                )
                for c in calls:
                    snippet = _call_training_snippet(c)
                    if snippet:
                        transcripts_sample.append(snippet)
            except Exception as exc2:
                print(f"Training fallback query failed: {exc2}", flush=True)

    if not transcripts_sample:
        transcripts_sample = [
            "- Call Subject: AI Voice Call (Sara) to Mr. Khalid\n  Call Content/Log: Customer asked for 5% Broken White Rice specs and CNF Karachi port pricing for 50 metric tons.",
            "- Call Subject: Manual dial +923142867152\n  Call Content/Log: Customer inquired about Sesame Seeds 99% purity and 30% TT advance payment terms.",
            "- Call Subject: AI Voice Call (Rayan) to Buyer\n  Call Content/Log: Customer requested proforma invoice for Yellow Corn export with free SGS quality inspection certificate.",
        ]

    combined_text = "\n\n".join(transcripts_sample)
    curated_note = (
        f"These {selected_used} examples were explicitly marked 'Train Sara & Rayan' by sales reps "
        "(high-quality conversations). Prioritize their tone, pacing, and objection handling."
        if selected_used
        else "No curated training calls were marked yet — analyzing recent calls. Ask reps to tick "
        "'Train Sara & Rayan' on good follow-up drafts."
    )

    prompt = f"""
Analyze the following B2B sales phone call transcripts/remarks for Kafi Commodities
(exporter of white rice, sesame seeds, corn, edible oils, Himalayan salt, sauces):

{curated_note}

{combined_text}

Synthesize a concise, high-converting Sales Training Playbook for AI Sales Agents (Sara & Rayan).
Extract:
1. Top 3 successful sales pitch angles and opening patterns from the good calls.
2. Common buyer objections and winning answers (prices, payment terms, MOQ, certifications).
3. Key product specs & trade terms frequently discussed.
4. Tone/style cues to copy (polite, concise, B2B exporter voice).

Format your output cleanly in 4-8 concise bullet points.
"""

    try:
        response = llm_client.generate(prompt)
        if response and response.strip():
            _TRAINING_STORE["learned_insights"] = response.strip()
    except Exception as exc:
        print(f"Error synthesizing training knowledge with Gemini AI: {exc}", flush=True)

    _TRAINING_STORE["last_trained_at"] = datetime.now(timezone.utc).isoformat()
    _TRAINING_STORE["total_calls_analyzed"] = len(transcripts_sample)
    _TRAINING_STORE["selected_calls_used"] = selected_used
    _save_store()
    return dict(_TRAINING_STORE)


def update_custom_rules(rules_text: str) -> dict[str, Any]:
    _TRAINING_STORE["custom_rules"] = rules_text.strip()
    _save_store()
    return dict(_TRAINING_STORE)
