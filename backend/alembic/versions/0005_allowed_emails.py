"""admin-managed allowlist

Creates the ``allowed_emails`` table used by the admin portal to invite users and grant
the admin role, supplementing the ``ALLOWED_EMAILS`` / ``BOOTSTRAP_ADMINS`` env config.

Revision ID: 0005_allowed_emails
Revises: 0004_user_settings
Create Date: 2026-07-18
"""

from alembic import op
import sqlalchemy as sa

revision = "0005_allowed_emails"
down_revision = "0004_user_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "allowed_emails",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("added_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_allowed_emails_email", "allowed_emails", ["email"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_allowed_emails_email", table_name="allowed_emails")
    op.drop_table("allowed_emails")
