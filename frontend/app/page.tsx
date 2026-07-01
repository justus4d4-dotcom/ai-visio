"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_CONFIG,
  DEFAULT_GEMINI_MODELS,
  loadConfig,
  saveConfig,
  type ProviderConfig,
  type SolveResult,
} from "@/lib/settings";
import { aHashFromBlob, aHashFromVideo, hamming } from "@/lib/vision";
import Modal from "@/components/Modal";
import HistoryView from "@/components/HistoryView";
import UsageView from "@/components/UsageView";
import UpdateView from "@/components/UpdateView";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// How visually different (in aHash bits, 0..64) a frame must be from the last solved
// one to count as a NEW question, and how similar two consecutive samples must be to be
// considered "stable" (i.e. not mid-transition/animation).
const CHANGE_THRESHOLD = 6;
const STABLE_THRESHOLD = 3;

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SolveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<ProviderConfig>(DEFAULT_CONFIG);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showUsage, setShowUsage] = useState(false);

  const [auto, setAuto] = useState(false);
  const [intervalSec, setIntervalSec] = useState(3);
  const [autoStatus, setAutoStatus] = useState("idle");
  const lastSolvedHashRef = useRef<string | null>(null);
  const prevHashRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  // Bumped after every successful solve so the recent-answers list refreshes.
  const [historyTick, setHistoryTick] = useState(0);

  // Capture source: "browser" (this Chrome tab's screen share) or "agent" (the native
  // macOS Python agent that streams frames to the backend). The agent is the default
  // since it needs no per-tab screen share and survives page reloads.
  const [captureSource, setCaptureSource] = useState<"browser" | "agent">("agent");
  const [agentOnline, setAgentOnline] = useState(false);
  // Object URL of the latest frame fetched from the agent. Swapped only on a successful
  // fetch and cleared when frames stop, so the preview never freezes on a stale image.
  const [agentFrameUrl, setAgentFrameUrl] = useState<string | null>(null);
  // How many distinct agent processes the backend currently sees (for a duplicate warning).
  const [agentCount, setAgentCount] = useState(0);

  const [remoteStatus, setRemoteStatus] = useState("idle");
  const [deviceCount, setDeviceCount] = useState(0);

  useEffect(() => {
    setCfg(loadConfig());
  }, []);

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

  // Fetch the latest screen frame the native agent pushed to the backend.
  async function fetchAgentFrame(): Promise<Blob | null> {
    try {
      const res = await fetch(`${API_URL}/api/remote/frame`, { cache: "no-store" });
      // 204 = no fresh agent frame yet (a success, so the console stays quiet).
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
    // In "agent" mode the native app streams the screen to the backend; grab the latest
    // frame from there. Otherwise capture this tab's own screen share.
    const blob =
      captureSource === "agent" ? await fetchAgentFrame() : await grabFrame();
    if (!blob) {
      setError(
        captureSource === "agent"
          ? "No frame from the native agent yet. Is it running and selected?"
          : "No frame available. Is capture running?",
      );
      return null;
    }
    setBusy(true);
    busyRef.current = true;
    try {
      const form = new FormData();
      form.append("image", blob, "frame.png");
      form.append("provider", JSON.stringify(cfg));
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
      // The hash source depends on the active capture source (video vs agent frame).
      const solvedHash =
        captureSource === "agent"
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
    const ready = captureSource === "agent" ? agentOnline : capturing;
    if (!auto || !ready) {
      setAutoStatus("idle");
      return;
    }
    setAutoStatus("watching");
    const id = setInterval(async () => {
      if (busyRef.current) return;
      // Sample the current frame from whichever source is selected.
      let cur: string | null = null;
      if (captureSource === "agent") {
        const blob = await fetchAgentFrame();
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

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, capturing, agentOnline, captureSource, intervalSec, cfg]);

  async function selectSource(source: "browser" | "agent") {
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
    const id = setInterval(async () => {
      try {
        const s = await fetch(`${API_URL}/api/remote/source`).then((r) => r.json());
        setCaptureSource(s.source === "agent" ? "agent" : "browser");
        setAgentOnline(Boolean(s.agent_online));
        setAgentCount(s.agent_count ?? 0);
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => clearInterval(id);
  }, []);

  // Stream the native-agent preview by fetching frames and swapping the shown image only
  // on a successful fetch. When the agent stops (frames go stale → 404), clear the image
  // so the preview shows "no signal" instead of freezing on the last wallpaper frame.
  useEffect(() => {
    if (captureSource !== "agent") {
      setAgentFrameUrl(null);
      return;
    }
    let cancelled = false;
    let currentUrl: string | null = null;
    const tick = async () => {
      const blob = await fetchAgentFrame();
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
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
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
    if (!browserReady && !agentReady) {
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

    const id = setInterval(async () => {
      try {
        const poll = await fetch(`${API_URL}/api/remote/poll`).then((r) => r.json());
        if (poll.triggered && !busyRef.current && !stopped) {
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
      } catch {
        /* network blip; ignore */
      }
    }, 1200);

    return () => {
      stopped = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, cfg, captureSource, agentOnline]);

  // Poll how many ESP32 devices are connected over WebSocket.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const d = await fetch(`${API_URL}/api/remote/devices`).then((r) => r.json());
        setDeviceCount(d.count ?? 0);
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const previewOnline = captureSource === "agent" ? agentOnline : capturing;

  return (
    <main className="min-h-screen p-6 max-w-6xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="bg-gradient-to-r from-indigo-400 via-sky-400 to-emerald-400 bg-clip-text text-4xl font-black uppercase tracking-[0.2em] text-transparent drop-shadow-[0_1px_12px_rgba(56,189,248,0.25)]">
            AI VISIO
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHistory(true)}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            History
          </button>
          <button
            onClick={() => setShowUsage(true)}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Monitoring
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Settings
          </button>
        </div>
      </header>

      {showHistory && (
        <Modal title="History" onClose={() => setShowHistory(false)}>
          <HistoryView />
        </Modal>
      )}

      {showUsage && (
        <Modal title="Monitoring" onClose={() => setShowUsage(false)}>
          <UsageView />
        </Modal>
      )}

      {showSettings && (
        <Modal
          title="Settings"
          subtitle="Google Gemini (BYOK)"
          onClose={() => setShowSettings(false)}
        >
          <SettingsPanel
            cfg={cfg}
            onChange={setCfg}
            onSave={() => {
              saveConfig(cfg);
              setShowSettings(false);
            }}
          />
          <div className="mt-8 border-t border-neutral-800 pt-6">
            <h3 className="text-sm font-semibold text-neutral-200">Update</h3>
            <div className="mt-3">
              <UpdateView />
            </div>
          </div>
        </Modal>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* LEFT: live preview + interpreted answer. */}
        <section className="space-y-4">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-neutral-800 bg-black">
            {/* Browser capture shows the live getDisplayMedia stream. */}
            <video
              ref={videoRef}
              className={
                "h-full w-full object-contain " +
                (captureSource === "agent" ? "hidden" : "")
              }
              muted
            />
            {/* Native agent: preview the frames it streams to the backend. */}
            {captureSource === "agent" &&
              (agentFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={agentFrameUrl}
                  alt="Native agent screen"
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm text-neutral-500">
                  {agentOnline
                    ? "Native agent online — waiting for a frame…"
                    : "Native agent offline — start it to see a preview"}
                </div>
              ))}
            {captureSource === "browser" && !capturing && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
                Start capture to preview the screen
              </div>
            )}
          </div>

          {error && (
            <p className="rounded-lg border border-red-900 bg-red-950/60 p-3 text-sm text-red-300">
              {error}
            </p>
          )}

          <ResultPanel
            busy={busy}
            result={result}
            onSolve={solveNow}
            canSolve={previewOnline && !busy}
          />
        </section>

        {/* RIGHT: controls + device overview + recent answers. */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-neutral-300">Capture source</h2>
              <span className="flex items-center gap-2 text-xs text-neutral-400">
                <span
                  className={
                    "inline-block h-2 w-2 rounded-full " +
                    (agentOnline ? "bg-green-500" : "bg-neutral-600")
                  }
                />
                {agentOnline ? "agent online" : "agent offline"}
              </span>
            </div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-neutral-700">
              <button
                onClick={() => selectSource("browser")}
                className={
                  "flex-1 px-3 py-1.5 text-xs " +
                  (captureSource === "browser"
                    ? "bg-indigo-600 text-white"
                    : "hover:bg-neutral-800")
                }
              >
                Browser
              </button>
              <button
                onClick={() => selectSource("agent")}
                disabled={!agentOnline}
                title={
                  agentOnline
                    ? "Use the native macOS screen agent"
                    : "Start the native agent (see agent/README.md)"
                }
                className={
                  "flex-1 px-3 py-1.5 text-xs disabled:opacity-40 " +
                  (captureSource === "agent"
                    ? "bg-indigo-600 text-white"
                    : "hover:bg-neutral-800")
                }
              >
                Native app
              </button>
            </div>
            {agentCount > 1 && (
              <p className="mt-3 rounded-lg border border-amber-900 bg-amber-950/60 p-2 text-xs text-amber-300">
                {agentCount} agents are running — stop all but one, or the preview will
                flicker between their screens. A launchd auto-start and a manual/Raycast
                start can both be live at once (see agent/README.md).
              </p>
            )}
            {captureSource === "browser" &&
              (!capturing ? (
                <button
                  onClick={startCapture}
                  className="mt-3 w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500"
                >
                  Start capture
                </button>
              ) : (
                <button
                  onClick={stopCapture}
                  className="mt-3 w-full rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800"
                >
                  Stop
                </button>
              ))}
          </div>

          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <h2 className="text-sm font-medium text-neutral-300">Auto-detect</h2>
                <InfoHint text="Interprets automatically when the screen content changes and settles. Works with the active capture or the native agent." />
              </div>
              <span className="flex items-center gap-2 text-xs text-neutral-400">
                <span
                  className={
                    "inline-block h-2 w-2 rounded-full " +
                    (autoStatus === "watching"
                      ? "bg-green-500"
                      : autoStatus.includes("interpreting")
                        ? "bg-amber-400 animate-pulse"
                        : "bg-neutral-600")
                  }
                />
                {autoStatus}
              </span>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
                disabled={!previewOnline}
                className="h-4 w-4 accent-indigo-500"
              />
              Auto-detect changes
            </label>
            <label className="mt-2 flex items-center gap-1 text-xs text-neutral-400">
              every
              <input
                type="number"
                min={1}
                max={30}
                value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value) || 1)}
                className="w-14 rounded border border-neutral-700 bg-neutral-950 p-1 text-center text-sm"
              />
              seconds
            </label>
          </div>

          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <h2 className="text-sm font-medium text-neutral-300">ESP32 display</h2>
                <InfoHint text="The device's whole screen is a button: a touch interprets the current frame and shows the answer." />
              </div>
              <span className="flex items-center gap-2 text-xs text-neutral-400">
                <span
                  className={
                    "inline-block h-2 w-2 rounded-full " +
                    (remoteStatus === "done"
                      ? "bg-green-500"
                      : remoteStatus === "solving"
                        ? "bg-amber-400 animate-pulse"
                        : remoteStatus === "error"
                          ? "bg-red-500"
                          : "bg-neutral-600")
                  }
                />
                {remoteStatus}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span
                className={
                  "rounded px-1.5 py-0.5 text-xs " +
                  (deviceCount > 0
                    ? "bg-green-900 text-green-300"
                    : "bg-neutral-800 text-neutral-400")
                }
              >
                {deviceCount} connected
              </span>
            </div>
          </div>

          <RecentAnswers
            refreshKey={historyTick}
            onOpenHistory={() => setShowHistory(true)}
          />
        </aside>
      </div>
    </main>
  );
}

// Small "i" badge that reveals an explainer on hover, saving vertical space that a
// permanent caption would take.
function InfoHint({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="ml-1.5 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-neutral-600 text-[10px] font-medium text-neutral-400 hover:border-neutral-400 hover:text-neutral-200"
    >
      i
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
      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-indigo-900/60 bg-neutral-900 p-10">
        <div className="flex items-end gap-1.5">
          <span className="h-3 w-3 animate-bounce rounded-full bg-indigo-400 [animation-delay:-0.3s]" />
          <span className="h-3 w-3 animate-bounce rounded-full bg-indigo-400 [animation-delay:-0.15s]" />
          <span className="h-3 w-3 animate-bounce rounded-full bg-indigo-400" />
        </div>
        <p className="animate-pulse text-sm font-medium text-indigo-300">Thinking…</p>
        <p className="text-xs text-neutral-500">
          Sent to Gemini — interpreting the frame
        </p>
      </div>
    );
  }
  return <AnswerCard result={result} onSolve={onSolve} canSolve={canSolve} />;
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
      <div className="flex justify-center rounded-xl border border-neutral-800 bg-neutral-900 p-8">
        <button
          onClick={onSolve}
          disabled={!canSolve}
          className="flex aspect-square w-56 flex-col items-center justify-center gap-1 rounded-full border border-neutral-700 bg-gradient-to-b from-neutral-800 to-neutral-950 text-center shadow-inner shadow-black/60 transition hover:border-indigo-500 hover:from-neutral-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-lg font-semibold text-neutral-100">Interpret now</span>
          <span className="text-xs text-neutral-500">Tap to read the frame</span>
        </button>
      </div>
    );
  }
  const conf = Math.round(result.confidence * 100);
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
      <div className="flex items-baseline justify-between">
        <span className="text-5xl font-bold tracking-wide text-green-400">
          {result.answer_letters.join(" ") || "—"}
        </span>
        <span className="text-xs text-neutral-500">{result.question_type}</span>
      </div>
      <p className="mt-3 text-sm">{result.answer_text}</p>
      <div className="mt-4 h-2 w-full overflow-hidden rounded bg-neutral-800">
        <div className="h-full bg-green-500" style={{ width: `${conf}%` }} />
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        Confidence {conf}%
        {result.cached && (
          <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">
            cached · no API call
          </span>
        )}
      </p>
      {result.reasoning && (
        <p className="mt-3 text-xs text-neutral-400">{result.reasoning}</p>
      )}
      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-neutral-500">
          Question · {result.model}
          {result.elapsed_ms ? ` · ${(result.elapsed_ms / 1000).toFixed(1)}s` : ""}
          {result.tokens_used ? ` · ${result.tokens_used} tokens` : ""}
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-3 text-xs text-neutral-400">
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
        const res = await fetch(`${API_URL}/api/history?limit=5`);
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
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-300">Recent answers</h2>
        <button
          onClick={onOpenHistory}
          className="text-xs text-indigo-400 hover:underline"
        >
          View all
        </button>
      </div>
      {error ? (
        <p className="mt-3 text-xs text-neutral-500">
          History unavailable — is the backend database running?
        </p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-xs text-neutral-500">
          No answers yet. Interpret a frame and it will appear here.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2"
            >
              <span className="text-lg font-bold text-green-400">
                {it.answer_letters.join(" ") || "—"}
              </span>
              <div className="min-w-0 flex-1">
                {it.answer_text && (
                  <p className="truncate text-xs text-neutral-200">{it.answer_text}</p>
                )}
                <p className="text-[11px] text-neutral-500">
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
  onSave,
}: {
  cfg: ProviderConfig;
  onChange: (c: ProviderConfig) => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<ProviderConfig>) => onChange({ ...cfg, ...patch });

  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

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
    setTestMsg(null);
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
      setTestOk(true);
      setTestMsg(`Connected — ${list.length} models available.`);
    } catch (e) {
      setTestOk(false);
      setTestMsg(e instanceof Error ? e.message : "Connection failed.");
    } finally {
      setTesting(false);
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
      <p className="text-xs text-neutral-500">
        Get a key at{" "}
        <a
          className="underline"
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noreferrer"
        >
          aistudio.google.com/apikey
        </a>
        . Stored only in this browser for now. <i>lite</i> models are the cheapest.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="col-span-full text-xs">
          Gemini API key
          <input
            type="password"
            value={cfg.api_key}
            onChange={(e) => set({ api_key: e.target.value })}
            placeholder="AIza…"
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-sm"
          />
        </label>

        <label className="text-xs">
          Model
          <select
            value={sortedModels.includes(cfg.model) ? cfg.model : CUSTOM}
            onChange={(e) => {
              if (e.target.value !== CUSTOM) set({ model: e.target.value });
              else set({ model: "" });
            }}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-sm"
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
              className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-sm"
            />
          )}
        </label>
      </div>

      <details className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
        <summary className="cursor-pointer select-none text-sm font-medium text-neutral-200">
          Fine-tuning · quality vs speed
        </summary>
        <p className="mt-1 text-xs text-neutral-500">
          Bigger images / higher detail / thinking &amp; escalation improve accuracy but
          cost speed. Lower them for faster, cheaper solves.
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
            <span className="text-[10px] text-neutral-500">
              Higher = more legible text, slower. ~1280 suits 1080p; ~1568–2048 for 4K.
            </span>
          </label>

          <label className="text-xs">
            Image detail (media resolution)
            <select
              value={cfg.media_resolution ?? "medium"}
              onChange={(e) =>
                set({ media_resolution: e.target.value as "low" | "medium" | "high" })
              }
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-sm"
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
            <span className="text-[10px] text-neutral-500">
              0 = deterministic (recommended for exams). Higher = more varied.
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
            <span className="text-[10px] text-neutral-500">
              0 = off (fastest). Raise to help hard/multi-step questions.
            </span>
          </label>

          <label className="text-xs">
            Max answer tokens
            <input
              type="number"
              min={32}
              max={2048}
              step={16}
              value={cfg.max_output_tokens ?? 200}
              onChange={(e) => set({ max_output_tokens: Number(e.target.value) })}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-sm"
            />
          </label>

          <label className="flex items-center gap-2 self-end text-xs">
            <input
              type="checkbox"
              checked={cfg.auto_escalate ?? true}
              onChange={(e) => set({ auto_escalate: e.target.checked })}
              className="h-4 w-4"
            />
            Auto-escalate to a stronger model if unreadable
            <span className="text-[10px] text-neutral-500">(off = faster)</span>
          </label>

          <label className="col-span-full text-xs">
            <span className="flex items-center justify-between">
              System prompt
              <button
                type="button"
                onClick={() => set({ system_prompt: "" })}
                className="text-[10px] text-indigo-400 hover:underline"
              >
                Reset to default
              </button>
            </span>
            <textarea
              value={cfg.system_prompt ? cfg.system_prompt : defaultPrompt}
              onChange={(e) => set({ system_prompt: e.target.value })}
              rows={10}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 p-2 font-mono text-xs"
            />
            <span className="text-[10px] text-neutral-500">
              The exact instruction sent to Gemini. Edit to change behaviour; “Reset to
              default” reverts to the built-in prompt (also used while left unchanged).
            </span>
          </label>

          <label className="col-span-full text-xs">
            Extra context (appended to the prompt)
            <textarea
              value={cfg.extra_context ?? ""}
              onChange={(e) => set({ extra_context: e.target.value })}
              placeholder="e.g. Questions are in German about AWS. Prefer the AWS-recommended answer."
              rows={2}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-xs"
            />
          </label>
        </div>
      </details>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={onSave}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500"
        >
          Save
        </button>
        <button
          onClick={testConnection}
          disabled={testing || !cfg.api_key}
          className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800 disabled:opacity-40"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        {testMsg && (
          <span className={"text-xs " + (testOk ? "text-green-400" : "text-red-400")}>
            {testMsg}
          </span>
        )}
      </div>
    </div>
  );
}
