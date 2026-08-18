"""Manual KPI — WhatsApp status + bulk email columns.

Revision ID: 050_manual_kpi_whatsapp_bulk
Revises: 049_ai_sales_agent_tasks
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "050_manual_kpi_whatsapp_bulk"
down_revision: Union[str, None] = "049_ai_sales_agent_tasks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "manual_kpi_entries",
        sa.Column("whatsapp_status", sa.String(length=40), nullable=True),
    )
    op.add_column(
        "manual_kpi_entries",
        sa.Column("bulk_emails_sent", sa.Integer(), nullable=True),
    )
    op.add_column(
        "manual_kpi_entries",
        sa.Column("bulk_email_country", sa.String(length=120), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("manual_kpi_entries", "bulk_email_country")
    op.drop_column("manual_kpi_entries", "bulk_emails_sent")
    op.drop_column("manual_kpi_entries", "whatsapp_status")
