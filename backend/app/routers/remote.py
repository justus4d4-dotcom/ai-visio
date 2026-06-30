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

import datetime as dt
import json
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
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


class DeviceHub:
    """Tracks connected ESP32 WebSocket clients and pushes answers to them."""

    def __init__(self) -> None:
        self._conns: dict[str, WebSocket] = {}
        self._meta: dict[str, dict[str, object]] = {}

    async def connect(self, ws: WebSocket) -> str:
        await ws.accept()
        cid = str(uuid.uuid4())
        self._conns[cid] = ws
        self._meta[cid] = {
            "id": cid,
            "remote": ws.client.host if ws.client else None,
            "connected_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        return cid

    def disconnect(self, cid: str) -> None:
        self._conns.pop(cid, None)
        self._meta.pop(cid, None)

    async def broadcast(self, message: dict[str, object]) -> None:
        for cid, ws in list(self._conns.items()):
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001 - drop dead sockets
                self.disconnect(cid)

    @property
    def count(self) -> int:
        return len(self._conns)

    def devices(self) -> list[dict[str, object]]:
        return list(self._meta.values())


hub = DeviceHub()


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
async def set_status(update: StatusUpdate) -> RemoteState:
    """Browser reports it is solving (or hit an error); pushed to connected devices."""
    _state["status"] = update.status
    state = _current()
    await hub.broadcast({"type": "status", **state.model_dump()})
    return state


@router.post("/answer", response_model=RemoteState)
async def post_answer(answer: SolveResult) -> RemoteState:
    """Browser posts the solved answer; pushed instantly to connected devices."""
    _state["answer"] = answer.model_dump()
    _state["answer_id"] = str(uuid.uuid4())
    _state["status"] = "done"
    state = _current()
    await hub.broadcast({"type": "answer", **state.model_dump()})
    return state


@router.get("/answer", response_model=RemoteState)
def get_answer() -> RemoteState:
    """Called by the ESP32 to render the latest status/answer."""
    return _current()


@router.get("/devices")
def list_devices() -> dict[str, object]:
    """Connected device count + metadata, for the web UI status indicator."""
    return {"count": hub.count, "devices": hub.devices()}


@router.websocket("/ws")
async def device_ws(ws: WebSocket) -> None:
    """ESP32 connects here to receive pushed answers and send touch triggers."""
    cid = await hub.connect(ws)
    try:
        # Send current state immediately so a freshly-connected device syncs.
        await ws.send_json({"type": "state", **_current().model_dump()})
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "trigger":
                # A touch on the device: mark pending so the browser solves the frame.
                _state["pending"] = True
                _state["trigger_id"] = str(uuid.uuid4())
                _state["status"] = "requested"
    except WebSocketDisconnect:
        hub.disconnect(cid)
    except Exception:  # noqa: BLE001
        hub.disconnect(cid)


def _current() -> RemoteState:
    ans = _state["answer"]
    return RemoteState(
        status=str(_state["status"]),
        answer_id=_state["answer_id"],  # type: ignore[arg-type]
        answer=SolveResult(**ans) if ans else None,  # type: ignore[arg-type]
    )
