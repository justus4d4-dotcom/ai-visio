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

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.config import settings
from app.routers.remote import hub

router = APIRouter(prefix="/api/devices", tags=["devices"])

# Path (relative to /api) the device fetches the firmware image from. Sent in the OTA
# message so the ESP32 can build the full URL from its stored backend base URL.
FIRMWARE_PATH = "/api/devices/firmware/binary"

# ESP32 application images start with this magic byte; a quick guard against uploading a
# wrong/corrupt file.
_ESP_IMAGE_MAGIC = 0xE9
_MAX_FIRMWARE_BYTES = 8 * 1024 * 1024  # generous for a 16MB-flash S3 app partition


class FirmwareInfo(BaseModel):
    stored: bool
    version: str | None = None
    filename: str | None = None
    md5: str | None = None
    size: int | None = None
    uploaded_at: str | None = None


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
    if not data:
        raise HTTPException(status_code=400, detail="Empty firmware file.")
    if len(data) > _MAX_FIRMWARE_BYTES:
        raise HTTPException(status_code=413, detail="Firmware image too large.")
    if data[0] != _ESP_IMAGE_MAGIC:
        raise HTTPException(
            status_code=422,
            detail="That does not look like an ESP32 firmware image (bad magic byte).",
        )

    os.makedirs(settings.firmware_dir, exist_ok=True)
    with open(_bin_path(), "wb") as fh:
        fh.write(data)
    meta = FirmwareInfo(
        stored=True,
        version=version.strip() or None,
        filename=name,
        md5=hashlib.md5(data).hexdigest(),
        size=len(data),
        uploaded_at=dt.datetime.now(dt.timezone.utc).isoformat(),
    )
    with open(_meta_path(), "w", encoding="utf-8") as fh:
        json.dump(meta.model_dump(exclude={"stored"}), fh)
    return meta


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


@router.post("/ota", response_model=OtaResult)
async def start_ota() -> OtaResult:
    """Tell every connected ESP32 to pull the stored firmware and flash itself."""
    meta = _load_meta()
    if not meta.stored:
        raise HTTPException(status_code=400, detail="Upload a firmware image first.")
    if hub.count == 0:
        raise HTTPException(status_code=409, detail="No devices are connected.")

    hub.reset_ota("requested")
    await hub.broadcast(
        {
            "type": "ota",
            "path": FIRMWARE_PATH,
            "md5": meta.md5,
            "version": meta.version,
        }
    )
    return OtaResult(targeted=hub.count, firmware=meta)


@router.get("/connected")
def connected_devices() -> dict[str, object]:
    """Connected device count + metadata (incl. reported OTA status) for the UI."""
    return {"count": hub.count, "devices": hub.devices()}
