"""Move leads from one master list (FMCG / Minerals & Ores / Other Items ...) to another.

A lead's master list is just ``Buyer.master_type``. Everything else about the lead — its contacts,
emails and SMTP history, calls, WhatsApp / Telegram messages, assignment, remarks, interactions and
the section it sits in (sections are shared by every master list) — hangs off ``buyer_id`` /
``Buyer.source`` and is NOT touched. Only ``master_type`` changes, so the move can be undone by
moving the same leads back.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from db.models import Buyer

logger = logging.getLogger(__name__)

MAX_LEADS_PER_MOVE = 5000


def _norm(value: str | None) -> str:
    return (value or "").strip().lower()


def move_leads_to_master_list(
    db: Session,
    *,
    lead_ids: list[int],
    target_master_type: str,
    by_username: str | None = None,
) -> dict[str, Any]:
    from modules import org_admin_config as org
    from modules.audit import log_action
    from modules.leads import invalidate_section_counts_cache

    ids: list[int] = []
    seen: set[int] = set()
    for raw in lead_ids:
        try:
            lead_id = int(raw)
        except (TypeError, ValueError):
            continue
        if lead_id > 0 and lead_id not in seen:
            seen.add(lead_id)
            ids.append(lead_id)
    if not ids:
        raise ValueError("Select at least one lead to move")
    if len(ids) > MAX_LEADS_PER_MOVE:
        raise ValueError(f"Too many leads in one move (max {MAX_LEADS_PER_MOVE}). Narrow your selection.")

    target = _norm(target_master_type)
    lists = {row["key"]: row for row in org.get_master_lists(include_disabled=False)}
    if target not in lists:
        raise ValueError("That master list does not exist or is disabled")
    target_label = str(lists[target].get("label") or target)

    buyers = db.query(Buyer).filter(Buyer.id.in_(ids)).all()

    previous: dict[str, list[int]] = {}
    moved_ids: list[int] = []
    already_there = 0
    for buyer in buyers:
        old = _norm(buyer.master_type) or "fmcg"
        if old == target:
            already_there += 1
            continue
        buyer.master_type = target
        previous.setdefault(old, []).append(buyer.id)
        moved_ids.append(buyer.id)

    if moved_ids:
        db.commit()
        invalidate_section_counts_cache()
        try:
            log_action(
                db,
                entity_type="buyer",
                entity_id=0,
                action="move_leads_to_master_list",
                actor=by_username,
                details={
                    "target_master_type": target,
                    "previous_master_types": previous,  # undo = move each group back
                    "lead_ids": moved_ids,
                },
            )
        except Exception:  # noqa: BLE001 - the move itself already succeeded
            logger.exception("Could not write the audit entry for a master-list move")

    return {
        "updated_count": len(moved_ids),
        "updated_ids": moved_ids,
        "requested_count": len(ids),
        "already_in_target": already_there,
        "missing": len(ids) - len(buyers),
        "target_master_type": target,
        "target_label": target_label,
    }
