"use client";

// Wraps the whole app. When the backend reports that Google sign-in is required and the
// visitor isn't signed in, it shows a "Sign in with Google" screen instead of the app.
// When auth isn't configured (local dev) it renders children immediately.

import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type AuthState = "checking" | "open" | "needLogin";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // Never hang on "Loading…" — if the check stalls (e.g. after an iOS PWA reload with a
    // flaky network), fall through to the app shell instead of a dead loading screen.
    const timeout = setTimeout(() => controller.abort(), 6000);
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/me`, {
          credentials: "include",
          signal: controller.signal,
        });
        const data = await res.json();
        if (cancelled) return;
        setState(!data.auth_required || data.authenticated ? "open" : "needLogin");
      } catch {
        // If we can't reach the backend (or the check timed out), don't lock the user
        // out of the shell.
        if (!cancelled) setState("open");
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">
        Loading…
      </div>
    );
  }

  if (state === "needLogin") {
    const next =
      typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : "/";
    const loginUrl = `${API_URL}/api/auth/login?next=${encodeURIComponent(next)}`;
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-8 text-center">
          <h1 className="text-lg font-semibold text-ink">AI VISIO</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Sign in with an authorized Google account to continue.
          </p>
          <a
            href={loginUrl}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
            Sign in with Google
          </a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
