"use client";

// Mobile capture page — open this on the iPhone (or any phone) in a browser.
//
// It opens the rear camera, lets you drag four corner handles onto the monitor so the
// screen is cropped and de-skewed (see lib/warp), then streams the flattened frame to the
// backend at /api/remote/camera/frame. The desktop app (which holds the Gemini key) picks
// "iPhone camera" as its source and solves those frames — the phone never needs the key.
//
// iOS requirement: getUserMedia only works in a secure context. Over the LAN that means
// the frontend must be served over HTTPS (or opened via localhost). Plain http://<ip>
// will be blocked by Safari; the page detects that and explains it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { warpQuadToCanvas, type Point } from "@/lib/warp";
import { detectScreenQuad } from "@/lib/detect";
import { cachedAccount, loadAccount, saveCamera } from "@/lib/settings";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Set when the user explicitly leaves the camera for the full app, so the mobile
// auto-redirect (see app/page.tsx) doesn't immediately bounce them back here.
const PREFER_FULL_KEY = "ai_visio_prefer_full";

// Corner order everywhere: TL, TR, BR, BL. Stored as fractions of the video frame so they
// survive resolution/orientation changes.
const DEFAULT_CORNERS: Point[] = [
  { x: 0.2, y: 0.25 },
  { x: 0.8, y: 0.25 },
  { x: 0.8, y: 0.75 },
  { x: 0.2, y: 0.75 },
];

const OUTPUT_PRESETS = [
  { label: "Small (960×600)", w: 960, h: 600 },
  { label: "Medium (1280×800)", w: 1280, h: 800 },
  { label: "Large (1600×1000)", w: 1600, h: 1000 },
];

// Minimal typings for the (still non-standard) camera zoom capability.
type ZoomCaps = MediaTrackCapabilities & { zoom?: { min: number; max: number; step: number } };
type ZoomSettings = MediaTrackSettings & { zoom?: number };

export default function CameraCapture() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const warpRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cornersRef = useRef<Point[]>(DEFAULT_CORNERS);
  const draggingRef = useRef<number | null>(null);
  const streamingRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [fps, setFps] = useState(8);
  const [preset, setPreset] = useState(1); // Medium
  const [corners, setCorners] = useState<Point[]>(DEFAULT_CORNERS);
  const [insecure, setInsecure] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Optical zoom (when the camera/browser supports it — iOS/Android vary).
  const [zoomSupported, setZoomSupported] = useState(false);
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 1, step: 0.1 });
  const [zoom, setZoom] = useState(1);

  // Keep refs in sync so the streaming loop reads the latest values without re-subscribing.
  useEffect(() => {
    cornersRef.current = corners;
  }, [corners]);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // Camera settings (stream FPS + output size) sync with the signed-in account.
  const camLoadedRef = useRef(false);
  useEffect(() => {
    const c = cachedAccount().camera;
    setFps(c.fps);
    setPreset(c.preset);
    loadAccount()
      .then((a) => {
        setFps(a.camera.fps);
        setPreset(a.camera.preset);
      })
      .catch(() => {})
      .finally(() => {
        camLoadedRef.current = true;
      });
  }, []);
  useEffect(() => {
    if (!camLoadedRef.current) return;
    const id = window.setTimeout(() => saveCamera({ fps, preset }), 800);
    return () => window.clearTimeout(id);
  }, [fps, preset]);

  const flashHint = useCallback((msg: string) => {
    setHint(msg);
    window.setTimeout(() => setHint((h) => (h === msg ? null : h)), 2600);
  }, []);

  const runAutoDetect = useCallback(
    (announce: boolean) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return;
      const quad = detectScreenQuad(video);
      if (quad) {
        setCorners(quad);
        if (announce) flashHint("Screen detected — drag any corner to adjust");
      } else if (announce) {
        flashHint("Couldn't find the screen — drag the corners onto it");
      }
    },
    [flashHint],
  );

  const startCamera = useCallback(async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setInsecure(true);
      setError("Camera API unavailable. On iPhone the page must be opened over HTTPS.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Probe optical-zoom support so we can offer 1×/2× buttons.
      const track = stream.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as ZoomCaps | undefined;
      if (track && caps?.zoom && (caps.zoom.max ?? 1) > (caps.zoom.min ?? 1)) {
        setZoomSupported(true);
        setZoomRange({
          min: caps.zoom.min ?? 1,
          max: caps.zoom.max ?? 1,
          step: caps.zoom.step || 0.1,
        });
        const settings = track.getSettings?.() as ZoomSettings | undefined;
        setZoom(settings?.zoom ?? caps.zoom.min ?? 1);
      } else {
        setZoomSupported(false);
      }

      setReady(true);
      // Give the sensor a moment to auto-expose, then take a first guess at the screen.
      window.setTimeout(() => runAutoDetect(true), 900);
    } catch (e) {
      setInsecure(!window.isSecureContext);
      setError(
        !window.isSecureContext
          ? "iOS blocks the camera on insecure pages. Serve the app over HTTPS, then reload."
          : `Could not open the camera: ${e instanceof Error ? e.message : "denied"}`,
      );
    }
  }, [runAutoDetect]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
    setStreaming(false);
    setZoomSupported(false);
  }, []);

  const applyZoom = useCallback(
    async (z: number) => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track) return;
      const clamped = Math.min(zoomRange.max, Math.max(zoomRange.min, z));
      try {
        await track.applyConstraints({
          advanced: [{ zoom: clamped } as MediaTrackConstraintSet],
        });
        setZoom(clamped);
      } catch {
        /* zoom rejected: ignore */
      }
    },
    [zoomRange],
  );

  function exitToApp() {
    try {
      sessionStorage.setItem(PREFER_FULL_KEY, "1");
    } catch {
      /* ignore */
    }
    stopCamera();
    router.push("/");
  }

  // Draw the mask (dim outside the quad) + the quad outline + corner handles.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = overlayRef.current;
      const video = videoRef.current;
      if (canvas && video && video.videoWidth) {
        const rect = canvas.getBoundingClientRect();
        if (canvas.width !== Math.round(rect.width)) canvas.width = Math.round(rect.width);
        if (canvas.height !== Math.round(rect.height)) canvas.height = Math.round(rect.height);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const W = canvas.width;
          const H = canvas.height;
          const fit = fitRect(W, H, video.videoWidth, video.videoHeight);
          ctx.clearRect(0, 0, W, H);
          const pts = cornersRef.current.map((p) => ({
            x: fit.dx + p.x * fit.dw,
            y: fit.dy + p.y * fit.dh,
          }));

          // Mask: darken everything outside the selected screen quad.
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, W, H);
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fill("evenodd");
          ctx.restore();

          // Quad outline.
          ctx.strokeStyle = "#818cf8";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.stroke();

          // Corner handles (ring + dot) sized for touch.
          for (const p of pts) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(99,102,241,0.35)";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
            ctx.fillStyle = "#c7d2fe";
            ctx.fill();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    if (ready) raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  function pointerFromEvent(e: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect();
    const video = videoRef.current;
    const fit = fitRect(rect.width, rect.height, video?.videoWidth ?? 0, video?.videoHeight ?? 0);
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    return { x: (cx - fit.dx) / (fit.dw || 1), y: (cy - fit.dy) / (fit.dh || 1) };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = pointerFromEvent(e);
    let nearest = 0;
    let best = Infinity;
    corners.forEach((c, i) => {
      const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    // Only grab a corner when the touch lands reasonably close to one, so a stray tap in
    // the middle of the frame doesn't yank a handle across the screen.
    if (Math.sqrt(best) > 0.16) return;
    draggingRef.current = nearest;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (draggingRef.current === null) return;
    const p = pointerFromEvent(e);
    const clamped = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
    setCorners((prev) => prev.map((c, i) => (i === draggingRef.current ? clamped : c)));
  }

  function onPointerUp() {
    draggingRef.current = null;
  }

  const startStreaming = useCallback(async () => {
    setStreaming(true);
    setStatus("streaming");
    try {
      await fetch(`${API_URL}/api/remote/source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "camera" }),
      });
    } catch {
      /* backend picks it up from the desktop too; ignore */
    }
  }, []);

  function stopStreaming() {
    setStreaming(false);
    setStatus("idle");
  }

  // The push loop: warp the current camera frame to a flat rectangle and POST it.
  useEffect(() => {
    if (!streaming) return;
    let cancelled = false;
    const warp = warpRef.current ?? document.createElement("canvas");
    // Stream rate: the push loop was previously floored at 250ms (≈4 fps) regardless of
    // this setting, so raising it did nothing. Honour it up to 30 fps (33ms floor).
    const period = Math.max(33, 1000 / Math.min(30, Math.max(1, fps)));
    // Only push status into React state when it actually changes — otherwise every frame
    // (up to 30/s) re-renders the whole camera component, adding needless GC pressure.
    let lastStatus = "streaming";
    const pushStatus = (s: string) => {
      if (s !== lastStatus) {
        lastStatus = s;
        setStatus(s);
      }
    };

    const tick = async () => {
      if (cancelled || !streamingRef.current) return;
      const video = videoRef.current;
      const { w, h } = OUTPUT_PRESETS[preset];
      if (video && video.videoWidth) {
        const src = cornersRef.current.map((p) => ({ x: p.x * video.videoWidth, y: p.y * video.videoHeight }));
        warpQuadToCanvas(video, src, warp, w, h);
        const blob: Blob | null = await new Promise((res) => warp.toBlob((b) => res(b), "image/jpeg", 0.82));
        if (blob && !cancelled) {
          const form = new FormData();
          form.append("image", blob, "camera.jpg");
          try {
            const r = await fetch(`${API_URL}/api/remote/camera/frame`, { method: "POST", body: form });
            pushStatus(r.ok ? "streaming" : `error ${r.status}`);
          } catch {
            pushStatus("offline — check the server address");
          }
        }
      }
      if (!cancelled) setTimeout(tick, period);
    };
    const id = setTimeout(tick, period);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [streaming, fps, preset]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const zoomStops = buildZoomStops(zoomRange.min, zoomRange.max);

  return (
    <main className="fixed inset-0 flex flex-col overflow-hidden bg-app text-ink">
      {/* Top bar */}
      <header className="safe-top flex shrink-0 items-center justify-between gap-2 border-b border-line bg-panel px-4 py-2.5">
        <button
          onClick={exitToApp}
          className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink active:bg-panel-2"
        >
          <span aria-hidden>←</span> App
        </button>
        <span className="flex items-center gap-2 rounded-full bg-panel-2 px-3 py-1.5 text-xs text-ink-muted">
          <span
            className={
              "inline-block h-2 w-2 rounded-full " +
              (status === "streaming"
                ? "bg-sage animate-pulse"
                : status === "idle"
                  ? "bg-taupe-grey"
                  : "bg-red-500")
            }
          />
          {ready ? status : "camera off"}
        </span>
      </header>

      {/* Viewfinder — fills the height between the two bars. */}
      <div className="relative min-h-0 flex-1 bg-black">
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-contain"
          muted
          playsInline
        />
        <canvas
          ref={overlayRef}
          className="absolute inset-0 h-full w-full touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />

        {!ready && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
            <p className="max-w-xs text-sm text-neutral-300">
              Point the rear camera at the screen. The monitor is detected and masked
              automatically — drag the corners if needed.
            </p>
          </div>
        )}

      {/* Zoom control (only when supported). */}
        {ready && zoomSupported && zoomStops.length > 1 && (
          <div className="absolute right-3 top-1/2 z-20 flex -translate-y-1/2 flex-col overflow-hidden rounded-full bg-black/60 backdrop-blur">
            {zoomStops.map((z) => (
              <button
                key={z}
                onClick={() => applyZoom(z)}
                className={
                  "px-3 py-2.5 text-sm font-semibold " +
                  (Math.abs(zoom - z) < 0.05
                    ? "bg-accent text-accent-ink"
                    : "text-neutral-100 active:bg-white/10")
                }
              >
                {z % 1 === 0 ? `${z}×` : `${z.toFixed(1)}×`}
              </button>
            ))}
          </div>
        )}

        {/* Transient hint (auto-detect result, etc.). */}
        {hint && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
            <span className="rounded-full bg-black/80 px-4 py-2 text-center text-xs text-neutral-100 backdrop-blur">
              {hint}
            </span>
          </div>
        )}

        {error && (
          <div className="absolute inset-x-3 bottom-3 z-20 rounded-lg border border-red-500/50 bg-red-950/90 p-3 text-sm text-red-200 backdrop-blur">
            {error}
            {insecure && (
              <p className="mt-2 text-xs text-red-300">
                Open this page via <code>https://…</code> or <code>localhost</code>. On the LAN,
                put the frontend behind HTTPS (self-signed cert or a reverse proxy).
              </p>
            )}
          </div>
        )}
      </div>

      {/* Bottom bar — controls. */}
      <div className="safe-bottom shrink-0 border-t border-line bg-panel px-3 pb-3 pt-3">
        {!ready ? (
          <button
            onClick={startCamera}
            className="w-full rounded-xl bg-accent px-4 py-3.5 text-base font-semibold text-accent-ink active:bg-accent/90"
          >
            Open camera
          </button>
        ) : (
          <>
            <div className="flex gap-2">
              <button
                onClick={() => runAutoDetect(true)}
                className="flex-1 rounded-xl border border-line px-3 py-3 text-sm font-medium text-ink active:bg-panel-2"
              >
                Auto-detect
              </button>
              {!streaming ? (
                <button
                  onClick={startStreaming}
                  className="flex-[2] rounded-xl bg-accent px-4 py-3 text-base font-semibold text-accent-ink active:bg-accent/90"
                >
                  Start streaming
                </button>
              ) : (
                <button
                  onClick={stopStreaming}
                  className="flex-[2] rounded-xl bg-red-600 px-4 py-3 text-base font-semibold text-white active:bg-red-500"
                >
                  Stop streaming
                </button>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between text-xs text-ink-muted">
              <button
                onClick={() => setCorners(DEFAULT_CORNERS)}
                className="rounded px-2 py-1 active:bg-panel-2"
              >
                Reset corners
              </button>
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                className="rounded px-2 py-1 active:bg-panel-2"
              >
                {showAdvanced ? "Hide options" : "Options"}
              </button>
              <button onClick={stopCamera} className="rounded px-2 py-1 active:bg-panel-2">
                Close camera
              </button>
            </div>

            {showAdvanced && (
              <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-ink-muted">Output size</span>
                  <select
                    value={preset}
                    onChange={(e) => setPreset(Number(e.target.value))}
                    className="rounded-lg border border-line bg-app p-2.5 text-ink"
                  >
                    {OUTPUT_PRESETS.map((p, i) => (
                      <option key={p.label} value={i}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ink-muted">Stream FPS (max 30)</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={fps}
                    onChange={(e) => setFps(Math.min(30, Math.max(1, Number(e.target.value) || 1)))}
                    className="rounded-lg border border-line bg-app p-2.5 text-ink"
                  />
                </label>
              </div>
            )}
          </>
        )}
      </div>

      <canvas ref={warpRef} className="hidden" />
    </main>
  );
}

// Discrete zoom buttons within the camera's supported range: always 1×, then 2× and the
// max (deduped) when the hardware allows it.
function buildZoomStops(min: number, max: number): number[] {
  const stops = new Set<number>();
  stops.add(Math.max(1, Math.round(min)));
  if (max >= 2) stops.add(2);
  if (max > 2.05) stops.add(Math.round(max * 10) / 10);
  return [...stops].filter((z) => z >= min && z <= max).sort((a, b) => a - b);
}

// Rectangle the video actually occupies inside a WxH box under object-contain (letterbox
// bars included). Used to map corner fractions ↔ screen pixels regardless of orientation.
function fitRect(cw: number, ch: number, vw: number, vh: number) {
  if (!vw || !vh) return { dx: 0, dy: 0, dw: cw, dh: ch };
  const scale = Math.min(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
}
