"""Add ai_training_selected flag on phone call interactions for Sara/Rayan training.

Revision ID: 050_ai_training_selected
Revises: 049_personal_whatsapp_user

NOTE: Do NOT create an index here — indexing a busy interactions table takes an
ACCESS EXCLUSIVE-style lock long enough for Railway to 502 (app never boots).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect, text

revision: str = "050_ai_training_selected"
down_revision: Union[str, None] = "049_personal_whatsapp_user"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("interactions")}
    if "ai_training_selected" not in cols:
        # Fast ADD COLUMN … DEFAULT on Postgres 11+ (no full-table rewrite).
        bind.execute(
            text(
                "ALTER TABLE interactions "
                "ADD COLUMN IF NOT EXISTS ai_training_selected "
                "BOOLEAN NOT NULL DEFAULT FALSE"
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("interactions")}
    if "ai_training_selected" in cols:
        op.drop_column("interactions", "ai_training_selected")
