"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_CONFIG,
  DEFAULT_GEMINI_MODELS,
  cachedAccount,
  loadAccount,
  loadCachedModels,
  saveCachedModels,
  saveProvider,
  type ProviderConfig,
  type SolveResult,
} from "@/lib/settings";
import { aHashFromBlob, aHashFromVideo, hamming } from "@/lib/vision";
import { startPolling } from "@/lib/poll";
import Drawer from "@/components/Drawer";
import Markdown from "@/components/Markdown";
import UpdateBanner from "@/components/UpdateBanner";
import HistoryView from "@/components/HistoryView";
import UsageView from "@/components/UsageView";
import UpdateView from "@/components/UpdateView";
import DeviceOtaView from "@/components/DeviceOtaView";
import ProfileView from "@/components/ProfileView";
import AdminView from "@/components/AdminView";
import TopNav from "@/components/TopNav";
import type { AccountAction } from "@/components/AccountMenu";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// How visually different (in aHash bits, 0..64) a frame must be from the last solved
// one to count as a NEW question, and how similar two consecutive samples must be to be
// considered "stable" (i.e. not mid-transition/animation).
const CHANGE_THRESHOLD = 6;
const STABLE_THRESHOLD = 3;

// localStorage key for cached case-study scenario transcripts.
const CASE_STORAGE_KEY = "aiexams.case";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const router = useRouter();

  // On a phone, jump straight to the /camera page (the phone's job is to be a capture
  // source) unless the user explicitly chose the full app via the camera page's "App"
  // button (which sets the sessionStorage flag).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let prefersFull = false;
    try {
      prefersFull = sessionStorage.getItem("ai_visio_prefer_full") === "1";
    } catch {
      /* ignore */
    }
    // A phone in any orientation: a coarse pointer plus either a mobile UA or a short
    // side ≤ 500px (landscape phones are wider than 767px, so a width breakpoint alone
    // misses them; the min() of the two dimensions is the phone's short edge).
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const isPhone =
      coarse &&
      (/Android|iPhone|iPod|Mobile/i.test(navigator.userAgent) ||
        Math.min(window.innerWidth, window.innerHeight) <= 500);
    if (isPhone && !prefersFull) router.replace("/camera");
  }, [router]);

  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SolveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<ProviderConfig>(DEFAULT_CONFIG);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);

  const [auto, setAuto] = useState(false);
  const [intervalSec, setIntervalSec] = useState(3);
  const [autoStatus, setAutoStatus] = useState("idle");
  const lastSolvedHashRef = useRef<string | null>(null);
  const prevHashRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  // Bumped after every successful solve so the recent-answers list refreshes.
  const [historyTick, setHistoryTick] = useState(0);

  // Capture source: "browser" (this Chrome tab's screen share), "agent" (the native
  // macOS Python agent that streams frames to the backend), or "camera" (an iPhone
  // pointing at the screen via the /camera page). The agent is the default since it needs
  // no per-tab screen share and survives page reloads. Both agent and camera push frames
  // to the backend and are solved here, so only "browser" captures locally.
  const [captureSource, setCaptureSource] = useState<"browser" | "agent" | "camera">("agent");
  const [agentOnline, setAgentOnline] = useState(false);
  // Whether the iPhone /camera page is currently streaming frames to the backend.
  const [cameraOnline, setCameraOnline] = useState(false);
  // Object URL of the latest frame fetched from a remote source (agent or camera). Swapped
  // only on a successful fetch and cleared when frames stop, so the preview never freezes.
  const [agentFrameUrl, setAgentFrameUrl] = useState<string | null>(null);
  // How many distinct agent processes the backend currently sees (for a duplicate warning).
  const [agentCount, setAgentCount] = useState(0);

  const [remoteStatus, setRemoteStatus] = useState("idle");
  const [deviceCount, setDeviceCount] = useState(0);

  // Case study: cached scenario transcripts. The "fake company" scenario screens are
  // captured + transcribed once and sent as case_context on every solve so the model
  // reads the requirements before answering the question screen. Held in the browser.
  const [caseScenarios, setCaseScenarios] = useState<string[]>([]);
  const [caseBusy, setCaseBusy] = useState(false);
  const caseScenariosRef = useRef<string[]>([]);
  // Auto-save provider settings shortly after any change (no manual Save button).
  const cfgSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleCfgChange(next: ProviderConfig) {
    setCfg(next);
    if (cfgSaveRef.current) clearTimeout(cfgSaveRef.current);
    cfgSaveRef.current = setTimeout(() => saveProvider(next), 600);
  }

  useEffect(() => {
    // Account is the source of truth; show the cached settings instantly, then refresh
    // from the server so they follow the signed-in user across devices.
    setCfg(cachedAccount().provider);
    loadAccount()
      .then((a) => setCfg(a.provider))
      .catch(() => {});
    try {
      const raw = window.localStorage.getItem(CASE_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        caseScenariosRef.current = arr;
        setCaseScenarios(arr);
      }
    } catch {
      /* ignore corrupt cache */
    }
  }, []);

  function persistScenarios(next: string[]) {
    caseScenariosRef.current = next;
    setCaseScenarios(next);
    try {
      window.localStorage.setItem(CASE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage full/unavailable: keep in-memory */
    }
  }

  function clearCase() {
    persistScenarios([]);
  }

  // Capture the current frame as a case-study scenario screen: transcribe it via Gemini
  // and append it to the cached case context. Returns true on a non-empty transcript.
  async function captureScenario(): Promise<boolean> {
    if (!cfg.api_key) {
      setError("Add your Gemini API key in Settings first.");
      return false;
    }
    const blob =
      captureSource === "browser" ? await grabFrame() : await fetchRemoteFrame();
    if (!blob) {
      setError("No frame to capture. Is the selected source streaming?");
      return false;
    }
    setCaseBusy(true);
    busyRef.current = true; // block auto-detect/solve while capturing
    try {
      const form = new FormData();
      form.append("image", blob, "scenario.png");
      form.append("provider", JSON.stringify(cfg));
      const res = await fetch(`${API_URL}/api/extract-scenario`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail ?? `Capture failed (${res.status})`);
      }
      const data = await res.json();
      const text = (data.text ?? "").trim();
      if (!text) {
        setError("No scenario text found on that screen.");
        return false;
      }
      persistScenarios([...caseScenariosRef.current, text]);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scenario capture failed.");
      return false;
    } finally {
      setCaseBusy(false);
      busyRef.current = false;
    }
  }

  async function startCapture() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      stream.getVideoTracks()[0].addEventListener("ended", stopCapture);
      setCapturing(true);
    } catch {
      setError("Screen capture was cancelled or denied.");
    }
  }

  function stopCapture() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCapturing(false);
    setAuto(false);
    prevHashRef.current = null;
    lastSolvedHashRef.current = null;
  }

  function grabFrame(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return resolve(null);
      // Downscale to a max edge before upload (smaller = faster network + Gemini).
      const MAX_EDGE = 1024;
      const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(video, 0, 0, w, h);
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82);
    });
  }

  // Fetch the latest frame a remote source pushed to the backend. The endpoint depends on
  // the active source: the native agent streams to /frame, the iPhone to /camera/frame.
  async function fetchRemoteFrame(): Promise<Blob | null> {
    const path = captureSource === "camera" ? "camera/frame" : "frame";
    try {
      const res = await fetch(`${API_URL}/api/remote/${path}`, { cache: "no-store" });
      // 204 = no fresh frame yet (a success, so the console stays quiet).
      if (!res.ok || res.status === 204) return null;
      const blob = await res.blob();
      return blob.size > 0 ? blob : null;
    } catch {
      return null;
    }
  }

  async function solveNow(): Promise<SolveResult | null> {
    setError(null);
    if (!cfg.api_key) {
      setShowSettings(true);
      setError("Add your Gemini API key in Settings first.");
      return null;
    }
    // In "agent"/"camera" mode a remote source streams the screen to the backend; grab the
    // latest frame from there. In "browser" mode capture this tab's own screen share.
    const blob =
      captureSource === "browser" ? await grabFrame() : await fetchRemoteFrame();
    if (!blob) {
      setError(
        captureSource === "agent"
          ? "No frame from the native agent yet. Is it running and selected?"
          : captureSource === "camera"
            ? "No frame from the iPhone yet. Open /camera on the phone and start streaming."
            : "No frame available. Is capture running?",
      );
      return null;
    }
    setBusy(true);
    busyRef.current = true;
    try {
      const form = new FormData();
      form.append("image", blob, "frame.png");
      // Attach the cached case-study context (if any) so the model reads the scenario
      // requirements before answering. Merged per request; never saved to Settings.
      const caseContext = caseScenariosRef.current.join("\n\n---\n\n");
      const solveCfg = caseContext ? { ...cfg, case_context: caseContext } : cfg;
      form.append("provider", JSON.stringify(solveCfg));
      const res = await fetch(`${API_URL}/api/solve`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail ?? `Request failed (${res.status})`);
      }
      const data: SolveResult = await res.json();
      setResult(data);
      setHistoryTick((t) => t + 1);
      // Push the answer to the ESP32 so its screen updates for every solve — manual,
      // auto-detect, or device-triggered. Fire-and-forget so it never blocks the UI.
      fetch(`${API_URL}/api/remote/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).catch(() => {
        /* device may be offline; ignore */
      });
      // Remember what we just solved so auto-detection won't re-solve the same screen.
      // The hash source depends on the active capture source (video vs pushed frame).
      const solvedHash =
        captureSource !== "browser"
          ? await aHashFromBlob(blob)
          : videoRef.current
            ? aHashFromVideo(videoRef.current)
            : null;
      if (solvedHash) lastSolvedHashRef.current = solvedHash;
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Solve failed.");
      return null;
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }

  // Auto-detection: sample the screen on an interval and only solve when the content
  // changed (vs the last solved frame) AND is stable (vs the previous sample). Works for
  // both capture sources: the browser video stream or the native agent's pushed frames.
  useEffect(() => {
    const ready =
      captureSource === "browser" ? capturing : captureSource === "agent" ? agentOnline : cameraOnline;
    if (!auto || !ready) {
      setAutoStatus("idle");
      return;
    }
    setAutoStatus("watching");
    const stop = startPolling(async () => {
      if (busyRef.current) return;
      // Sample the current frame from whichever source is selected.
      let cur: string | null = null;
      if (captureSource !== "browser") {
        const blob = await fetchRemoteFrame();
        if (blob) cur = await aHashFromBlob(blob);
      } else if (videoRef.current) {
        cur = aHashFromVideo(videoRef.current);
      }
      if (!cur) return;

      const prev = prevHashRef.current;
      prevHashRef.current = cur;
      const stable = prev !== null && hamming(cur, prev) <= STABLE_THRESHOLD;
      const last = lastSolvedHashRef.current;
      const changed = last === null || hamming(cur, last) > CHANGE_THRESHOLD;

      if (stable && changed) {
        setAutoStatus("change detected — interpreting…");
        await solveNow();
        setAutoStatus("watching");
      }
    }, Math.max(1, intervalSec) * 1000);

    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, capturing, agentOnline, cameraOnline, captureSource, intervalSec, cfg]);

  async function selectSource(source: "browser" | "agent" | "camera") {
    setCaptureSource(source);
    // Switching sources: forget prior frame hashes so auto-detect re-baselines.
    prevHashRef.current = null;
    lastSolvedHashRef.current = null;
    try {
      await fetch(`${API_URL}/api/remote/source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
    } catch {
      setError("Could not update the capture source on the backend.");
    }
  }

  // Keep the selected source + agent status in sync with the backend.
  useEffect(() => {
    return startPolling(async () => {
      const r = await fetch(`${API_URL}/api/remote/source`);
      if (!r.ok) throw new Error(String(r.status));
      const s = await r.json();
      setCaptureSource(s.source === "agent" ? "agent" : s.source === "camera" ? "camera" : "browser");
      setAgentOnline(Boolean(s.agent_online));
      setCameraOnline(Boolean(s.camera_online));
      setAgentCount(s.agent_count ?? 0);
    }, 1500);
  }, []);

  // Stream the native-agent preview by fetching frames and swapping the shown image only
  // on a successful fetch. When the agent stops (frames go stale → 404), clear the image
  // so the preview shows "no signal" instead of freezing on the last wallpaper frame.
  useEffect(() => {
    if (captureSource === "browser") {
      setAgentFrameUrl(null);
      return;
    }
    let cancelled = false;
    let currentUrl: string | null = null;
    const tick = async () => {
      const blob = await fetchRemoteFrame();
      if (cancelled) return;
      if (blob) {
        const url = URL.createObjectURL(blob);
        setAgentFrameUrl(url);
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = url;
      } else {
        setAgentFrameUrl(null);
        if (currentUrl) {
          URL.revokeObjectURL(currentUrl);
          currentUrl = null;
        }
      }
    };
    const stop = startPolling(tick, 1000);
    return () => {
      cancelled = true;
      stop();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [captureSource]);

  // ESP32 remote control: watch for a touch trigger from the device. On a trigger,
  // capture + interpret the current frame, then post the result back so the device can
  // display it. This browser tab answers triggers when it is the selected source
  // (browser + capturing), or when the native agent is the source (agent online).
  useEffect(() => {
    const browserReady = captureSource === "browser" && capturing;
    const agentReady = captureSource === "agent" && agentOnline;
    const cameraReady = captureSource === "camera" && cameraOnline;
    if (!browserReady && !agentReady && !cameraReady) {
      setRemoteStatus("idle");
      return;
    }
    let stopped = false;
    const post = (path: string, body: unknown) =>
      fetch(`${API_URL}/api/remote/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const stop = startPolling(async () => {
      const r = await fetch(`${API_URL}/api/remote/poll`);
      if (!r.ok) throw new Error(String(r.status));
      const poll = await r.json();
      if (poll.triggered && !busyRef.current && !stopped) {
        if (poll.action === "scenario") {
          // Case-study capture triggered from the ESP32: transcribe + cache the
          // current screen, then report the running count back to the device.
          const ok = await captureScenario();
          await post("scenario", { ok, count: caseScenariosRef.current.length });
        } else if (poll.action === "clear_case") {
          // The device left case-study mode: drop all cached scenario content.
          clearCase();
        } else {
          setRemoteStatus("solving");
          await post("status", { status: "solving" });
          const result = await solveNow();
          if (result) {
            await post("answer", result);
            setRemoteStatus("done");
          } else {
            await post("status", { status: "error" });
            setRemoteStatus("error");
          }
        }
      }
    }, 1200);

    return () => {
      stopped = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, cfg, captureSource, agentOnline, cameraOnline]);

  // Poll how many ESP32 devices are connected over WebSocket.
  useEffect(() => {
    return startPolling(async () => {
      const r = await fetch(`${API_URL}/api/remote/devices`);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setDeviceCount(d.count ?? 0);
    }, 3000);
  }, []);

  const previewOnline =
    captureSource === "browser" ? capturing : captureSource === "agent" ? agentOnline : cameraOnline;
  const sourceLabel =
    captureSource === "camera"
      ? cameraOnline
        ? "Camera online"
        : "Camera offline"
      : captureSource === "agent"
        ? agentOnline
          ? "Agent online"
          : "Agent offline"
        : capturing
          ? "Capturing"
          : "Browser idle";

  return (
    <main className="mx-auto min-h-[100dvh] max-w-6xl p-4 sm:p-6">
      <TopNav
        onSettings={() => setShowSettings(true)}
        onAccountAction={(a: AccountAction) => {
          if (a === "usage") setShowUsage(true);
          else if (a === "history") setShowHistory(true);
          else if (a === "profile") setShowProfile(true);
          else if (a === "admin") setShowAdmin(true);
        }}
      />

      <UpdateBanner onOpen={() => setShowSettings(true)} />

      {showProfile && (
        <Drawer title="Profile" onClose={() => setShowProfile(false)}>
          <ProfileView />
        </Drawer>
      )}

      {showAdmin && (
        <Drawer title="Admin" onClose={() => setShowAdmin(false)}>
          <AdminView />
        </Drawer>
      )}

      {showHistory && (
        <Drawer title="History" onClose={() => setShowHistory(false)}>
          <HistoryView />
        </Drawer>
      )}

      {showUsage && (
        <Drawer title="Monitoring" onClose={() => setShowUsage(false)}>
          <UsageView />
        </Drawer>
      )}

      {showSettings && (
        <Drawer
          title="Settings"
          onClose={() => setShowSettings(false)}
        >
          <SettingsPanel cfg={cfg} onChange={handleCfgChange} />
          <div className="mt-8 border-t border-line pt-6">
            <h3 className="text-sm font-semibold text-ink">Application</h3>
            <p className="text-xs text-ink-muted">Releases</p>
            <div className="mt-3">
              <UpdateView />
            </div>
          </div>
          <div className="mt-8 border-t border-line pt-6">
            <h3 className="text-sm font-semibold text-ink">Devices</h3>
            <div className="mt-3">
              <DeviceOtaView />
            </div>
          </div>
        </Drawer>
      )}

      <div className="mt-4 flex shrink-0 flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel p-2.5">
        {/* Capture source */}
        <div className="inline-flex gap-1 rounded-full border border-line bg-app p-1 text-sm">
          {(
            [
              ["agent", "App", agentOnline],
              ["browser", "Browser", true],
              ["camera", "Camera", cameraOnline],
            ] as const
          ).map(([src, label, online]) => {
            const selected = captureSource === src;
            return (
            <button
              key={src}
              onClick={() => selectSource(src)}
              className={
                "flex items-center gap-2 rounded-full px-3 py-1 transition " +
                (selected
                  ? "bg-accent font-medium text-accent-ink"
                  : "text-ink-muted hover:text-ink")
              }
            >
              {label}
              {src !== "browser" && (
                <span
                  className={
                    "inline-block h-1.5 w-1.5 rounded-full " +
                    (selected
                      ? online
                        ? "bg-accent-ink"
                        : "bg-accent-ink/40"
                      : online
                        ? "bg-sage"
                        : "bg-taupe-grey")
                  }
                />
              )}
            </button>
            );
          })}
        </div>

        {/* Browser capture start/stop */}
        {captureSource === "browser" &&
          (capturing ? (
            <button
              onClick={stopCapture}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-panel-2"
            >
              Stop capture
            </button>
          ) : (
            <button
              onClick={startCapture}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90"
            >
              Start capture
            </button>
          ))}

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
            disabled={!previewOnline}
            className="h-4 w-4 accent-accent"
          />
          Auto-detect
        </label>
        {auto && (
          <label className="flex items-center gap-1 text-xs text-ink-muted">
            every
            <input
              type="number"
              min={1}
              max={30}
              value={intervalSec}
              onChange={(e) => setIntervalSec(Number(e.target.value) || 1)}
              className="w-14 rounded border border-line bg-app p-1 text-center text-sm text-ink"
            />
            s
          </label>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <StatusChip label={sourceLabel} ok={previewOnline} />
          <StatusChip label={`${deviceCount} device${deviceCount === 1 ? "" : "s"}`} ok={deviceCount > 0} />
          {autoStatus !== "idle" && <span className="text-accent">{autoStatus}</span>}
          {remoteStatus !== "idle" && <span className="text-ink-muted">esp: {remoteStatus}</span>}
          <button
            type="button"
            onClick={captureScenario}
            disabled={!previewOnline || caseBusy}
            title="Add the current frame as context for the model"
            aria-label="Add context"
            className="flex items-center gap-1.5 rounded-lg border border-accent px-2.5 py-1.5 text-sm font-medium text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {caseScenarios.length > 0 && (
              <span className="text-xs font-semibold">{caseScenarios.length}</span>
            )}
          </button>
          {caseScenarios.length > 0 && (
            <button
              type="button"
              onClick={clearCase}
              title="Clear context"
              aria-label="Clear context"
              className="flex items-center justify-center rounded-lg border border-red-500 px-2 py-1.5 text-red-600 hover:bg-red-500/10 dark:text-red-400"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={solveNow}
            disabled={!previewOnline || busy}
            title="Analyse the current frame"
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
              <path d="M11 8v6M8 11h6" />
            </svg>
            {busy ? "Analysing…" : "Analyse"}
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-stretch">
        {/* Left column: preview + recent answers. */}
        <div className="flex flex-1 flex-col gap-4">
        {/* Screen / camera preview. */}
        <section className="flex flex-col rounded-2xl border border-line bg-panel p-3">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-panel-2">
            {/* Browser capture shows the live getDisplayMedia stream. */}
            <video
              ref={videoRef}
              className={
                "h-full w-full object-contain " +
                (captureSource !== "browser" ? "hidden" : "")
              }
              muted
            />
            {/* Remote sources (native agent / iPhone camera): preview the pushed frames. */}
            {captureSource !== "browser" &&
              (agentFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={agentFrameUrl}
                  alt={captureSource === "camera" ? "Camera" : "App screen"}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center p-4">
                  {previewOnline ? (
                    <p className="text-sm text-ink-muted">Waiting for a frame…</p>
                  ) : (
                    <OfflineAlert label={captureSource === "camera" ? "Camera offline" : "App offline"} />
                  )}
                </div>
              ))}
            {captureSource === "browser" && !capturing && (
              <div className="absolute inset-0 flex items-center justify-center p-4">
                <OfflineAlert label="Browser offline" />
              </div>
            )}
          </div>

          {agentCount > 1 && (
            <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              {agentCount} agents running — stop all but one to avoid a flickering preview.
            </p>
          )}
          {error && (
            <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
              {error}
            </p>
          )}
        </section>

          {/* Recent answers (moved from the old case-study slot). */}
          <div>
            <RecentAnswers
              refreshKey={historyTick}
              onOpenHistory={() => setShowHistory(true)}
            />
          </div>
        </div>

        {/* Right column: interpreted result, full height. */}
        <section className="flex flex-1 flex-col gap-3">
          <div className="min-h-0 flex-1">
            <ResultPanel
              busy={busy}
              result={result}
              onSolve={solveNow}
              canSolve={previewOnline && !busy}
            />
          </div>
          {caseScenarios.length > 0 && (
            <details className="shrink-0 rounded-2xl border border-line bg-panel p-4">
              <summary className="cursor-pointer select-none text-sm font-medium text-ink">
                Context ·{" "}
                {caseScenarios.length} frame{caseScenarios.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-3 max-h-64 space-y-2 overflow-auto">
                {caseScenarios.map((s, i) => (
                  <div key={i} className="rounded-lg border border-line bg-app p-2">
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-ink-muted">
                      Frame {i + 1}
                    </p>
                    <div className="text-ink">
                      <Markdown>{s}</Markdown>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      </div>
    </main>
  );
}

// A compact pill showing a status label + on/off dot (control bar).
function StatusChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-panel-2 px-2 py-0.5 text-ink-muted">
      <span className={"inline-block h-1.5 w-1.5 rounded-full " + (ok ? "bg-sage" : "bg-taupe-grey")} />
      {label}
    </span>
  );
}

// Interactive result surface: shows an animated "thinking" state while a request is in
// flight, the answer once it lands, or an idle hint otherwise.
function ResultPanel({
  busy,
  result,
  onSolve,
  canSolve,
}: {
  busy: boolean;
  result: SolveResult | null;
  onSolve: () => void;
  canSolve: boolean;
}) {
  if (busy) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 rounded-2xl border border-accent/40 bg-panel p-10">
        <div className="flex items-end gap-1.5">
          <span className="h-3 w-3 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
          <span className="h-3 w-3 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
          <span className="h-3 w-3 animate-bounce rounded-full bg-accent" />
        </div>
        <p className="animate-pulse text-sm font-medium text-accent">Thinking…</p>
        <p className="text-xs text-ink-muted">
          Sent to Gemini — interpreting the frame
        </p>
      </div>
    );
  }
  return <AnswerCard result={result} onSolve={onSolve} canSolve={canSolve} />;
}

// Small alert shown over the (grey) preview when the selected source isn't available.
function OfflineAlert({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm font-medium text-ink shadow-sm">
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" strokeLinecap="round" />
        <circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
      </svg>
      {label}
    </div>
  );
}

function AnswerCard({
  result,
  onSolve,
  canSolve,
}: {
  result: SolveResult | null;
  onSolve: () => void;
  canSolve: boolean;
}) {
  if (!result) {
    return (
      <button
        type="button"
        onClick={canSolve ? onSolve : undefined}
        disabled={!canSolve}
        title={canSolve ? "Interpret the current frame" : undefined}
        className={
          "flex h-full w-full flex-col items-center justify-center gap-2 rounded-2xl border border-line bg-panel p-8 text-center " +
          (canSolve
            ? "cursor-pointer transition hover:border-accent active:scale-[0.99]"
            : "cursor-default")
        }
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-line text-ink-muted">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="3.5" />
          </svg>
        </div>
        <p className="text-sm font-medium text-ink">Waiting for a result</p>
        <p className="text-xs text-ink-muted">
          {canSolve
            ? "Tap to interpret the current frame."
            : "Turn on Auto-detect or trigger a read from the Display."}
        </p>
      </button>
    );
  }
  const conf = Math.round(result.confidence * 100);
  return (
    <div className="h-full rounded-2xl border border-line bg-panel p-6">
      <div className="flex items-baseline justify-between">
        <span className="text-5xl font-bold tracking-wide text-emerald-600 dark:text-emerald-300">
          {result.answer_letters.join(" ") || "—"}
        </span>
        <span className="text-xs text-ink-muted">{result.question_type}</span>
      </div>
      <p className="mt-3 text-sm font-medium">{result.answer_text}</p>
      {result.full_answer && result.full_answer !== result.answer_text && (
        <div className="mt-2 text-ink">
          <Markdown>{result.full_answer}</Markdown>
        </div>
      )}
      <div className="mt-4 h-2 w-full overflow-hidden rounded bg-panel-2">
        <div className="h-full bg-green-500" style={{ width: `${conf}%` }} />
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Confidence {conf}%
        {result.cached && (
          <span className="ml-2 rounded bg-panel-2 px-1.5 py-0.5 text-ink-muted">
            cached · no API call
          </span>
        )}
      </p>
      {result.reasoning && (
        <p className="mt-3 text-xs text-ink-muted">{result.reasoning}</p>
      )}
      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-ink-muted">
          Question · {result.model}
          {result.elapsed_ms ? ` · ${(result.elapsed_ms / 1000).toFixed(1)}s` : ""}
          {result.tokens_used ? ` · ${result.tokens_used} tokens` : ""}
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-app p-3 text-xs text-ink-muted">
          {result.question_text}
        </pre>
      </details>
    </div>
  );
}

type RecentItem = {
  id: string;
  answer_letters: string[];
  answer_text: string | null;
  question_type: string;
  created_at: string;
};

// Compact list of the last few answered questions. Refreshes whenever `refreshKey`
// changes (i.e. after a new solve) and every 15s as a fallback.
function RecentAnswers({
  refreshKey,
  onOpenHistory,
}: {
  refreshKey: number;
  onOpenHistory: () => void;
}) {
  const [items, setItems] = useState<RecentItem[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/api/history?limit=3`);
        if (!res.ok) throw new Error();
        const data: RecentItem[] = await res.json();
        if (!stopped) {
          setItems(data);
          setError(false);
        }
      } catch {
        if (!stopped) setError(true);
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [refreshKey]);

  return (
    <div className="flex flex-col rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink">Recent answers</h2>
        <button
          onClick={onOpenHistory}
          className="text-xs text-accent hover:underline"
        >
          View all
        </button>
      </div>
      {error ? (
        <p className="mt-3 text-xs text-ink-muted">
          History unavailable — is the backend database running?
        </p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          No answers yet. Interpret a frame and it will appear here.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-center gap-3 rounded-lg border border-line bg-app px-3 py-2"
            >
              <span className="text-lg font-bold text-emerald-600 dark:text-emerald-300">
                {it.answer_letters.join(" ") || "—"}
              </span>
              <div className="min-w-0 flex-1">
                {it.answer_text && (
                  <p className="truncate text-xs text-ink">{it.answer_text}</p>
                )}
                <p className="text-[11px] text-ink-muted">
                  {it.question_type} · {new Date(it.created_at).toLocaleTimeString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SettingsPanel({
  cfg,
  onChange,
}: {
  cfg: ProviderConfig;
  onChange: (c: ProviderConfig) => void;
}) {
  const set = (patch: Partial<ProviderConfig>) => onChange({ ...cfg, ...patch });

  const [provider, setProvider] = useState("google");
  const [models, setModels] = useState<string[]>(() => loadCachedModels());
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);

  // The built-in solver prompt, fetched so the field can show it for editing. When the
  // user leaves it unchanged we keep cfg.system_prompt empty so the backend always uses
  // its current default (no drift); editing it turns it into an override.
  const [defaultPrompt, setDefaultPrompt] = useState("");
  useEffect(() => {
    fetch(`${API_URL}/api/providers/default-prompt`)
      .then((r) => r.json())
      .then((d) => setDefaultPrompt(d.prompt ?? ""))
      .catch(() => {});
  }, []);

  async function testConnection() {
    setTesting(true);
    setTestOk(null);
    try {
      const res = await fetch(`${API_URL}/api/providers/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail ?? `Failed (${res.status})`);
      const list: string[] = data.models ?? [];
      setModels(list);
      saveCachedModels(list);
      setTestOk(true);
    } catch {
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  }

  // Re-fetch just the model list (no status message) for the refresh button.
  async function refreshModels() {
    if (!cfg.api_key) return;
    setRefreshing(true);
    try {
      const res = await fetch(`${API_URL}/api/providers/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const list: string[] = data.models ?? [];
        setModels(list);
        saveCachedModels(list);
      }
    } catch {
      /* ignore */
    } finally {
      setRefreshing(false);
    }
  }

  const merged = models.length > 0 ? models : DEFAULT_GEMINI_MODELS;
  // Cheaper "lite/flash" models first.
  const sortedModels = [...merged].sort((a, b) => {
    const score = (m: string) => (/lite/.test(m) ? 0 : /flash/.test(m) ? 1 : 2);
    return score(a) - score(b) || a.localeCompare(b);
  });
  const CUSTOM = "__custom__";

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">
          Model provider
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="mt-1 w-full rounded border border-line bg-app p-2 text-sm"
          >
            <option value="google">Google Gemini</option>
          </select>
        </label>
        {provider === "google" && (
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 self-end pb-2 text-xs text-accent hover:underline"
          >
            Get an API key at aistudio.google.com
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17 17 7M8 7h9v9" />
            </svg>
          </a>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="col-span-full text-xs">
          API key
          <input
            type="password"
            value={cfg.api_key}
            onChange={(e) => set({ api_key: e.target.value })}
            placeholder="AIza…"
            className="mt-1 w-full rounded border border-line bg-app p-2 text-sm"
          />
        </label>

        <label className="text-xs">
          <span className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              Model
              {testOk !== null && (
                <span
                  className={
                    "text-[10px] font-medium " +
                    (testOk
                      ? "text-emerald-600 dark:text-emerald-300"
                      : "text-red-600 dark:text-red-300")
                  }
                >
                  {testOk ? "Successful" : "Unsuccessful"}
                </span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={testConnection}
                disabled={!cfg.api_key || testing}
                title="Test connection"
                aria-label="Test connection"
                className="text-ink-muted hover:text-ink disabled:opacity-40"
              >
                {testing ? (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 3h6M10 3v5.5L5.4 17A2 2 0 0 0 7.2 20h9.6a2 2 0 0 0 1.8-3L14 8.5V3" />
                    <path d="M8.5 14h7" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={refreshModels}
                disabled={!cfg.api_key || refreshing}
                title="Refresh available models"
                aria-label="Refresh available models"
                className="text-ink-muted hover:text-ink disabled:opacity-40"
              >
                <svg
                  viewBox="0 0 24 24"
                  className={"h-3.5 w-3.5 " + (refreshing ? "animate-spin" : "")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
              </button>
            </span>
          </span>
          <select
            value={sortedModels.includes(cfg.model) ? cfg.model : CUSTOM}
            onChange={(e) => {
              if (e.target.value !== CUSTOM) set({ model: e.target.value });
              else set({ model: "" });
            }}
            className="mt-1 w-full rounded border border-line bg-app p-2 text-sm"
          >
            {sortedModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
          {!sortedModels.includes(cfg.model) && (
            <input
              value={cfg.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="type a model id"
              className="mt-2 w-full rounded border border-line bg-app p-2 text-sm"
            />
          )}
        </label>
      </div>

      <details className="mt-4 rounded-lg border border-line bg-panel/50 p-3">
        <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-ink">
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Advanced settings
        </summary>
        <p className="mt-1 text-xs text-ink-muted">
          Higher quality = slower/costlier. Lower for faster, cheaper solves.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs">
            Image size (longest edge): <b>{cfg.max_edge ?? 1280}px</b>
            <input
              type="range"
              min={512}
              max={2048}
              step={64}
              value={cfg.max_edge ?? 1280}
              onChange={(e) => set({ max_edge: Number(e.target.value) })}
              className="mt-1 w-full"
            />
            <span className="text-[10px] text-ink-muted">
              Sharper text, slower. ~1280 for 1080p, ~2048 for 4K.
            </span>
          </label>

          <label className="text-xs">
            Image detail (media resolution)
            <select
              value={cfg.media_resolution ?? "medium"}
              onChange={(e) =>
                set({ media_resolution: e.target.value as "low" | "medium" | "high" })
              }
              className="mt-1 w-full rounded border border-line bg-app p-2 text-sm"
            >
              <option value="low">low — fastest / cheapest</option>
              <option value="medium">medium — balanced (default)</option>
              <option value="high">high — most accurate / slowest</option>
            </select>
          </label>

          <label className="text-xs">
            Temperature: <b>{(cfg.temperature ?? 0).toFixed(1)}</b>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={cfg.temperature ?? 0}
              onChange={(e) => set({ temperature: Number(e.target.value) })}
              className="mt-1 w-full"
            />
            <span className="text-[10px] text-ink-muted">
              0 = deterministic (recommended).
            </span>
          </label>

          <label className="text-xs">
            Thinking budget (tokens): <b>{cfg.thinking_budget ?? 0}</b>
            <input
              type="range"
              min={0}
              max={2048}
              step={128}
              value={cfg.thinking_budget ?? 0}
              onChange={(e) => set({ thinking_budget: Number(e.target.value) })}
              className="mt-1 w-full"
            />
            <span className="text-[10px] text-ink-muted">
              0 = off (fastest). Raise for hard questions.
            </span>
          </label>

          <label className="text-xs">
            Max answer tokens
            <input
              type="number"
              min={32}
              max={2048}
              step={16}
              value={cfg.max_output_tokens ?? 800}
              onChange={(e) => set({ max_output_tokens: Number(e.target.value) })}
              className="mt-1 w-full rounded border border-line bg-app p-2 text-sm"
            />
          </label>

          <label className="text-xs">
            Request timeout (seconds)
            <input
              type="number"
              min={5}
              max={120}
              step={5}
              value={cfg.timeout_s ?? 30}
              onChange={(e) => set({ timeout_s: Number(e.target.value) })}
              className="mt-1 w-full rounded border border-line bg-app p-2 text-sm"
            />
            <span className="text-[10px] text-ink-muted">
              Aborts a hanging call. Raise for large images.
            </span>
          </label>

          <label className="flex items-center gap-2 self-end text-xs">
            <input
              type="checkbox"
              checked={cfg.auto_escalate ?? true}
              onChange={(e) => set({ auto_escalate: e.target.checked })}
              className="h-4 w-4"
            />
            Auto-escalate to a stronger model if unreadable
            <span className="text-[10px] text-ink-muted">(off = faster)</span>
          </label>

          <label className="col-span-full text-xs">
            <span className="flex items-center justify-between">
              System prompt
              <button
                type="button"
                onClick={() => set({ system_prompt: "" })}
                className="text-[10px] text-accent hover:underline"
              >
                Reset to default
              </button>
            </span>
            <textarea
              value={cfg.system_prompt ? cfg.system_prompt : defaultPrompt}
              onChange={(e) => set({ system_prompt: e.target.value })}
              rows={10}
              className="mt-1 w-full rounded border border-line bg-app p-2 font-mono text-xs"
            />
            <span className="text-[10px] text-ink-muted">
              The instruction sent to the model. “Reset” reverts to the default.
            </span>
          </label>

          <label className="col-span-full text-xs">
            Extra context (appended to the prompt)
            <textarea
              value={cfg.extra_context ?? ""}
              onChange={(e) => set({ extra_context: e.target.value })}
              placeholder="e.g. Questions are in German about AWS. Prefer the AWS-recommended answer."
              rows={2}
              className="mt-1 w-full rounded border border-line bg-app p-2 text-xs"
            />
          </label>
        </div>
      </details>
    </div>
  );
}
