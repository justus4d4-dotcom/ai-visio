"""Self-update endpoints backing the frontend "Update" settings section."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import updates
from app.schemas import UpdateApplyResult, UpdateProgress, UpdateStatus

router = APIRouter(prefix="/api/updates", tags=["updates"])


class ApplyRequest(BaseModel):
    # Release tag to update to. Omit to take the latest published release.
    target: str | None = None


@router.get("/status", response_model=UpdateStatus)
def status() -> UpdateStatus:
    return updates.get_status()


@router.get("/progress", response_model=UpdateProgress)
def progress() -> UpdateProgress:
    return updates.progress()


@router.post("/apply", response_model=UpdateApplyResult)
def apply(req: ApplyRequest) -> UpdateApplyResult:
    try:
        target = updates.apply_update(req.target)
    except updates.UpdateError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return UpdateApplyResult(started=True, target=target, detail="Update started.")
