"""initial schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-06-30
"""

from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("image", sa.String(), nullable=True),
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "allowed_emails",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("added_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_allowed_emails_email", "allowed_emails", ["email"], unique=True)

    op.create_table(
        "provider_keys",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("base_url", sa.String(), nullable=True),
        sa.Column("model", sa.String(), nullable=False, server_default="gpt-4o-mini"),
        sa.Column("api_version", sa.String(), nullable=True),
        sa.Column("encrypted_key", sa.Text(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", "label", name="uq_user_label"),
    )

    op.create_table(
        "devices",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False, server_default="Round display"),
        sa.Column("ip_address", sa.String(), nullable=True),
        sa.Column("device_token", sa.String(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_devices_device_token", "devices", ["device_token"])

    op.create_table(
        "answers",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("question_text", sa.Text(), nullable=False),
        sa.Column("options_text", sa.Text(), nullable=True),
        sa.Column("question_type", sa.String(), nullable=False, server_default="single"),
        sa.Column("answer_letters", sa.String(), nullable=True),
        sa.Column("answer_text", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("image_png", sa.LargeBinary(), nullable=True),
        sa.Column("ocr_hash", sa.String(), nullable=True),
        sa.Column("provider_label", sa.String(), nullable=True),
        sa.Column("tokens_used", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_answers_user_id", "answers", ["user_id"])
    op.create_index("ix_answers_ocr_hash", "answers", ["ocr_hash"])
    op.create_index("ix_answers_created_at", "answers", ["created_at"])


def downgrade() -> None:
    op.drop_table("answers")
    op.drop_table("devices")
    op.drop_table("provider_keys")
    op.drop_table("allowed_emails")
    op.drop_table("users")
