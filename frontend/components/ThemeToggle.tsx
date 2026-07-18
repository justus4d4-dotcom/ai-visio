"use client";

// Light/dark theme toggle. Applies the `dark`/`light` class to <html> and persists the
// choice; the no-flash init script in layout.tsx reads the same key before paint.

import { useEffect, useState } from "react";

const KEY = "ai_visio_theme";

export default function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    try {
      setDark(localStorage.getItem(KEY) !== "light");
    } catch {
      /* ignore */
    }
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    const c = document.documentElement.classList;
    c.toggle("dark", next);
    c.toggle("light", !next);
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
      className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-panel-2"
    >
      {dark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )}
    </button>
  );
}
