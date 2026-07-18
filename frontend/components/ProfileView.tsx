"use client";

// Profile panel: signed-in identity + data controls. Device/Display settings live in the
// Settings panel; Monitoring/Devices have their own panels.

import { useEffect, useState } from "react";

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
      const blob = new Blob([JSON.stringify({ settings, history }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ai-visio-export.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setNote("Export failed.");
    }
  }

  async function clearHistory() {
    if (!confirm("Delete all history/logs? This cannot be undone.")) return;
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

      {/* Data controls */}
      <section className="rounded-xl border border-line bg-panel p-4">
        <h3 className="text-sm font-semibold text-ink">Your data</h3>
        {note && <p className="mt-2 text-xs text-ink-muted">{note}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={exportData}
            className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-panel-2"
          >
            Export my data
          </button>
          <button
            onClick={clearHistory}
            className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/60"
          >
            Clear history
          </button>
        </div>
      </section>

      {profile?.is_admin && (
        <p className="text-xs text-ink-muted">
          Admin: allowed-account management is available via the backend allowlist
          (ALLOWED_EMAILS / bootstrap admins) for now.
        </p>
      )}
    </div>
  );
}
