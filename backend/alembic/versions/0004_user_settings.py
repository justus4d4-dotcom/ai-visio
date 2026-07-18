"""per-account settings store

Holds each signed-in user's main-app / camera / display settings as a Fernet-encrypted
JSON blob so they sync across devices.

Revision ID: 0004_user_settings
Revises: 0003_request_log
Create Date: 2026-07-18
"""

from alembic import op
import sqlalchemy as sa

revision = "0004_user_settings"
down_revision = "0003_request_log"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_settings",
        sa.Column("user_key", sa.String(), primary_key=True),
        sa.Column("data_encrypted", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("user_settings")
