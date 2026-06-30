"""History persistence helpers.

The app is single-user (no auth), so all history rows are attached to one
singleton "local" user that satisfies the answers.user_id foreign key.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app import models
from app.schemas import SolveResult

LOCAL_USER_ID = "local"


def ensure_local_user(db: Session) -> str:
    """Create the singleton local user on first use; return its id."""
    user = db.get(models.User, LOCAL_USER_ID)
    if user is None:
        db.add(models.User(id=LOCAL_USER_ID, email="local@localhost", name="Local"))
        db.commit()
    return LOCAL_USER_ID


def save_answer(db: Session, image_bytes: bytes, result: SolveResult, digest: str) -> None:
    """Persist a solved result (with its source image) to the answers table."""
    ensure_local_user(db)
    row = models.Answer(
        user_id=LOCAL_USER_ID,
        question_text=result.question_text,
        question_type=result.question_type,
        answer_letters=",".join(result.answer_letters) or None,
        answer_text=result.answer_text or None,
        confidence=result.confidence,
        image_png=image_bytes,
        ocr_hash=digest,
        provider_label=result.model,
        tokens_used=result.tokens_used,
    )
    db.add(row)
    db.commit()


def guess_image_mime(data: bytes) -> str:
    """Sniff the stored image bytes so the browser renders them correctly."""
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "application/octet-stream"
