"""admin-managed allowlist

Creates the ``allowed_emails`` table used by the admin portal to invite users and grant
the admin role, supplementing the ``ALLOWED_EMAILS`` / ``BOOTSTRAP_ADMINS`` env config.

Written defensively (idempotent): some deployments already have an ``allowed_emails``
table (e.g. provisioned via an early ``create_all`` before this migration existed), so we
create the table / column / index only when missing instead of failing.

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
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    if "allowed_emails" not in tables:
        op.create_table(
            "allowed_emails",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("email", sa.String(), nullable=False),
            sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("added_by", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
    else:
        # Table already exists — ensure the columns this app needs are present.
        cols = {c["name"] for c in insp.get_columns("allowed_emails")}
        if "is_admin" not in cols:
            op.add_column(
                "allowed_emails",
                sa.Column(
                    "is_admin", sa.Boolean(), nullable=False, server_default=sa.false()
                ),
            )
        if "added_by" not in cols:
            op.add_column(
                "allowed_emails", sa.Column("added_by", sa.String(), nullable=True)
            )

    # Create the unique index on email only if it isn't there yet.
    insp = sa.inspect(bind)
    index_names = {ix["name"] for ix in insp.get_indexes("allowed_emails")}
    if "ix_allowed_emails_email" not in index_names:
        op.create_index(
            "ix_allowed_emails_email", "allowed_emails", ["email"], unique=True
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "allowed_emails" in set(insp.get_table_names()):
        index_names = {ix["name"] for ix in insp.get_indexes("allowed_emails")}
        if "ix_allowed_emails_email" in index_names:
            op.drop_index("ix_allowed_emails_email", table_name="allowed_emails")
        op.drop_table("allowed_emails")
