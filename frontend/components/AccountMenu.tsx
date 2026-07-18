"use client";

// Account avatar button + dropdown menu (matches the reference design): identity header,
// storage-mode indicator, export/import settings, AI usage, admin panel, and sign out.

import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Profile = {
  auth_required: boolean;
  authenticated: boolean;
  email: string | null;
  name: string | null;
  picture: string | null;
  is_admin: boolean;
};

export type AccountAction = "usage" | "history" | "admin";

export default function AccountMenu({
  onSelect,
}: {
  onSelect: (action: AccountAction) => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/profile`, { credentials: "include" })
      .then((r) => r.json())
      .then(setProfile)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const name = profile?.name || profile?.email || "Account";
  const email = profile?.email || (profile?.auth_required ? "Not signed in" : "Local mode");
  const initial = (profile?.name || profile?.email || "?").charAt(0).toUpperCase();
  const accountStorage = Boolean(profile?.email);

  async function signOut() {
    try {
      await fetch(`${API_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
    } catch {
      /* ignore */
    }
    window.location.reload();
  }

  async function exportSettings() {
    setOpen(false);
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
      /* ignore */
    }
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    setOpen(false);
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const settings = parsed.settings ?? parsed;
      await fetch(`${API_URL}/api/settings`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      window.location.reload();
    } catch {
      alert("Could not import that file.");
    }
  }

  const item =
    "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-ink hover:bg-panel-2";

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-9 w-9 overflow-hidden rounded-full border border-line bg-panel-2"
        aria-label="Account menu"
        title={email}
      >
        {profile?.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.picture}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-sm font-semibold text-ink">
            {initial}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-line bg-panel shadow-xl shadow-black/40">
          <div className="border-b border-line px-4 py-3">
            <p className="truncate text-base font-semibold text-ink">{name}</p>
            <p className="truncate text-sm text-ink-muted">{email}</p>
          </div>

          <div className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span className="flex items-center gap-3 text-ink">
              <IconCloud />
              <span>
                Storage Mode
                <span className="block text-xs text-ink-muted">
                  {accountStorage ? "Account Storage" : "Local (this browser)"}
                </span>
              </span>
            </span>
          </div>

          <div className="border-t border-line py-1">
            <button className={item} onClick={exportSettings}>
              <IconSwap /> Export settings
            </button>
            <button className={item} onClick={() => importRef.current?.click()}>
              <IconSwap /> Import settings
            </button>
            <input ref={importRef} type="file" accept="application/json" onChange={onImportFile} className="hidden" />
            <button className={item} onClick={() => { setOpen(false); onSelect("usage"); }}>
              <IconChart /> AI Usage
            </button>
            <button className={item} onClick={() => { setOpen(false); onSelect("history"); }}>
              <IconList /> History &amp; logs
            </button>
            {profile?.is_admin && (
              <button className={item} onClick={() => { setOpen(false); onSelect("admin"); }}>
                <IconShield /> Admin Panel
              </button>
            )}
          </div>

          {profile?.auth_required && profile?.authenticated && (
            <div className="border-t border-line py-1">
              <button
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-red-400 hover:bg-panel-2"
                onClick={signOut}
              >
                <IconSignout /> Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── tiny inline icons (stroke = currentColor) ── */
const sv = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const IconCloud = () => (
  <svg {...sv} className="text-ink-muted"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>
);
const IconSwap = () => (
  <svg {...sv} className="text-ink-muted"><path d="M7 16H3M3 16l4-4M3 16l4 4M17 8h4M21 8l-4-4M21 8l-4 4" /></svg>
);
const IconChart = () => (
  <svg {...sv} className="text-ink-muted"><path d="M3 3v18h18M8 17V9M13 17V5M18 17v-6" /></svg>
);
const IconList = () => (
  <svg {...sv} className="text-ink-muted"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
);
const IconShield = () => (
  <svg {...sv} className="text-ink-muted"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
);
const IconSignout = () => (
  <svg {...sv}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
);
