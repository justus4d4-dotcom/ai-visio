"use client";

// Profile panel: signed-in identity + data controls. Device/Display settings live in the
// Settings panel; Monitoring/Devices have their own panels.

import { useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/Alerts";
import { getStorageMode, setStorageMode, type StorageMode } from "@/lib/settings";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Profile = {
  auth_required: boolean;
  authenticated: boolean;
  email: string | null;
  is_admin: boolean;
};

export default function ProfileView() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const confirm = useConfirm();
  const importRef = useRef<HTMLInputElement>(null);
  const [storage, setStorage] = useState<StorageMode>("cloud");

  useEffect(() => {
    setStorage(getStorageMode());
  }, []);

  useEffect(() => {
    fetch(`${API_URL}/api/profile`, { credentials: "include" })
      .then((r) => r.json())
      .then(setProfile)
      .catch(() => {});
  }, []);

  async function signOut() {
    try {
      await fetch(`${API_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
    } catch {
      /* ignore */
    }
    window.location.reload();
  }

  async function exportData() {
    setNote(null);
    try {
      const [settings, history] = await Promise.all([
        fetch(`${API_URL}/api/settings`, { credentials: "include" }).then((r) => r.json()),
        fetch(`${API_URL}/api/history?limit=200`, { credentials: "include" }).then((r) => r.json()),
      ]);
      // Never export the raw LLM key: replace it with a SHA-256 hash.
      if (settings?.provider?.api_key) {
        const buf = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(settings.provider.api_key),
        );
        const hash = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        settings.provider = { ...settings.provider, api_key_sha256: hash };
        delete settings.provider.api_key;
      }
      const blob = new Blob([JSON.stringify({ settings, history }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ai-visio-export.json";
      a.click();
      URL.revokeObjectURL(url);
      setNote("Exported settings, history and hashed keys.");
    } catch {
      setNote("Export failed.");
    }
  }

  async function importData(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setNote(null);
    try {
      const parsed = JSON.parse(await file.text());
      const settings = parsed.settings ?? parsed;
      await fetch(`${API_URL}/api/settings`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      setNote("Settings imported. Reloading…");
      window.location.reload();
    } catch {
      setNote("Could not import that file.");
    }
  }

  async function clearHistory() {
    if (
      !(await confirm({
        title: "Delete all history",
        message: "Delete all history/logs? This cannot be undone.",
        confirmLabel: "Delete all",
        danger: true,
      }))
    )
      return;
    try {
      await fetch(`${API_URL}/api/history`, { method: "DELETE", credentials: "include" });
      setNote("History cleared.");
    } catch {
      setNote("Could not clear history.");
    }
  }

  const initial = (profile?.email ?? "?").charAt(0).toUpperCase();

  return (
    <div className="space-y-6">
      {/* Identity */}
      <section className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-lg font-semibold text-accent-ink">
            {initial}
          </span>
          <div>
            <p className="text-sm font-medium text-ink">
              {profile?.email ?? (profile?.auth_required ? "Not signed in" : "Local (no sign-in)")}
            </p>
            <p className="text-xs text-ink-muted">
              {profile?.is_admin ? "Admin" : "Member"}
              {profile ? " · settings synced to this account" : ""}
            </p>
          </div>
        </div>
        {profile?.authenticated && profile.auth_required && (
          <button
            onClick={signOut}
            className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-panel-2"
          >
            Sign out
          </button>
        )}
      </section>

      {/* Storage mode */}
      <section className="rounded-xl border border-line bg-panel p-4">
        <h3 className="text-sm font-semibold text-ink">Storage</h3>
        <p className="mt-1 text-xs text-ink-muted">
          Where your settings live.
        </p>
        <div className="mt-3 inline-flex rounded-lg border border-line bg-app p-1 text-sm">
          {([
            ["cloud", "Cloud (account-synced)"],
            ["local", "Local (this browser)"],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                setStorageMode(mode);
                setStorage(mode);
                setNote(
                  mode === "cloud"
                    ? "Settings will sync to your account."
                    : "Settings stay in this browser only.",
                );
              }}
              className={
                "rounded-md px-3 py-1.5 transition " +
                (storage === mode
                  ? "bg-accent font-medium text-accent-ink"
                  : "text-ink-muted hover:text-ink")
              }
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* Data controls */}
      <section className="rounded-xl border border-line bg-panel p-4">
        <h3 className="text-sm font-semibold text-ink">Your data</h3>
        {note && <p className="mt-2 text-xs text-ink-muted">{note}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={exportData}
            className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-panel-2"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15V3M8 7l4-4 4 4M4 21h16" />
            </svg>
            Export
          </button>
          <input ref={importRef} type="file" accept=".json,application/json" onChange={importData} className="hidden" />
          <button
            onClick={() => importRef.current?.click()}
            className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-panel-2"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12M8 11l4 4 4-4M4 21h16" />
            </svg>
            Import
          </button>
          <button
            onClick={clearHistory}
            className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/60"
          >
            Clear history
          </button>
        </div>
        <p className="mt-2 text-[11px] text-ink-muted">
          Export bundles your settings, history, and a hashed copy of your LLM key (never the raw key).
        </p>
      </section>
    </div>
  );
}
