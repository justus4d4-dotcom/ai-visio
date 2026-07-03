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
import { warpQuadToCanvas, type Point } from "@/lib/warp";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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

export default function CameraCapture() {
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
  const [fps, setFps] = useState(2);
  const [preset, setPreset] = useState(1); // Medium
  const [corners, setCorners] = useState<Point[]>(DEFAULT_CORNERS);
  const [insecure, setInsecure] = useState(false);

  // Keep refs in sync so the streaming loop reads the latest values without re-subscribing.
  useEffect(() => {
    cornersRef.current = corners;
  }, [corners]);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setInsecure(true);
      setError("Camera API unavailable. On iPhone the page must be opened over HTTPS.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setReady(true);
    } catch (e) {
      setInsecure(!window.isSecureContext);
      setError(
        !window.isSecureContext
          ? "iOS blocks the camera on insecure pages. Serve the app over HTTPS, then reload."
          : `Could not open the camera: ${e instanceof Error ? e.message : "denied"}`,
      );
    }
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
    setStreaming(false);
  }

  // Draw the corner overlay (quad + handles) on top of the live video.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = overlayRef.current;
      const video = videoRef.current;
      if (canvas && video && video.videoWidth) {
        const rect = video.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const pts = cornersRef.current.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height }));
          ctx.strokeStyle = "#6366f1";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.stroke();
          ctx.fillStyle = "rgba(99,102,241,0.9)";
          for (const p of pts) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
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
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
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
    const period = Math.max(250, 1000 / Math.max(1, fps));

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
            setStatus(r.ok ? "streaming" : `error ${r.status}`);
          } catch {
            setStatus("offline — check the server address");
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

  useEffect(() => () => stopCamera(), []);

  return (
    <main className="mx-auto min-h-screen max-w-md p-4 text-neutral-100">
      <h1 className="text-lg font-semibold">iPhone camera capture</h1>
      <p className="mt-1 text-sm text-neutral-400">
        Point the rear camera at the screen, drag the four dots onto its corners, then start
        streaming. The desktop app solves the flattened image.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-900 bg-red-950/60 p-3 text-sm text-red-300">
          {error}
          {insecure && (
            <p className="mt-2 text-xs text-red-400">
              Open this page via <code>https://…</code> or <code>localhost</code>. On the LAN,
              put the frontend behind HTTPS (self-signed cert or a reverse proxy).
            </p>
          )}
        </div>
      )}

      <div className="relative mt-4 overflow-hidden rounded-xl border border-neutral-800 bg-black">
        <video ref={videoRef} className="w-full" muted playsInline />
        <canvas
          ref={overlayRef}
          className="absolute inset-0 h-full w-full touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
            Tap “Open camera” to begin
          </div>
        )}
      </div>

      <canvas ref={warpRef} className="hidden" />

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400">Output size</span>
          <select
            value={preset}
            onChange={(e) => setPreset(Number(e.target.value))}
            className="rounded-lg border border-neutral-700 bg-neutral-950 p-2"
          >
            {OUTPUT_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400">Frames / sec</span>
          <input
            type="number"
            min={1}
            max={5}
            value={fps}
            onChange={(e) => setFps(Number(e.target.value) || 1)}
            className="rounded-lg border border-neutral-700 bg-neutral-950 p-2"
          />
        </label>
      </div>

      <div className="mt-4 flex gap-3">
        {!ready ? (
          <button
            onClick={startCamera}
            className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 font-medium hover:bg-indigo-500"
          >
            Open camera
          </button>
        ) : (
          <>
            {!streaming ? (
              <button
                onClick={startStreaming}
                className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 font-medium hover:bg-indigo-500"
              >
                Start streaming
              </button>
            ) : (
              <button
                onClick={stopStreaming}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 font-medium hover:bg-red-500"
              >
                Stop streaming
              </button>
            )}
            <button
              onClick={stopCamera}
              className="rounded-lg border border-neutral-700 px-4 py-2.5 hover:bg-neutral-800"
            >
              Close
            </button>
          </>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-neutral-400">
        <button onClick={() => setCorners(DEFAULT_CORNERS)} className="underline">
          Reset corners
        </button>
        <span className="flex items-center gap-2">
          <span
            className={
              "inline-block h-2 w-2 rounded-full " +
              (status === "streaming" ? "bg-green-500 animate-pulse" : status === "idle" ? "bg-neutral-600" : "bg-red-500")
            }
          />
          {status}
        </span>
      </div>
    </main>
  );
}
