#!/usr/bin/env python3
"""Native macOS screen-recording agent for ai-visio+.

A headless alternative to the browser's `getDisplayMedia` screen share. The agent only
*records* the Mac screen and pushes frames to the backend — it does NOT talk to Gemini
and needs no API key. The web app (which holds your BYOK Gemini key) fetches the latest
frame and does the interpreting when a trigger fires (ESP32 touch or "Simulate screen
touch").

Flow:
  1. heartbeat -> POST /api/remote/agent/heartbeat   (so the web UI can select us)
  2. while selected as the capture source ("Native app"):
       stream  -> POST /api/remote/frame  (JPEG of the current screen, ~1 fps)
  3. the browser fetches GET /api/remote/frame on a trigger and solves it.

Config precedence: CLI flags > AIVISIO_* env vars > TOML file
(default: ~/.config/ai-visio-agent/config.toml). See config.example.toml.

Dependencies:  pip install mss pillow requests   (Python 3.11+ for tomllib)
"""

from __future__ import annotations

import argparse
import io
import os
import socket
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    print("This agent needs Python 3.11+ (for tomllib).", file=sys.stderr)
    raise

import mss
import requests
from PIL import Image

DEFAULT_CONFIG_PATH = Path.home() / ".config" / "ai-visio-agent" / "config.toml"

# Frame encoding: match the browser (max 1024px long edge, JPEG q82) so identical
# screens hash the same server-side and hit the dedup cache.
MAX_EDGE = 1024
JPEG_QUALITY = 82

# Auto-detect thresholds (in aHash bits, 0..64) — mirror the browser's values so the
# native agent behaves the same as the Chrome-tab source. A frame must differ from the
# last triggered one by more than CHANGE_THRESHOLD to count as a new screen, and two
# consecutive samples must be within STABLE_THRESHOLD to be considered settled.
CHANGE_THRESHOLD = 6
STABLE_THRESHOLD = 3


@dataclass
class Config:
    backend_url: str
    monitor: int = 1           # mss monitor index; 0 = all screens, 1 = primary
    fps: float = 1.0           # frames per second to stream while active
    heartbeat_interval: float = 2.0
    auto: bool = False         # auto-detect screen changes and fire a trigger
    interval: float = 3.0      # seconds between auto-detect samples
    verbose: bool = False


# --------------------------------------------------------------------------- config


def _load_toml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("rb") as fh:
        return tomllib.load(fh)


def load_config(args: argparse.Namespace) -> Config:
    path = Path(args.config).expanduser() if args.config else DEFAULT_CONFIG_PATH
    file_cfg = _load_toml(path)

    def pick(name: str, default=None):
        # CLI flag > env var > TOML file > default
        cli = getattr(args, name, None)
        if cli is not None:
            return cli
        env = os.environ.get("AIVISIO_" + name.upper())
        if env is not None:
            return env
        if name in file_cfg:
            return file_cfg[name]
        return default

    backend_url = pick("backend_url", "http://localhost:8000")
    return Config(
        backend_url=str(backend_url).rstrip("/"),
        monitor=int(pick("monitor", 1)),
        fps=float(pick("fps", 1.0)),
        heartbeat_interval=float(pick("heartbeat_interval", 2.0)),
        auto=bool(pick("auto", False)),
        interval=float(pick("interval", 3.0)),
        verbose=bool(getattr(args, "verbose", False)),
    )


# --------------------------------------------------------------------------- capture


def grab_image(sct: "mss.base.MSSBase", monitor: int) -> Image.Image:
    """Capture the chosen monitor and return a downscaled RGB PIL image."""
    mon = sct.monitors[monitor]
    shot = sct.grab(mon)
    img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    long_edge = max(img.size)
    if long_edge > MAX_EDGE:
        scale = MAX_EDGE / long_edge
        img = img.resize((round(img.width * scale), round(img.height * scale)))
    return img


def encode_jpeg(img: Image.Image) -> bytes:
    """Encode a PIL image as JPEG bytes."""
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def ahash(img: Image.Image) -> int:
    """64-bit average hash (aHash) of an image — matches the browser's lib/vision.ts."""
    small = img.convert("L").resize((8, 8))
    pixels = list(small.getdata())
    avg = sum(pixels) / len(pixels)
    bits = 0
    for i, p in enumerate(pixels):
        if p >= avg:
            bits |= 1 << i
    return bits


def hamming(a: int, b: int) -> int:
    """Number of differing bits between two 64-bit aHashes (0..64)."""
    return bin(a ^ b).count("1")


# --------------------------------------------------------------------------- backend


class Backend:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.s = requests.Session()
        self.host = socket.gethostname()
        # Unique per-process id so the backend can tell concurrent agents apart and let
        # only one of them stream the preview (avoids a flickering screen in the web UI).
        self.instance = uuid.uuid4().hex

    def _url(self, path: str) -> str:
        return f"{self.cfg.backend_url}{path}"

    def heartbeat(self) -> bool:
        """Report we are alive; return True if the UI selected us as the source."""
        r = self.s.post(
            self._url("/api/remote/agent/heartbeat"),
            json={"host": self.host, "instance": self.instance},
            timeout=5,
        )
        r.raise_for_status()
        return bool(r.json().get("active"))

    def post_frame(self, jpeg: bytes) -> None:
        self.s.post(
            self._url("/api/remote/frame"),
            files={"image": ("frame.jpg", jpeg, "image/jpeg")},
            data={"instance": self.instance},
            timeout=10,
        )

    def trigger(self) -> None:
        """Fire a solve trigger (as an ESP32 touch would) so the browser interprets
        the latest agent frame with its BYOK Gemini key."""
        self.s.post(self._url("/api/remote/trigger"), timeout=5)


# --------------------------------------------------------------------------- loop


def run(cfg: Config) -> None:
    be = Backend(cfg)
    last_hb = 0.0
    last_frame = 0.0
    last_sample = 0.0
    active = False
    prev_hash: int | None = None          # hash of the previous auto-detect sample
    last_trigger_hash: int | None = None  # hash of the frame we last triggered on
    frame_period = 1.0 / cfg.fps if cfg.fps > 0 else 1.0
    sample_period = max(0.5, cfg.interval)

    def log(*a):
        if cfg.verbose:
            print(*a, flush=True)

    print(
        f"ai-visio+ agent -> {cfg.backend_url}  (monitor {cfg.monitor}, "
        f"{cfg.fps:g} fps"
        + (f", auto-detect every {sample_period:g}s" if cfg.auto else "")
        + "). Records the screen only — no API key needed. "
        "Select 'Native app' in the web UI.",
        flush=True,
    )

    with mss.mss() as sct:
        n = len(sct.monitors)
        if cfg.monitor >= n:
            raise SystemExit(f"monitor {cfg.monitor} not found (have {n - 1} screen(s))")

        while True:
            now = time.monotonic()

            # 1. Heartbeat so the web UI can see (and select) this agent.
            if now - last_hb >= cfg.heartbeat_interval:
                last_hb = now
                try:
                    was_active = active
                    active = be.heartbeat()
                    if active != was_active:
                        print(
                            "[source] this agent is now "
                            + ("ACTIVE — streaming screen" if active else "inactive"),
                            flush=True,
                        )
                        if not active:
                            prev_hash = None
                            last_trigger_hash = None
                except requests.RequestException as exc:
                    log(f"[hb] {exc}")

            # 2. While selected, stream the screen so the browser can solve it.
            if active and now - last_frame >= frame_period:
                last_frame = now
                try:
                    be.post_frame(encode_jpeg(grab_image(sct, cfg.monitor)))
                    log("[frame] pushed")
                except requests.RequestException as exc:
                    log(f"[frame] {exc}")
                except Exception as exc:  # noqa: BLE001
                    print(f"[error] capture failed: {exc}", flush=True)

            # 3. Auto-detect: sample on an interval and fire a trigger when the screen
            #    changed (vs the last triggered frame) AND has settled (vs the previous
            #    sample) — mirroring the browser's auto-detection.
            if cfg.auto and active and now - last_sample >= sample_period:
                last_sample = now
                try:
                    cur = ahash(grab_image(sct, cfg.monitor))
                    stable = prev_hash is not None and hamming(cur, prev_hash) <= STABLE_THRESHOLD
                    changed = (
                        last_trigger_hash is None
                        or hamming(cur, last_trigger_hash) > CHANGE_THRESHOLD
                    )
                    prev_hash = cur
                    if stable and changed:
                        be.trigger()
                        last_trigger_hash = cur
                        print("[auto] change detected — triggered a solve", flush=True)
                except requests.RequestException as exc:
                    log(f"[auto] {exc}")
                except Exception as exc:  # noqa: BLE001
                    print(f"[error] auto-detect failed: {exc}", flush=True)

            time.sleep(0.1)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Native macOS screen agent for ai-visio+.")
    p.add_argument("--config", help="Path to a TOML config file.")
    p.add_argument("--backend-url", dest="backend_url", help="Backend base URL.")
    p.add_argument("--monitor", type=int, help="mss monitor index (0=all, 1=primary).")
    p.add_argument("--fps", type=float, help="Frames per second to stream (default 1).")
    p.add_argument(
        "--auto",
        dest="auto",
        action="store_true",
        default=None,
        help="Auto-detect screen changes and fire a solve trigger.",
    )
    p.add_argument(
        "--interval",
        type=float,
        help="Seconds between auto-detect samples (default 3).",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="Verbose logging.")
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    cfg = load_config(args)
    try:
        run(cfg)
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
