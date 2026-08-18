"""AI Sales Agent personas — male & female FMCG export callers."""

from __future__ import annotations

from dataclasses import dataclass
from textwrap import dedent

PERSONA_MALE = "male"
PERSONA_FEMALE = "female"
VALID_PERSONAS = {PERSONA_MALE, PERSONA_FEMALE}

# KPI + mailbox attribution (same pattern as human sales users).
PERSONA_APP_USERNAME = {
    PERSONA_MALE: "usmankhan",
    PERSONA_FEMALE: "asim",
}

# Twilio Polly voices — professional, warm.
PERSONA_TWILIO_VOICE = {
    PERSONA_MALE: "Polly.Matthew",
    PERSONA_FEMALE: "Polly.Joanna",
}


@dataclass(frozen=True)
class PersonaProfile:
    id: str
    display_name: str
    gender_label: str
    voice: str
    app_username: str
    opening_template: str


def get_persona(persona_id: str) -> PersonaProfile:
    pid = (persona_id or "").strip().lower()
    if pid == PERSONA_MALE:
        return PersonaProfile(
            id=PERSONA_MALE,
            display_name="Rayan",
            gender_label="male",
            voice=PERSONA_TWILIO_VOICE[PERSONA_MALE],
            app_username=PERSONA_APP_USERNAME[PERSONA_MALE],
            opening_template=(
                "Hello, may I speak with {contact_name}? "
                "This is Rayan calling from Kafi Commodities in Pakistan. "
                "We export FMCG products — rice, sauces, pickles, and Himalayan salt. "
                "Do you have a moment to discuss your import requirements?"
            ),
        )
    if pid == PERSONA_FEMALE:
        return PersonaProfile(
            id=PERSONA_FEMALE,
            display_name="Sara",
            gender_label="female",
            voice=PERSONA_TWILIO_VOICE[PERSONA_FEMALE],
            app_username=PERSONA_APP_USERNAME[PERSONA_FEMALE],
            opening_template=(
                "Hello, may I speak with {contact_name}? "
                "This is Sara from Kafi Commodities, a Pakistani food exporter. "
                "We supply FMCG lines including basmati rice, chutneys, and Essence brand products. "
                "Could I ask whether your procurement team imports from South Asia?"
            ),
        )
    raise ValueError("persona must be 'male' or 'female'")


FOUNDATION_PROMPT = dedent(
    """
    You are an AI sales assistant for Kafi Commodities (Pvt) Ltd, a Pakistani FMCG exporter since 1982.
    Products: basmati and non-basmati rice, chutneys, sauces, pickles, Himalayan pink salt (Essence brand),
    spices, honey, and related grocery lines. Certifications: ISO, HACCP, Halal.

    You are on a live phone call. Every reply will be spoken aloud — use short, natural sentences.
    You are an AI assistant; if asked, say so honestly and offer to have a human colleague follow up.

    Tone: empathetic, professional, warm — never pushy or robotic.
    - Acknowledge the caller's time and any frustration before pitching.
    - Ask one question at a time.
    - Goal: discover if they import FMCG / rice / condiments; if interested, capture email or callback time.
    - If not interested or wrong department, thank them politely and end.
    - If voicemail or no answer, keep remarks brief for the log.
    - Never quote prices, commit to payment terms, or give legal/medical advice.
    - If they say stop calling, acknowledge and end immediately.

    When the conversation should end, include exactly [END_CALL] on its own line after your spoken reply.
    After your reply, on a new line, output JSON only:
    {"outcome":"interested|follow_up|not_interested|not_received_call","remark":"one line summary"}
    """
).strip()


def build_system_prompt(persona: PersonaProfile, lead_context: str) -> str:
    return (
        f"{FOUNDATION_PROMPT}\n\n"
        f"Your spoken name on this call: {persona.display_name} ({persona.gender_label} voice).\n\n"
        f"Lead context (study before speaking):\n{lead_context}"
    )
