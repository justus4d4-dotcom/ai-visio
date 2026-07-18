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
    # What a pending trigger asks the browser to do: "solve" a question (default) or
    # "scenario" (capture + transcribe a case-study screen; see the case-study flow).
    "action": "solve",
    "answer_id": None,
    "answer": None,
    # Rolling count of case-study scenario screens captured in the current session.
    "scenario_count": 0,
}

# Current ESP32 display preferences (pushed from Settings → Device & Display). Broadcast on
# change and sent to each device on connect so a freshly-booted device picks them up.
_display: dict[str, object] = {
    "brightness": 200,
    "text_size": "medium",
    "show_confidence": True,
    "show_subtext": True,
    "show_cached_badge": True,
}


def set_display(cfg: dict) -> dict:
    """Update the stored display config with any provided keys and return the full config."""
    for key in _display:
        if key in cfg and cfg[key] is not None:
            _display[key] = cfg[key]
    return dict(_display)

# Which capture source currently answers triggers:
#   "agent"   — the native macOS Python agent (streams the whole screen) — default
#   "browser" — the Next.js tab holding a getDisplayMedia share
#   "camera"  — an iPhone (or any phone) pointing its rear camera at the screen; the
#               mobile capture page (/camera) streams JPEG frames to the backend
# Only one source consumes triggers at a time so a frame is never solved twice.
#
# In "agent"/"camera" modes the source only *records* the screen and pushes frames here;
# the browser (which holds the BYOK Gemini key) solves the latest frame on a trigger. So
# neither the agent nor the phone ever needs the API key.
_CAPTURE_SOURCES = ("browser", "agent", "camera")

_capture: dict[str, object] = {
    "source": "agent",
    "frame": None,            # bytes | None — latest screen frame from the owner agent
    "frame_at": None,         # datetime | None
    "frame_ct": "image/jpeg",  # content type of the stored frame
}

# The iPhone camera source keeps its own frame slot, separate from the agent's, so a
# running native agent and a phone can be swapped without one clobbering the other's
# preview. The phone already crops/deskews the screen out of its camera view before
# pushing (see the /camera mobile page), so the backend just relays the JPEG as-is.
_camera: dict[str, object] = {
    "frame": None,            # bytes | None — latest cropped screen frame from the phone
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


# The phone streams at ~1-2 fps but a hand-held camera can drop frames briefly; give it a
# slightly longer stale window than the agent so the preview doesn't blink on a hiccup.
CAMERA_STALE_WINDOW = dt.timedelta(seconds=6)


def _camera_fresh() -> bool:
    at = _camera["frame_at"]
    if not isinstance(at, dt.datetime) or not _camera["frame"]:
        return False
    return (dt.datetime.now(dt.timezone.utc) - at) < CAMERA_STALE_WINDOW


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

    async def send_to(self, cid: str, message: dict[str, object]) -> bool:
        """Send a message to one connected device by id. Returns False if not connected."""
        ws = self._conns.get(cid)
        if ws is None:
            return False
        try:
            await ws.send_json(message)
            return True
        except Exception:  # noqa: BLE001 - drop a dead socket
            self.disconnect(cid)
            return False

    def set_ota_status(self, cid: str, status: str, progress: int | None = None) -> None:
        """Record the OTA state a device reported (shown in the settings OTA panel)."""
        meta = self._meta.get(cid)
        if meta is not None:
            meta["ota_status"] = status
            meta["ota_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
            if progress is not None:
                meta["ota_progress"] = progress

    def set_version(self, cid: str, version: str) -> None:
        """Record the firmware version a device reported on connect."""
        meta = self._meta.get(cid)
        if meta is not None:
            meta["version"] = version

    def reset_ota(self, status: str) -> None:
        """Mark every connected device with an OTA status (called when an OTA starts)."""
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        for meta in self._meta.values():
            meta["ota_status"] = status
            meta["ota_at"] = now
            meta.pop("ota_progress", None)

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
    # "solve" (answer the question) or "scenario" (capture a case-study screen).
    action: str = "solve"


class StatusUpdate(BaseModel):
    status: str  # "solving" | "error"


class ScenarioReport(BaseModel):
    ok: bool = True
    count: int  # total scenario screens captured so far this session
    detail: str | None = None


class RemoteState(BaseModel):
    status: str
    answer_id: str | None = None
    answer: SolveResult | None = None


class SourceUpdate(BaseModel):
    source: str  # "browser" | "agent" | "camera"


class SourceState(BaseModel):
    source: str
    agent_online: bool
    agent_host: str | None = None
    frame_ready: bool = False
    agent_count: int = 0
    camera_online: bool = False
    camera_frame_ready: bool = False


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
        camera_online=_camera_fresh(),
        camera_frame_ready=_camera_fresh(),
    )


@router.post("/source", response_model=SourceState)
def set_source(update: SourceUpdate) -> SourceState:
    """Choose which capture source answers triggers: browser tab, native agent, or phone."""
    if update.source not in _CAPTURE_SOURCES:
        raise HTTPException(
            status_code=422,
            detail=f"source must be one of {', '.join(_CAPTURE_SOURCES)}",
        )
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
        # 204 (not 404) so the browser's ~1 fps polling for a preview frame doesn't
        # spam the devtools console with failed-request errors while no agent is
        # streaming. 204 is a success status, so it renders no error.
        return Response(status_code=204)
    return Response(
        content=bytes(_capture["frame"]),  # type: ignore[arg-type]
        media_type=str(_capture["frame_ct"]),
    )


@router.post("/camera/frame")
async def upload_camera_frame(image: UploadFile = File(...)) -> dict[str, object]:
    """The phone's /camera page pushes a cropped screen frame here (no API key needed).

    The phone captures its rear camera, lets the user crop/deskew the on-screen area, and
    streams the resulting JPEG at ~1-2 fps. The browser fetches it with GET /camera/frame
    and solves with its own BYOK key, so the phone only ever *records* — like the agent.
    """
    data = await image.read()
    _camera["frame"] = data
    _camera["frame_ct"] = image.content_type or "image/jpeg"
    _camera["frame_at"] = dt.datetime.now(dt.timezone.utc)
    return {"ok": True, "bytes": len(data)}


@router.get("/camera/frame")
def get_camera_frame() -> Response:
    """Return the latest cropped frame the phone pushed (used by the browser to solve)."""
    if not _camera_fresh():
        # 204 (not 404) so ~1 fps preview polling stays quiet while no phone streams.
        return Response(status_code=204)
    return Response(
        content=bytes(_camera["frame"]),  # type: ignore[arg-type]
        media_type=str(_camera["frame_ct"]),
    )


@router.post("/trigger", response_model=TriggerResponse)
def trigger() -> TriggerResponse:
    """Called by the ESP32 when the screen is touched."""
    tid = str(uuid.uuid4())
    _state["pending"] = True
    _state["trigger_id"] = tid
    _state["action"] = "solve"
    _state["status"] = "requested"
    return TriggerResponse(ok=True, trigger_id=tid)


@router.get("/poll", response_model=PollResponse)
def poll() -> PollResponse:
    """Called by the browser to learn whether a touch is pending. Clears the flag."""
    if _state["pending"]:
        _state["pending"] = False
        return PollResponse(
            triggered=True,
            trigger_id=_state["trigger_id"],  # type: ignore[arg-type]
            action=str(_state.get("action") or "solve"),
        )
    return PollResponse(triggered=False)


@router.post("/scenario", response_model=RemoteState)
async def report_scenario(report: ScenarioReport) -> RemoteState:
    """The browser reports it captured + cached a case-study scenario screen.

    Broadcast to connected devices so the ESP32 can show a per-screen success message
    and the running capture count while in case-study mode.
    """
    _state["scenario_count"] = int(report.count)
    state = _current()
    await hub.broadcast(
        {
            "type": "scenario",
            "ok": report.ok,
            "count": int(report.count),
            "detail": report.detail,
        }
    )
    return state


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
        # Sync the device's display preferences on connect (e.g. after a reboot).
        await ws.send_json({"type": "display_config", **_display})
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
                _state["action"] = "solve"
                _state["status"] = "requested"
            elif msg.get("type") == "hello":
                # The device announced its firmware version on connect.
                v = msg.get("version")
                if isinstance(v, str) and v:
                    hub.set_version(cid, v)
            elif msg.get("type") == "capture_scenario":
                # Case-study mode: the device asked to capture the current screen as a
                # scenario. The browser transcribes + caches it (it holds the API key).
                _state["pending"] = True
                _state["trigger_id"] = str(uuid.uuid4())
                _state["action"] = "scenario"
                _state["status"] = "requested"
            elif msg.get("type") == "ota_status":
                # The device reports its firmware-update progress so the settings OTA
                # panel can show it (e.g. "updating" → reboot → reconnect).
                hub.set_ota_status(
                    cid, str(msg.get("status") or "unknown"), msg.get("progress")
                )
            elif msg.get("type") == "case_exit":
                # The device left case-study mode: tell the browser (via the poll) to drop
                # all cached scenario pages/content for a fresh start next time.
                _state["pending"] = True
                _state["trigger_id"] = str(uuid.uuid4())
                _state["action"] = "clear_case"
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
