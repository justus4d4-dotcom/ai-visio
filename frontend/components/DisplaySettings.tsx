"use client";

// Device & Display settings (lives in the Settings panel). Preferences are account-synced
// and pushed live to every connected ESP32 (brightness, answer text size, and which
// elements to show). The device also persists them in NVS and re-applies on boot.

import { useEffect, useState } from "react";
import { DEFAULT_DISPLAY, loadAccount, saveDisplay, type DisplayConfig } from "@/lib/settings";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function DisplaySettings() {
  const [d, setDisplay] = useState<DisplayConfig>(DEFAULT_DISPLAY);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadAccount().then((a) => setDisplay(a.display)).catch(() => {});
  }, []);

  const set = (patch: Partial<DisplayConfig>) => setDisplay((x) => ({ ...x, ...patch }));

  async function saveAndPush() {
    setBusy(true);
    setStatus(null);
    try {
      await saveDisplay(d);
      const res = await fetch(`${API_URL}/api/devices/display`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d),
      });
      const data = await res.json().catch(() => ({}));
      setStatus(
        res.ok
          ? `Saved · pushed to ${data.targeted ?? 0} device${data.targeted === 1 ? "" : "s"}`
          : "Saved to account (device push failed)",
      );
    } catch {
      setStatus("Saved to account (device offline)");
    } finally {
      setBusy(false);
      window.setTimeout(() => setStatus(null), 2500);
    }
  }

  return (
    <div>
      <p className="text-xs text-ink-muted">
        Synced to your account and pushed to connected ESP32 displays. The device also
        remembers them across reboots.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          Brightness: <b className="text-ink">{d.brightness}</b>
          <input
            type="range"
            min={20}
            max={255}
            step={5}
            value={d.brightness}
            onChange={(e) => set({ brightness: Number(e.target.value) })}
            className="mt-1 w-full accent-accent"
          />
        </label>
        <label className="text-xs text-ink-muted">
          Answer text size
          <select
            value={d.text_size}
            onChange={(e) => set({ text_size: e.target.value as DisplayConfig["text_size"] })}
            className="mt-1 w-full rounded border border-line bg-app p-2 text-sm text-ink"
          >
            <option value="small">small</option>
            <option value="medium">medium</option>
            <option value="large">large</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={d.show_confidence}
            onChange={(e) => set({ show_confidence: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
          Show confidence ring
        </label>
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={d.show_subtext}
            onChange={(e) => set({ show_subtext: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
          Show answer subtext
        </label>
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={d.show_cached_badge}
            onChange={(e) => set({ show_cached_badge: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
          Show “cached” badge
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={saveAndPush}
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save & push to devices"}
        </button>
        {status && <span className="text-xs text-ink-muted">{status}</span>}
      </div>
    </div>
  );
}
