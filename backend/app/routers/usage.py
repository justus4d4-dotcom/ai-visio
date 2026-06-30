"""Monitoring: LLM usage + estimated cost summary for the dashboard."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import usage_store
from app.database import get_db
from app.schemas import UsageSummary

router = APIRouter(prefix="/api/usage", tags=["usage"])


@router.get("/summary", response_model=UsageSummary)
def usage_summary(db: Session = Depends(get_db)) -> UsageSummary:
    return usage_store.get_summary(db)
