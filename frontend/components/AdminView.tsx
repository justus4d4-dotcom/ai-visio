"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfirm, useToast } from "@/components/Alerts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type AdminUser = {
  email: string;
  is_admin: boolean;
  source: "env" | "db";
};

export default function AdminView() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [asAdmin, setAsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/admin/users`, { credentials: "include" });
      if (!res.ok) throw new Error(res.status === 403 ? "Admin access required." : `Failed (${res.status})`);
      setUsers(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addUser() {
    const value = email.trim();
    if (!value) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/admin/users`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, is_admin: asAdmin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail ?? `Failed (${res.status})`);
      setEmail("");
      setAsAdmin(false);
      toast(`Added ${value}.`, "success");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add user.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function setRole(u: AdminUser, is_admin: boolean) {
    try {
      const res = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(u.email)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_admin }),
      });
      if (!res.ok) throw new Error();
      load();
    } catch {
      toast("Could not change the role.", "error");
    }
  }

  async function remove(u: AdminUser) {
    if (
      !(await confirm({
        title: "Remove user",
        message: `Remove ${u.email}? They will no longer be able to sign in.`,
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      const res = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(u.email)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail ?? "Failed");
      toast(`Removed ${u.email}.`, "success");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not remove user.", "error");
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">
        Invite people by email and grant the admin role. Entries configured via server
        environment are shown read-only.
      </p>

      {/* Add user */}
      <section className="rounded-xl border border-line bg-panel p-4">
        <h3 className="text-sm font-semibold text-ink">Add user</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addUser()}
            placeholder="name@example.com"
            className="min-w-0 flex-1 rounded-lg border border-line bg-app p-2 text-sm"
          />
          <label className="flex items-center gap-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={asAdmin}
              onChange={(e) => setAsAdmin(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            Admin
          </label>
          <button
            onClick={addUser}
            disabled={busy || !email.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:bg-accent/90 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </section>

      {/* Users list */}
      {error ? (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          {error}
        </p>
      ) : loading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-ink-muted">No users configured — anyone can sign in.</p>
      ) : (
        <ul className="space-y-2">
          {users.map((u) => (
            <li
              key={u.email}
              className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-ink">{u.email}</p>
                {u.source === "env" && (
                  <p className="text-[11px] text-ink-muted">from server config (read-only)</p>
                )}
              </div>
              <label
                className={
                  "flex items-center gap-1.5 text-xs " +
                  (u.source === "env" ? "text-ink-muted" : "text-ink")
                }
              >
                <input
                  type="checkbox"
                  checked={u.is_admin}
                  disabled={u.source === "env"}
                  onChange={(e) => setRole(u, e.target.checked)}
                  className="h-4 w-4 accent-accent disabled:opacity-50"
                />
                Admin
              </label>
              {u.source === "db" && (
                <button
                  onClick={() => remove(u)}
                  title="Remove user"
                  aria-label="Remove user"
                  className="rounded-lg border border-red-500/40 p-1.5 text-red-600 hover:bg-red-500/10 dark:border-red-900 dark:text-red-300"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                  </svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
