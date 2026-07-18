"use client";

import { useEffect, useState } from "react";

// App-level "Update available" banner. Polls the update status and, when a newer release
// exists, shows a slim top bar with a button that opens Settings (where the Update panel
// lives). Dismissal is remembered per target version, so a new release re-surfaces it.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const DISMISS_KEY = "ai_visio_update_dismissed";

type UpdateStatus = {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
};

export default function UpdateBanner({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY));
    } catch {
      /* ignore */
    }
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/api/updates/status`, { cache: "no-store" });
        if (res.ok && active) setStatus(await res.json());
      } catch {
        /* ignore */
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  if (!status?.update_available || !status.latest_version) return null;
  if (dismissed === status.latest_version) return null;

  const dismiss = () => {
    setDismissed(status.latest_version);
    try {
      localStorage.setItem(DISMISS_KEY, status.latest_version ?? "");
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="fixed inset-x-0 top-0 z-40 safe-top">
      <div className="flex items-center justify-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 backdrop-blur dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
        <span className="truncate">
          Update available:{" "}
          <span className="font-mono">{status.current_version}</span>
          {" \u2192 "}
          <span className="font-mono font-medium">{status.latest_version}</span>
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded-lg bg-accent px-3 py-1 text-xs font-medium text-accent-ink hover:bg-accent/90"
        >
          Update
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-lg p-1 hover:bg-black/10 dark:hover:bg-white/10"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
