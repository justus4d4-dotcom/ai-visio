"""ESP32 firmware storage + over-the-air (OTA) update to all connected devices.

Flow (triggered from Settings → Devices in the web UI):
  1. An admin uploads a compiled ESP32 firmware image (.bin) — POST /api/devices/firmware.
     It is stored on disk with its MD5 so devices can verify the download.
  2. The admin hits "Update all devices" — POST /api/devices/ota. The backend broadcasts
     an ``{"type":"ota","path":...}`` message over the existing WebSocket hub to every
     connected ESP32.
  3. Each device downloads the image over HTTP from GET /api/devices/firmware/binary
     (auth-exempt, since the device can't do the browser OAuth) and flashes itself via the
     Arduino HTTPUpdate library, verifying the ``x-MD5`` response header, then reboots.

The binary endpoint intentionally serves only the single most-recently uploaded image.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import updates
from app.config import settings
from app.routers.remote import hub, set_display

router = APIRouter(prefix="/api/devices", tags=["devices"])

# Path (relative to /api) the device fetches the firmware image from. Sent in the OTA
# message so the ESP32 can build the full URL from its stored backend base URL.
FIRMWARE_PATH = "/api/devices/firmware/binary"

# ESP32 application images start with this magic byte; a quick guard against uploading a
# wrong/corrupt file.
_ESP_IMAGE_MAGIC = 0xE9
_MAX_FIRMWARE_BYTES = 8 * 1024 * 1024  # generous for a 16MB-flash S3 app partition

# How long to wait for a device to report "updating" after an OTA is pushed before the UI
# flags it as "no_response" (a device on the new firmware acks within ~1s).
_OTA_ACK_GRACE_SECS = 20


class FirmwareInfo(BaseModel):
    stored: bool
    version: str | None = None
    filename: str | None = None
    md5: str | None = None
    size: int | None = None
    uploaded_at: str | None = None
    # Where the stored image came from: "upload" (manual) or "github" (release asset).
    source: str | None = None


class FirmwareLatest(BaseModel):
    """The newest firmware image found on the GitHub releases (the OTA suggestion)."""

    available: bool
    tag: str | None = None
    name: str | None = None
    size: int | None = None
    updated_at: str | None = None
    detail: str | None = None


class OtaResult(BaseModel):
    targeted: int
    firmware: FirmwareInfo


def _bin_path() -> str:
    return os.path.join(settings.firmware_dir, "firmware.bin")


def _meta_path() -> str:
    return os.path.join(settings.firmware_dir, "firmware.json")


def _load_meta() -> FirmwareInfo:
    try:
        with open(_meta_path(), encoding="utf-8") as fh:
            data = json.load(fh)
        if os.path.exists(_bin_path()):
            return FirmwareInfo(stored=True, **data)
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass
    return FirmwareInfo(stored=False)


def _validate_image(data: bytes) -> None:
    """Reject anything that clearly is not an ESP32 application image."""
    if not data:
        raise HTTPException(status_code=400, detail="Empty firmware file.")
    if len(data) > _MAX_FIRMWARE_BYTES:
        raise HTTPException(status_code=413, detail="Firmware image too large.")
    if data[0] != _ESP_IMAGE_MAGIC:
        raise HTTPException(
            status_code=422,
            detail="That does not look like an ESP32 firmware image (bad magic byte).",
        )


def _store_firmware(data: bytes, *, filename: str, version: str | None, source: str) -> FirmwareInfo:
    """Persist a firmware image (from a manual upload or a GitHub release) + its meta."""
    os.makedirs(settings.firmware_dir, exist_ok=True)
    with open(_bin_path(), "wb") as fh:
        fh.write(data)
    meta = FirmwareInfo(
        stored=True,
        version=version or None,
        filename=filename,
        md5=hashlib.md5(data).hexdigest(),
        size=len(data),
        uploaded_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        source=source,
    )
    with open(_meta_path(), "w", encoding="utf-8") as fh:
        json.dump(meta.model_dump(exclude={"stored"}), fh)
    return meta


def _latest_firmware_asset() -> dict | None:
    """The newest ``.bin`` release asset on GitHub, or None. Raises httpx.HTTPError."""
    url = f"{updates._GITHUB_API}/repos/{settings.github_repo}/releases"
    with httpx.Client(timeout=15) as client:
        resp = client.get(url, headers=updates._github_headers(), params={"per_page": 20})
        resp.raise_for_status()
        for rel in resp.json():
            if rel.get("draft"):
                continue
            bins = [
                a for a in (rel.get("assets") or [])
                if str(a.get("name", "")).lower().endswith(".bin")
            ]
            if not bins:
                continue
            # Prefer an asset whose name looks like the display firmware.
            bins.sort(
                key=lambda a: 0
                if any(k in a["name"].lower() for k in ("firmware", "display"))
                else 1
            )
            a = bins[0]
            return {
                "tag": rel.get("tag_name"),
                "name": a.get("name"),
                "size": a.get("size"),
                "updated_at": a.get("updated_at") or rel.get("published_at"),
                "asset_url": a.get("url"),  # API URL (works for private repos with a token)
            }
    return None


@router.get("/firmware", response_model=FirmwareInfo)
def firmware_info() -> FirmwareInfo:
    """Metadata about the currently stored firmware image (or stored=False)."""
    return _load_meta()


@router.post("/firmware", response_model=FirmwareInfo)
async def upload_firmware(
    firmware: UploadFile = File(...),
    version: str = Form(default=""),
) -> FirmwareInfo:
    """Upload a compiled ESP32 firmware image (.bin) for OTA distribution."""
    name = firmware.filename or "firmware.bin"
    if not name.lower().endswith(".bin"):
        raise HTTPException(status_code=422, detail="Firmware must be a .bin file.")
    data = await firmware.read()
    _validate_image(data)
    return _store_firmware(data, filename=name, version=version.strip() or None, source="upload")


@router.get("/firmware/latest", response_model=FirmwareLatest)
def firmware_latest() -> FirmwareLatest:
    """The newest firmware image published on GitHub releases (the OTA suggestion)."""
    try:
        asset = _latest_firmware_asset()
    except httpx.HTTPError as exc:
        return FirmwareLatest(available=False, detail=updates._friendly_api_error(exc))
    if not asset:
        return FirmwareLatest(
            available=False,
            detail="No firmware (.bin) asset found on the GitHub releases yet.",
        )
    return FirmwareLatest(
        available=True,
        tag=asset["tag"],
        name=asset["name"],
        size=asset["size"],
        updated_at=asset["updated_at"],
    )


@router.post("/firmware/fetch", response_model=FirmwareInfo)
def fetch_latest_firmware() -> FirmwareInfo:
    """Download the latest GitHub-release firmware asset and make it the active image."""
    try:
        asset = _latest_firmware_asset()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=updates._friendly_api_error(exc))
    if not asset:
        raise HTTPException(
            status_code=404, detail="No firmware asset on the GitHub releases yet."
        )
    # Asset bytes require Accept: application/octet-stream (works for private repos).
    headers = dict(updates._github_headers())
    headers["Accept"] = "application/octet-stream"
    try:
        with httpx.Client(timeout=60, follow_redirects=True) as client:
            r = client.get(asset["asset_url"], headers=headers)
            r.raise_for_status()
            data = r.content
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not download firmware: {exc}")
    _validate_image(data)
    return _store_firmware(
        data, filename=asset["name"], version=asset["tag"], source="github"
    )


@router.get("/firmware/binary")
def firmware_binary() -> Response:
    """Serve the stored firmware image to a device. Auth-exempt (see app.main).

    Sends the MD5 as the ``x-MD5`` header so the ESP32 HTTPUpdate client can verify the
    download before flashing.
    """
    meta = _load_meta()
    if not meta.stored or not os.path.exists(_bin_path()):
        raise HTTPException(status_code=404, detail="No firmware uploaded.")
    headers = {"x-MD5": meta.md5} if meta.md5 else {}
    return FileResponse(
        _bin_path(),
        media_type="application/octet-stream",
        filename=meta.filename or "firmware.bin",
        headers=headers,
    )


def _ota_message_and_meta() -> tuple[dict, FirmwareInfo]:
    meta = _load_meta()
    if not meta.stored:
        raise HTTPException(status_code=400, detail="Upload a firmware image first.")
    msg = {"type": "ota", "path": FIRMWARE_PATH, "md5": meta.md5, "version": meta.version}
    return msg, meta


@router.post("/ota", response_model=OtaResult)
async def start_ota() -> OtaResult:
    """Tell every connected ESP32 to pull the stored firmware and flash itself."""
    msg, meta = _ota_message_and_meta()
    if hub.count == 0:
        raise HTTPException(status_code=409, detail="No devices are connected.")
    hub.reset_ota("requested")
    await hub.broadcast(msg)
    return OtaResult(targeted=hub.count, firmware=meta)


@router.post("/{device_id}/ota", response_model=OtaResult)
async def ota_one(device_id: str) -> OtaResult:
    """Deploy the stored firmware to a single connected device."""
    msg, meta = _ota_message_and_meta()
    if not await hub.send_to(device_id, msg):
        raise HTTPException(status_code=404, detail="That device is not connected.")
    hub.set_ota_status(device_id, "requested")
    return OtaResult(targeted=1, firmware=meta)


class DisplayConfig(BaseModel):
    brightness: int | None = None
    text_size: str | None = None
    show_confidence: bool | None = None
    show_subtext: bool | None = None
    show_cached_badge: bool | None = None


@router.post("/display")
async def push_display(cfg: DisplayConfig) -> dict[str, object]:
    """Store + broadcast the ESP32 display preferences to all connected devices."""
    full = set_display(cfg.model_dump(exclude_none=True))
    await hub.broadcast({"type": "display_config", **full})
    return {"ok": True, "targeted": hub.count, "display": full}


@router.post("/{device_id}/display")
async def push_display_one(device_id: str, cfg: DisplayConfig) -> dict[str, object]:
    """Push display preferences to a single connected device."""
    full = set_display(cfg.model_dump(exclude_none=True))
    if not await hub.send_to(device_id, {"type": "display_config", **full}):
        raise HTTPException(status_code=404, detail="That device is not connected.")
    return {"ok": True, "targeted": 1, "display": full}


@router.get("/connected")
def connected_devices() -> dict[str, object]:
    """Connected device count + metadata (incl. reported OTA status) for the UI.

    A device that was told to update but never reported back within a grace period is
    surfaced as ``no_response`` — almost always firmware without the OTA handler (it must
    be flashed once over USB/espota before push-OTA can reach it).
    """
    now = dt.datetime.now(dt.timezone.utc)
    devices: list[dict[str, object]] = []
    for i, src in enumerate(hub.devices()):
        d = dict(src)
        d["name"] = f"Display {i + 1}"
        if d.get("ota_status") == "requested" and d.get("ota_at"):
            try:
                age = (now - dt.datetime.fromisoformat(str(d["ota_at"]))).total_seconds()
            except (TypeError, ValueError):
                age = 0.0
            if age > _OTA_ACK_GRACE_SECS:
                d["ota_status"] = "no_response"
        devices.append(d)
    return {"count": hub.count, "devices": devices}
