"use client";

// Account avatar button + dropdown menu: identity header, profile/data, AI usage,
// history, admin panel (admins only), and sign out.

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

export type AccountAction = "profile" | "usage" | "history" | "admin";

export default function AccountMenu({
  onSelect,
}: {
  onSelect: (action: AccountAction) => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  async function signOut() {
    try {
      await fetch(`${API_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
    } catch {
      /* ignore */
    }
    window.location.reload();
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

          <div className="py-1">
            <button className={item} onClick={() => { setOpen(false); onSelect("profile"); }}>
              <IconUser /> Profile
            </button>
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
const IconUser = () => (
  <svg {...sv} className="text-ink-muted"><path d="M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /></svg>
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
