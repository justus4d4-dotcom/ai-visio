"""History persistence helpers.

The app is single-user (no auth), so all history rows are attached to one
singleton "local" user that satisfies the answers.user_id foreign key.

Since Feature 2 the answers table doubles as a request log: every /api/solve call is
persisted — success, error, or timeout — together with its source image, and the table
is auto-pruned so it cannot grow without bound.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import models
from app.config import settings
from app.schemas import SolveResult

LOCAL_USER_ID = "local"


def ensure_local_user(db: Session) -> str:
    """Create the singleton local user on first use; return its id."""
    user = db.get(models.User, LOCAL_USER_ID)
    if user is None:
        db.add(models.User(id=LOCAL_USER_ID, email="local@localhost", name="Local"))
        db.commit()
    return LOCAL_USER_ID


def save_request(
    db: Session,
    image_bytes: bytes | None,
    digest: str,
    *,
    result: SolveResult | None = None,
    status: str = "success",
    error_type: str | None = None,
    error_detail: str | None = None,
    elapsed_ms: int | None = None,
    provider_label: str | None = None,
) -> None:
    """Persist one /api/solve request — success or failure — as a log/history row.

    ``result`` carries the answer fields for a successful solve; for a failure it is
    ``None`` and ``error_type``/``error_detail`` describe why it failed.
    """
    ensure_local_user(db)
    row = models.Answer(
        user_id=LOCAL_USER_ID,
        question_text=result.question_text if result else "",
        question_type=result.question_type if result else "unknown",
        answer_letters=(",".join(result.answer_letters) or None) if result else None,
        answer_text=(result.answer_text or None) if result else None,
        full_answer=(result.full_answer or None) if result else None,
        confidence=result.confidence if result else None,
        image_png=image_bytes,
        ocr_hash=digest,
        provider_label=(result.model if result else provider_label),
        tokens_used=result.tokens_used if result else None,
        status=status,
        error_type=error_type,
        error_detail=(error_detail[:2000] if error_detail else None),
        elapsed_ms=(result.elapsed_ms if result and result.elapsed_ms else elapsed_ms),
    )
    db.add(row)
    db.commit()
    prune(db)


def prune(db: Session) -> None:
    """Enforce the retention policy (best-effort): drop rows older than the retention
    window and cap the total number of logged requests."""
    try:
        if settings.history_retention_days > 0:
            cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(
                days=settings.history_retention_days
            )
            db.execute(delete(models.Answer).where(models.Answer.created_at < cutoff))
        if settings.history_max_rows > 0:
            total = db.execute(select(func.count(models.Answer.id))).scalar_one()
            excess = int(total) - settings.history_max_rows
            if excess > 0:
                old_ids = (
                    db.execute(
                        select(models.Answer.id)
                        .order_by(models.Answer.created_at.asc())
                        .limit(excess)
                    )
                    .scalars()
                    .all()
                )
                if old_ids:
                    db.execute(
                        delete(models.Answer).where(models.Answer.id.in_(old_ids))
                    )
        db.commit()
    except Exception:  # noqa: BLE001 - pruning must never break a solve
        db.rollback()


def guess_image_mime(data: bytes) -> str:
    """Sniff the stored image bytes so the browser renders them correctly."""
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "application/octet-stream"
