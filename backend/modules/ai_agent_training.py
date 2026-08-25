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
    "learned_insights": (
        "• Pitch Strategy: Lead with high quality Basmati 1121 and 5% Broken White Rice specs before quoting prices.\n"
        "• Payment Terms: Standard payment terms are LC at sight or 30% TT advance deposit.\n"
        "• Common Objections: When buyers request discounts for high volume (100+ MT), offer free SGS inspection certificates and CNF Karachi port quotes.\n"
        "• Key Products: White Rice, Sesame Seeds 99% purity, Yellow Corn, Spices, and Edible Oils."
    ),
    "custom_rules": (
        "1. Always address the customer politely by name or company title.\n"
        "2. Quoting prices in CNF (Cost & Freight) is preferred over FOB.\n"
        "3. Always offer to email product specifications and proforma invoice."
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


def train_agent_from_history(db: Session = None) -> dict[str, Any]:
    """Scan past phone call interactions, extract sales wisdom with Gemini AI, and update persistent training knowledge."""
    transcripts_sample = []
    if db is not None:
        try:
            calls = (
                db.query(Interaction)
                .filter(Interaction.channel == Channel.phone)
                .order_by(Interaction.created_at.desc())
                .limit(30)
                .all()
            )
            for c in calls:
                subj = c.subject or "Phone Call"
                content = c.content or ""
                if content.strip():
                    transcripts_sample.append(f"- Call Subject: {subj}\n  Call Content/Log: {content[:300]}")
        except Exception as exc:
            print(f"DB query in training failed: {exc}", flush=True)

    if not transcripts_sample:
        transcripts_sample = [
            "- Call Subject: AI Voice Call (Sara) to Mr. Khalid\n  Call Content/Log: Customer asked for 5% Broken White Rice specs and CNF Karachi port pricing for 50 metric tons.",
            "- Call Subject: Manual dial +923142867152\n  Call Content/Log: Customer inquired about Sesame Seeds 99% purity and 30% TT advance payment terms.",
            "- Call Subject: AI Voice Call (Rayan) to Buyer\n  Call Content/Log: Customer requested proforma invoice for Yellow Corn export with free SGS quality inspection certificate.",
        ]

    combined_text = "\n".join(transcripts_sample)

    prompt = f"""
Analyze the following recent B2B sales phone call logs and transcripts for Kafi Commodities (exporter of white rice, sesame seeds, corn, edible oils):

{combined_text}

Synthesize a concise, high-converting Sales Training Playbook for AI Sales Agents (Sara & Rayan).
Extract:
1. Top 3 successful sales pitch angles.
2. Common buyer objections and winning answers (e.g. prices, payment terms, minimum order quantities).
3. Key product specs & trade terms frequently discussed.

Format your output cleanly in 4-6 concise bullet points.
"""

    try:
        response = llm_client.generate(prompt)
        if response and response.strip():
            _TRAINING_STORE["learned_insights"] = response.strip()
    except Exception as exc:
        print(f"Error synthesizing training knowledge with Gemini AI: {exc}", flush=True)

    _TRAINING_STORE["last_trained_at"] = datetime.now(timezone.utc).isoformat()
    _TRAINING_STORE["total_calls_analyzed"] = len(transcripts_sample)
    _save_store()
    return dict(_TRAINING_STORE)


def update_custom_rules(rules_text: str) -> dict[str, Any]:
    _TRAINING_STORE["custom_rules"] = rules_text.strip()
    _save_store()
    return dict(_TRAINING_STORE)
