"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Catches render/runtime errors anywhere in the
 * page tree so a single component failure no longer blanks the whole app.
 * Next.js re-mounts the segment when `reset()` is called.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the real error in the console/telemetry instead of silently dying.
    console.error("App error boundary caught:", error);
  }, [error]);

  return (
    <main className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-app px-6 text-center text-ink">
      <div className="text-lg font-semibold">Something went wrong</div>
      <p className="max-w-sm text-sm text-ink/60">
        The app hit an unexpected error. You can try again without losing the page.
      </p>
      {error?.message ? (
        <pre className="max-w-sm overflow-auto rounded-lg border border-line bg-panel px-3 py-2 text-left text-xs text-ink/70">
          {error.message}
        </pre>
      ) : null}
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          Try again
        </button>
        <button
          onClick={() => {
            if (typeof window !== "undefined") window.location.reload();
          }}
          className="rounded-lg border border-line bg-panel px-4 py-2 text-sm font-medium text-ink"
        >
          Reload
        </button>
      </div>
    </main>
  );
}
