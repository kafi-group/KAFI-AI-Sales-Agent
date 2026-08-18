"""AI Sales Agent — assigned outbound call tasks per persona.

Revision ID: 049_ai_sales_agent_tasks
Revises: 048_manual_kpi_entries
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "049_ai_sales_agent_tasks"
down_revision: Union[str, None] = "048_manual_kpi_entries"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_sales_agent_tasks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("persona", sa.String(length=16), nullable=False),
        sa.Column("buyer_id", sa.Integer(), sa.ForeignKey("buyers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("contact_id", sa.Integer(), sa.ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True),
        sa.Column(
            "assigned_by_user_id",
            sa.Integer(),
            sa.ForeignKey("app_users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="pending"),
        sa.Column("interaction_id", sa.Integer(), sa.ForeignKey("interactions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("call_sid", sa.String(length=64), nullable=True),
        sa.Column("outcome", sa.String(length=32), nullable=True),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("transcript", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_ai_sales_agent_tasks_persona", "ai_sales_agent_tasks", ["persona"])
    op.create_index("ix_ai_sales_agent_tasks_status", "ai_sales_agent_tasks", ["status"])
    op.create_index("ix_ai_sales_agent_tasks_buyer_id", "ai_sales_agent_tasks", ["buyer_id"])

    op.create_table(
        "ai_sales_agent_runners",
        sa.Column("persona", sa.String(length=16), primary_key=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="idle"),
        sa.Column("current_task_id", sa.Integer(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("ai_sales_agent_runners")
    op.drop_index("ix_ai_sales_agent_tasks_buyer_id", table_name="ai_sales_agent_tasks")
    op.drop_index("ix_ai_sales_agent_tasks_status", table_name="ai_sales_agent_tasks")
    op.drop_index("ix_ai_sales_agent_tasks_persona", table_name="ai_sales_agent_tasks")
    op.drop_table("ai_sales_agent_tasks")
