"use client";

// Reusable visual emulator of the ESP32 round display (Waveshare ESP32-S3-Touch-LCD-1.28).
// Renders the same UI states and colours as firmware/src/main.cpp. It is purely
// presentational: the parent decides the state and what happens on tap, so it can live
// on the capture page (where the screen share is) and reflect solving in real time.

import { useEffect, useState } from "react";
import type { SolveResult } from "@/lib/settings";

export type DeviceUiState = "idle" | "solving" | "answer" | "error";

// Colours mirrored from the firmware (RGB565 -> hex).
const COL = {
  bg: "#000000",
  text: "#ffffff",
  muted: "#808080",
  accent: "#00b4ff",
  good: "#28cc58",
  warn: "#ffa400",
  bad: "#ff5a4d",
};

export function confidenceColor(c: number): string {
  if (c >= 0.75) return COL.good;
  if (c >= 0.45) return COL.warn;
  return COL.bad;
}

export default function DeviceScreen({
  state,
  answer,
  errorMsg = "",
  onTap,
  diameter = 260,
}: {
  state: DeviceUiState;
  answer: SolveResult | null;
  errorMsg?: string;
  onTap?: () => void;
  diameter?: number;
}) {
  const SIZE = diameter;
  const [spin, setSpin] = useState(0);

  useEffect(() => {
    if (state !== "solving") return;
    const id = setInterval(() => setSpin((s) => (s + 12) % 360), 40);
    return () => clearInterval(id);
  }, [state]);

  return (
    <div
      className="flex items-center justify-center rounded-full bg-neutral-800 shadow-2xl"
      style={{ width: SIZE + 22, height: SIZE + 22, padding: 11 }}
    >
      <button
        onClick={onTap}
        aria-label="Tap to interpret"
        className="relative overflow-hidden rounded-full outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        style={{ width: SIZE, height: SIZE, background: COL.bg }}
      >
        <Screen size={SIZE} state={state} answer={answer} errorMsg={errorMsg} spin={spin} />
      </button>
    </div>
  );
}

function Screen({
  size,
  state,
  answer,
  errorMsg,
  spin,
}: {
  size: number;
  state: DeviceUiState;
  answer: SolveResult | null;
  errorMsg: string;
  spin: number;
}) {
  const k = size / 384; // scale factor relative to the reference design size

  if (state === "idle") {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <Ring size={size} color={COL.muted} fraction={1} faint />
        <div
          className="relative z-10 text-center font-bold leading-tight"
          style={{ color: COL.text, fontSize: 30 * k }}
        >
          Tap to
          <br />
          scan
        </div>
        <div
          className="relative z-10 mt-3 text-center"
          style={{ color: COL.muted, fontSize: 12 * k }}
        >
          web simulator
        </div>
      </div>
    );
  }

  if (state === "solving") {
    const center = size / 2;
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <svg width={size} height={size} className="absolute inset-0">
          <circle
            cx={center}
            cy={center}
            r={center - 12 * k}
            fill="none"
            stroke={COL.accent}
            strokeWidth={8 * k}
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * (center - 12 * k) * 0.22} ${
              2 * Math.PI * (center - 12 * k)
            }`}
            transform={`rotate(${spin} ${center} ${center})`}
          />
        </svg>
        <div className="relative z-10 font-bold" style={{ color: COL.text, fontSize: 26 * k }}>
          Thinking
        </div>
      </div>
    );
  }

  if (state === "answer" && answer) {
    const letters = answer.answer_letters.join(", ") || "?";
    const len = letters.length;
    const fontSize = (len <= 4 ? 80 : len <= 7 ? 52 : 34) * k;
    let text = answer.answer_text || "";
    if (text.length > 42) text = text.slice(0, 41) + "…";
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <Ring size={size} color={confidenceColor(answer.confidence)} fraction={answer.confidence} />
        <div
          className="relative z-10 px-6 text-center font-extrabold leading-none"
          style={{ color: COL.text, fontSize }}
        >
          {letters}
        </div>
        <div
          className="relative z-10 mt-4 max-w-[78%] text-center"
          style={{ color: COL.muted, fontSize: 14 * k }}
        >
          {text}
        </div>
        {answer.cached && (
          <div
            className="relative z-10 mt-1"
            style={{ color: COL.accent, fontSize: 12 * k }}
          >
            cached
          </div>
        )}
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <Ring size={size} color={COL.bad} fraction={1} faint />
        <div className="relative z-10 font-bold" style={{ color: COL.bad, fontSize: 26 * k }}>
          Error
        </div>
        <div
          className="relative z-10 mt-2 px-6 text-center"
          style={{ color: COL.muted, fontSize: 12 * k }}
        >
          {errorMsg || "unknown"}
        </div>
        <div className="relative z-10 mt-3" style={{ color: COL.text, fontSize: 12 * k }}>
          tap to retry
        </div>
      </div>
    );
  }

  return null;
}

// Confidence ring around the edge, starting at the top and going clockwise.
function Ring({
  size,
  color,
  fraction,
  faint = false,
}: {
  size: number;
  color: string;
  fraction: number;
  faint?: boolean;
}) {
  const center = size / 2;
  const k = size / 384;
  const r = center - 9 * k;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, fraction));
  return (
    <svg width={size} height={size} className="absolute inset-0">
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke={COL.muted}
        strokeWidth={6 * k}
        opacity={faint ? 0.35 : 0.25}
      />
      {!faint && (
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={6 * k}
          strokeLinecap="round"
          strokeDasharray={`${circ * frac} ${circ}`}
          transform={`rotate(-90 ${center} ${center})`}
        />
      )}
      {faint && (
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={6 * k}
          opacity={0.5}
        />
      )}
    </svg>
  );
}
