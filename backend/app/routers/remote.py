"""Remote-control bridge for the ESP32 touch display.

The screenshot lives in the browser (it holds the MacBook screen share), so a device
cannot capture it directly. Instead:

  1. ESP32 touch  ->  POST /api/remote/trigger          (status: requested)
  2. browser polls    GET  /api/remote/poll  -> {triggered: true}; it then captures a
     frame, solves it, and posts the answer back:
  3. browser      ->  POST /api/remote/status (solving) then POST /api/remote/answer
  4. ESP32 polls      GET  /api/remote/answer -> {status, answer_id, answer}

This is an in-memory single-session bridge for M3. It is superseded by per-device
WebSocket push in M8.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter
from pydantic import BaseModel

from app.schemas import SolveResult

router = APIRouter(prefix="/api/remote", tags=["remote"])

# Status: idle | requested | solving | done | error
_state: dict[str, object] = {
    "status": "idle",
    "pending": False,
    "trigger_id": None,
    "answer_id": None,
    "answer": None,
}


class TriggerResponse(BaseModel):
    ok: bool
    trigger_id: str


class PollResponse(BaseModel):
    triggered: bool
    trigger_id: str | None = None


class StatusUpdate(BaseModel):
    status: str  # "solving" | "error"


class RemoteState(BaseModel):
    status: str
    answer_id: str | None = None
    answer: SolveResult | None = None


@router.post("/trigger", response_model=TriggerResponse)
def trigger() -> TriggerResponse:
    """Called by the ESP32 when the screen is touched."""
    tid = str(uuid.uuid4())
    _state["pending"] = True
    _state["trigger_id"] = tid
    _state["status"] = "requested"
    return TriggerResponse(ok=True, trigger_id=tid)


@router.get("/poll", response_model=PollResponse)
def poll() -> PollResponse:
    """Called by the browser to learn whether a touch is pending. Clears the flag."""
    if _state["pending"]:
        _state["pending"] = False
        return PollResponse(triggered=True, trigger_id=_state["trigger_id"])  # type: ignore[arg-type]
    return PollResponse(triggered=False)


@router.post("/status", response_model=RemoteState)
def set_status(update: StatusUpdate) -> RemoteState:
    """Browser reports it is solving (or hit an error)."""
    _state["status"] = update.status
    return _current()


@router.post("/answer", response_model=RemoteState)
def post_answer(answer: SolveResult) -> RemoteState:
    """Browser posts the solved answer; ESP32 will pick it up on its next poll."""
    _state["answer"] = answer.model_dump()
    _state["answer_id"] = str(uuid.uuid4())
    _state["status"] = "done"
    return _current()


@router.get("/answer", response_model=RemoteState)
def get_answer() -> RemoteState:
    """Called by the ESP32 to render the latest status/answer."""
    return _current()


def _current() -> RemoteState:
    ans = _state["answer"]
    return RemoteState(
        status=str(_state["status"]),
        answer_id=_state["answer_id"],  # type: ignore[arg-type]
        answer=SolveResult(**ans) if ans else None,  # type: ignore[arg-type]
    )
