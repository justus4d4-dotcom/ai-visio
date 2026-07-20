"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary. Catches errors thrown in the root layout itself
 * (which `error.tsx` cannot). It must render its own <html>/<body> because
 * it replaces the whole document tree when the layout fails.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Global error boundary caught:", error);
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
          background: "#1a1d26",
          color: "#e7e9ee",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <div style={{ fontSize: "1.125rem", fontWeight: 600 }}>
          The app crashed
        </div>
        <p style={{ maxWidth: "24rem", fontSize: "0.875rem", opacity: 0.6 }}>
          A fatal error occurred while loading the interface. Reloading usually
          fixes it.
        </p>
        <button
          onClick={() => reset()}
          style={{
            borderRadius: "0.5rem",
            background: "#4f7cff",
            color: "#fff",
            padding: "0.5rem 1rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            border: "none",
          }}
        >
          Reload the app
        </button>
      </body>
    </html>
  );
}
