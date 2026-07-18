"""M7 History: list / fetch / delete persisted question-answer records."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import models
from app.database import get_db
from app.history_store import LOCAL_USER_ID, guess_image_mime
from app.schemas import HistoryItem

router = APIRouter(prefix="/api/history", tags=["history"])


def _to_item(row: models.Answer) -> HistoryItem:
    letters = row.answer_letters.split(",") if row.answer_letters else []
    return HistoryItem(
        id=row.id,
        question_text=row.question_text,
        question_type=row.question_type,
        answer_letters=letters,
        answer_text=row.answer_text,
        full_answer=row.full_answer,
        confidence=row.confidence,
        provider_label=row.provider_label,
        tokens_used=row.tokens_used,
        has_image=row.image_png is not None,
        status=row.status or "success",
        error_type=row.error_type,
        error_detail=row.error_detail,
        elapsed_ms=row.elapsed_ms,
        created_at=row.created_at,
    )


@router.get("", response_model=list[HistoryItem])
def list_history(
    limit: int = 50, offset: int = 0, db: Session = Depends(get_db)
) -> list[HistoryItem]:
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    rows = (
        db.execute(
            select(models.Answer)
            .where(models.Answer.user_id == LOCAL_USER_ID)
            .order_by(models.Answer.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )
    return [_to_item(r) for r in rows]


@router.get("/{answer_id}/image")
def get_image(answer_id: str, db: Session = Depends(get_db)) -> Response:
    row = db.get(models.Answer, answer_id)
    if row is None or row.image_png is None:
        raise HTTPException(status_code=404, detail="No image for this entry")
    return Response(content=row.image_png, media_type=guess_image_mime(row.image_png))


@router.delete("/{answer_id}", status_code=204)
def delete_one(answer_id: str, db: Session = Depends(get_db)) -> Response:
    row = db.get(models.Answer, answer_id)
    if row is not None:
        db.delete(row)
        db.commit()
    return Response(status_code=204)


@router.delete("", status_code=204)
def clear_all(db: Session = Depends(get_db)) -> Response:
    db.execute(delete(models.Answer).where(models.Answer.user_id == LOCAL_USER_ID))
    db.commit()
    return Response(status_code=204)
