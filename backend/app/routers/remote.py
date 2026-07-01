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
from collections import OrderedDict

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, WebSocket, WebSocketDisconnect
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

# Which capture source currently answers triggers:
#   "browser" — the Next.js tab holding a getDisplayMedia share (default)
#   "agent"   — the native macOS Python agent (streams the whole screen)
# Only one source consumes triggers at a time so a frame is never solved twice.
#
# In "agent" mode the agent only *records* the screen and pushes frames here; the
# browser (which holds the BYOK Gemini key) solves the latest frame on a trigger. So
# the agent never needs the API key.
_capture: dict[str, object] = {
    "source": "browser",
    "frame": None,            # bytes | None — latest screen frame from the owner agent
    "frame_at": None,         # datetime | None
    "frame_ct": "image/jpeg",  # content type of the stored frame
}

# Every running agent process reports a unique `instance` id on its heartbeats and frame
# uploads. We track them here so we can (a) count how many agents are live and (b) accept
# frames from only ONE of them — the "owner". Without this, two agents on the same Mac
# overwrite the single shared frame slot ~1 fps apart, which the browser sees as a flicker
# between their two screens (e.g. one has macOS Screen Recording permission and shows app
# windows while the other does not and shows only the bare desktop wallpaper).
_agents: "OrderedDict[str, dict[str, object]]" = OrderedDict()

# Heartbeats arrive every ~2s and frames at ~1 fps. Keep the online window short so a
# stopped agent clears within a few seconds, and keep the frame-stale window <= the online
# window so a frozen preview disappears just before the "offline" flag flips.
AGENT_ONLINE_WINDOW = dt.timedelta(seconds=5)
FRAME_STALE_WINDOW = dt.timedelta(seconds=4)


def _live_agents() -> list[str]:
    """Instance ids of agents seen within AGENT_ONLINE_WINDOW (oldest first). Prunes stale."""
    now = dt.datetime.now(dt.timezone.utc)
    stale = [
        iid
        for iid, meta in _agents.items()
        if now - meta["last_seen"] >= AGENT_ONLINE_WINDOW  # type: ignore[operator]
    ]
    for iid in stale:
        _agents.pop(iid, None)
    return list(_agents.keys())


def _owner() -> str | None:
    """The single agent whose frames drive the preview: the oldest still-live instance."""
    live = _live_agents()
    return live[0] if live else None


def _touch_agent(iid: str, host: str | None) -> None:
    now = dt.datetime.now(dt.timezone.utc)
    meta = _agents.get(iid)
    if meta is None:
        _agents[iid] = {"last_seen": now, "host": host}
    else:
        meta["last_seen"] = now
        if host:
            meta["host"] = host


def _frame_fresh() -> bool:
    at = _capture["frame_at"]
    if not isinstance(at, dt.datetime) or not _capture["frame"]:
        return False
    return (dt.datetime.now(dt.timezone.utc) - at) < FRAME_STALE_WINDOW


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


class SourceUpdate(BaseModel):
    source: str  # "browser" | "agent"


class SourceState(BaseModel):
    source: str
    agent_online: bool
    agent_host: str | None = None
    frame_ready: bool = False
    agent_count: int = 0


class AgentHeartbeat(BaseModel):
    host: str | None = None
    instance: str | None = None


class HeartbeatResponse(BaseModel):
    source: str
    active: bool  # True when the agent is the selected capture source


@router.get("/source", response_model=SourceState)
def get_source() -> SourceState:
    """Current capture source + whether a native agent is alive (for the web UI)."""
    live = _live_agents()
    owner = live[0] if live else None
    host = _agents[owner]["host"] if owner else None
    return SourceState(
        source=str(_capture["source"]),
        agent_online=bool(live),
        agent_host=host,  # type: ignore[arg-type]
        frame_ready=_frame_fresh(),
        agent_count=len(live),
    )


@router.post("/source", response_model=SourceState)
def set_source(update: SourceUpdate) -> SourceState:
    """Choose which capture source answers triggers: browser tab or native agent."""
    if update.source not in ("browser", "agent"):
        raise HTTPException(status_code=422, detail="source must be 'browser' or 'agent'")
    _capture["source"] = update.source
    return get_source()


@router.post("/agent/heartbeat", response_model=HeartbeatResponse)
def agent_heartbeat(hb: AgentHeartbeat) -> HeartbeatResponse:
    """The native agent calls this every few seconds to report it is alive.

    Only the elected *owner* agent is told it is `active`; any extra agents are asked to
    stand down so they stop streaming frames and never fight over the shared preview.
    """
    iid = hb.instance or "default"
    _touch_agent(iid, hb.host)
    return HeartbeatResponse(
        source=str(_capture["source"]),
        active=_capture["source"] == "agent" and _owner() == iid,
    )


@router.post("/frame")
async def upload_frame(
    image: UploadFile = File(...),
    instance: str | None = Form(default=None),
) -> dict[str, object]:
    """The native agent pushes the latest screen frame here (no API key needed).

    The browser fetches this frame with GET /frame and does the Gemini solve using its
    own BYOK key, so the agent only ever *records* the screen. Frames from non-owner
    agents are ignored so a second running agent can't flicker the preview.
    """
    iid = instance or "default"
    _touch_agent(iid, None)
    owner = _owner()
    if owner is not None and iid != owner:
        return {"ok": True, "ignored": True}
    data = await image.read()
    _capture["frame"] = data
    _capture["frame_ct"] = image.content_type or "image/jpeg"
    _capture["frame_at"] = dt.datetime.now(dt.timezone.utc)
    return {"ok": True, "bytes": len(data)}


@router.get("/frame")
def get_frame() -> Response:
    """Return the latest frame pushed by the agent (used by the browser to solve)."""
    if not _frame_fresh():
        raise HTTPException(status_code=404, detail="no fresh agent frame")
    return Response(
        content=bytes(_capture["frame"]),  # type: ignore[arg-type]
        media_type=str(_capture["frame_ct"]),
    )


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
