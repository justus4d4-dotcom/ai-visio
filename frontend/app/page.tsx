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
import { aHashFromVideo, hamming } from "@/lib/vision";
import DeviceScreen, { type DeviceUiState } from "@/components/DeviceScreen";

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

  const [auto, setAuto] = useState(false);
  const [intervalSec, setIntervalSec] = useState(3);
  const [autoStatus, setAutoStatus] = useState("idle");
  const lastSolvedHashRef = useRef<string | null>(null);
  const prevHashRef = useRef<string | null>(null);
  const busyRef = useRef(false);

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

  async function solveNow(): Promise<SolveResult | null> {
    setError(null);
    if (!cfg.api_key) {
      setShowSettings(true);
      setError("Add your Gemini API key in Settings first.");
      return null;
    }
    const blob = await grabFrame();
    if (!blob) {
      setError("No frame available. Is capture running?");
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
      // Remember what we just solved so auto-detection won't re-solve the same screen.
      if (videoRef.current) {
        const h = aHashFromVideo(videoRef.current);
        if (h) lastSolvedHashRef.current = h;
      }
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
  // changed (vs the last solved frame) AND is stable (vs the previous sample).
  useEffect(() => {
    if (!auto || !capturing) {
      setAutoStatus("idle");
      return;
    }
    setAutoStatus("watching");
    const id = setInterval(async () => {
      const video = videoRef.current;
      if (!video || busyRef.current) return;
      const cur = aHashFromVideo(video);
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
  }, [auto, capturing, intervalSec, cfg]);

  // ESP32 remote control: while capturing, watch for a touch trigger from the device.
  // On a trigger, capture + interpret here in the browser, then post the result back so
  // the device can display it.
  const [remoteStatus, setRemoteStatus] = useState("idle");

  useEffect(() => {
    if (!capturing) {
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
  }, [capturing, cfg]);

  async function simulateTouch() {
    try {
      await fetch(`${API_URL}/api/remote/trigger`, { method: "POST" });
      setRemoteStatus("requested");
    } catch {
      setError("Could not reach the backend to simulate a touch.");
    }
  }

  // Map the page state onto the round-display states for the embedded simulator.
  const deviceState: DeviceUiState = error
    ? "error"
    : busy
      ? "solving"
      : result
        ? "answer"
        : "idle";

  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">AI Image Interpreter</h1>
          <p className="text-sm text-neutral-400">Vision interpreter — Gemini</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/history"
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            History
          </a>
          <button
            onClick={() => setShowSettings((s) => !s)}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Settings
          </button>
        </div>
      </header>

      {showSettings && (
        <SettingsPanel
          cfg={cfg}
          onChange={setCfg}
          onSave={() => {
            saveConfig(cfg);
            setShowSettings(false);
          }}
        />
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section className="space-y-3">
          <div className="aspect-video w-full overflow-hidden rounded-xl border border-neutral-800 bg-black">
            <video ref={videoRef} className="h-full w-full object-contain" muted />
          </div>
          <div className="flex gap-2">
            {!capturing ? (
              <button
                onClick={startCapture}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500"
              >
                Start capture
              </button>
            ) : (
              <button
                onClick={stopCapture}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800"
              >
                Stop
              </button>
            )}
            <button
              onClick={solveNow}
              disabled={!capturing || busy}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium hover:bg-green-500 disabled:opacity-40"
            >
              {busy ? "Interpreting…" : "Interpret now"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
                disabled={!capturing}
                className="h-4 w-4 accent-indigo-500"
              />
              Auto-detect changes
            </label>
            <label className="flex items-center gap-1 text-xs text-neutral-400">
              every
              <input
                type="number"
                min={1}
                max={30}
                value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value) || 1)}
                className="w-14 rounded border border-neutral-700 bg-neutral-950 p-1 text-center text-sm"
              />
              s
            </label>
            <span className="ml-auto flex items-center gap-2 text-xs text-neutral-400">
              <span
                className={
                  "inline-block h-2 w-2 rounded-full " +
                  (autoStatus === "watching"
                    ? "bg-green-500"
                    : autoStatus.includes("solving")
                      ? "bg-amber-400 animate-pulse"
                      : "bg-neutral-600")
                }
              />
              {autoStatus}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
            <span className="text-sm">ESP32 display</span>
            <button
              onClick={simulateTouch}
              disabled={!capturing}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800 disabled:opacity-40"
            >
              Simulate screen touch
            </button>
            <span className="text-xs text-neutral-500">
              The device&apos;s whole screen is a button: a touch interprets the current
              frame.
            </span>
            <span className="ml-auto flex items-center gap-2 text-xs text-neutral-400">
              <span
                className={
                  "inline-block h-2 w-2 rounded-full " +
                  (remoteStatus === "done"
                    ? "bg-green-500"
                    : remoteStatus === "solving" || remoteStatus === "requested"
                      ? "bg-amber-400 animate-pulse"
                      : remoteStatus === "error"
                        ? "bg-red-500"
                        : "bg-neutral-600")
                }
              />
              {remoteStatus}
            </span>
          </div>
          {error && (
            <p className="rounded-lg border border-red-900 bg-red-950/60 p-3 text-sm text-red-300">
              {error}
            </p>
          )}
        </section>

        <section className="space-y-6">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-6">
            <h2 className="self-start text-sm font-medium text-neutral-300">
              ESP32 display simulator
            </h2>
            <DeviceScreen
              state={deviceState}
              answer={result}
              errorMsg={error ?? ""}
              onTap={solveNow}
              diameter={260}
            />
            <p className="text-xs text-neutral-500">
              Live preview of the round device — tap it to interpret the current frame.
            </p>
          </div>
          <AnswerCard result={result} />
        </section>
      </div>
    </main>
  );
}

function AnswerCard({ result }: { result: SolveResult | null }) {
  if (!result) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-sm text-neutral-500">
        Start capture, pick a window or region, then press <b>Interpret now</b>. The
        frame is sent straight to Gemini (no local OCR).
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
    <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
      <h2 className="text-sm font-medium">Google Gemini (BYOK)</h2>
      <p className="mt-1 text-xs text-neutral-500">
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
