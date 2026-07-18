"""extend answers into a full request log (Feature 2)

Adds the full free-form answer plus request-outcome columns so every /api/solve
call — success, error, or timeout — can be persisted (with its image) and shown in
the History view.

Revision ID: 0003_request_log
Revises: 0002_usage_events
Create Date: 2026-07-18
"""

from alembic import op
import sqlalchemy as sa

revision = "0003_request_log"
down_revision = "0002_usage_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("answers", sa.Column("full_answer", sa.Text(), nullable=True))
    op.add_column(
        "answers",
        sa.Column("status", sa.String(), nullable=False, server_default="success"),
    )
    op.add_column("answers", sa.Column("error_type", sa.String(), nullable=True))
    op.add_column("answers", sa.Column("error_detail", sa.Text(), nullable=True))
    op.add_column("answers", sa.Column("elapsed_ms", sa.Integer(), nullable=True))
    op.create_index("ix_answers_status", "answers", ["status"])


def downgrade() -> None:
    op.drop_index("ix_answers_status", table_name="answers")
    op.drop_column("answers", "elapsed_ms")
    op.drop_column("answers", "error_detail")
    op.drop_column("answers", "error_type")
    op.drop_column("answers", "status")
    op.drop_column("answers", "full_answer")
