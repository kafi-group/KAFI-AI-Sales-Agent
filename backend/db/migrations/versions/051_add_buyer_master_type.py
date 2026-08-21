"""Add master_type column to buyers table.

Revision ID: 051_add_buyer_master_type
Revises: 050_manual_kpi_whatsapp_bulk
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "051_add_buyer_master_type"
down_revision: Union[str, None] = "050_manual_kpi_whatsapp_bulk"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "buyers",
        sa.Column(
            "master_type",
            sa.String(length=50),
            nullable=False,
            server_default="fmcg",
        ),
    )


def downgrade() -> None:
    op.drop_column("buyers", "master_type")
