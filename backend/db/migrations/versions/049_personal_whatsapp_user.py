"""Tag personal Baileys WhatsApp messages with the Sales Agent user.

Revision ID: 049_personal_whatsapp_user
Revises: 048_manual_kpi_entries
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "049_personal_whatsapp_user"
down_revision: Union[str, None] = "048_manual_kpi_entries"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "interactions",
        sa.Column("personal_whatsapp_user_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_interactions_personal_whatsapp_user_id",
        "interactions",
        ["personal_whatsapp_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_interactions_personal_whatsapp_user_id", table_name="interactions")
    op.drop_column("interactions", "personal_whatsapp_user_id")
