"""Database models."""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    image: Mapped[str | None] = mapped_column(String, nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now)

    provider_keys: Mapped[list[ProviderKey]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    devices: Mapped[list[Device]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class AllowedEmail(Base):
    """Whitelist of emails permitted to sign in. Managed in the admin portal."""

    __tablename__ = "allowed_emails"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    added_by: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ProviderKey(Base):
    """A per-user BYOK credential for a given provider."""

    __tablename__ = "provider_keys"
    __table_args__ = (UniqueConstraint("user_id", "label", name="uq_user_label"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    label: Mapped[str] = mapped_column(String)  # friendly name
    provider: Mapped[str] = mapped_column(String)  # openai | azure | compatible
    base_url: Mapped[str | None] = mapped_column(String, nullable=True)
    model: Mapped[str] = mapped_column(String, default="gpt-4o-mini")
    api_version: Mapped[str | None] = mapped_column(String, nullable=True)  # azure
    encrypted_key: Mapped[str] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now)

    user: Mapped[User] = relationship(back_populates="provider_keys")


class Device(Base):
    """A configured ESP32 display."""

    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String, default="Round display")
    ip_address: Mapped[str | None] = mapped_column(String, nullable=True)
    device_token: Mapped[str] = mapped_column(String, default=_uuid, index=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now)

    user: Mapped[User] = relationship(back_populates="devices")


class Answer(Base):
    """Persisted question/answer history, including the source image."""

    __tablename__ = "answers"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    question_text: Mapped[str] = mapped_column(Text)
    options_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    question_type: Mapped[str] = mapped_column(String, default="single")
    answer_letters: Mapped[str | None] = mapped_column(String, nullable=True)  # "A" or "A,C"
    answer_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Full free-form answer shown on the tablet/browser (Feature 1+3).
    full_answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    image_png: Mapped[bytes | None] = mapped_column(nullable=True)
    ocr_hash: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    provider_label: Mapped[str | None] = mapped_column(String, nullable=True)
    tokens_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Request-log fields (Feature 2): every /api/solve is recorded, success or failure.
    status: Mapped[str] = mapped_column(String, default="success", index=True)  # success|error|timeout
    error_type: Mapped[str | None] = mapped_column(String, nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class UsageEvent(Base):
    """One metered LLM call, used for the cost / token-usage monitoring dashboard.

    A row is written for every solve — including cache hits (cost 0) — so the totals
    reflect real API spend vs. money saved by the dedup cache.
    """

    __tablename__ = "usage_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    model: Mapped[str] = mapped_column(String, index=True)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    cached: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
