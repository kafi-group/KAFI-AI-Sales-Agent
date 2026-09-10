"""Add ai_training_selected flag on phone call interactions for Sara/Rayan training.

Revision ID: 050_ai_training_selected
Revises: 049_personal_whatsapp_user
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "050_ai_training_selected"
down_revision: Union[str, None] = "049_personal_whatsapp_user"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("interactions")}
    if "ai_training_selected" not in cols:
        op.add_column(
            "interactions",
            sa.Column(
                "ai_training_selected",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )
    indexes = {i["name"] for i in inspector.get_indexes("interactions")}
    if "ix_interactions_ai_training_selected" not in indexes:
        op.create_index(
            "ix_interactions_ai_training_selected",
            "interactions",
            ["ai_training_selected"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    indexes = {i["name"] for i in inspector.get_indexes("interactions")}
    if "ix_interactions_ai_training_selected" in indexes:
        op.drop_index(
            "ix_interactions_ai_training_selected",
            table_name="interactions",
        )
    cols = {c["name"] for c in inspector.get_columns("interactions")}
    if "ai_training_selected" in cols:
        op.drop_column("interactions", "ai_training_selected")
