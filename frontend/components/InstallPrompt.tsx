"use client";

import { useEffect, useState } from "react";

// Top-of-screen "Install AI VISIO" banner shown only on phones that can install the PWA.
// Uses the Android/Chrome beforeinstallprompt event; on iOS Safari (which has no such
// event) it shows a short "Add to Home Screen" hint instead. Dismissal is remembered.

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "ai_visio_pwa_dismissed";

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch {
      /* localStorage unavailable — still allow the prompt */
    }

    const nav = navigator as Navigator & { standalone?: boolean };
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
    if (standalone) return; // already installed

    const isPhone =
      Math.min(window.innerWidth, window.innerHeight) <= 500 ||
      /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent);
    if (!isPhone) return;

    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onBip);

    // iOS Safari: no beforeinstallprompt, so surface the manual Add-to-Home-Screen hint.
    const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isSafari =
      /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent);
    if (isIos && isSafari) {
      setIosHint(true);
      setShow(true);
    }

    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  if (!show) return null;

  function dismiss() {
    setShow(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => undefined);
    dismiss();
  }

  return (
    <div className="fixed inset-x-0 top-0 z-[60] safe-top">
      <div className="mx-auto flex max-w-md items-center gap-3 border-b border-line bg-panel px-4 py-2.5 text-sm shadow-lg">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.svg" alt="" className="h-8 w-8 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">Install AI VISIO</p>
          <p className="truncate text-xs text-ink-muted">
            {iosHint
              ? "Tap Share, then \u201cAdd to Home Screen\u201d."
              : "Add it to your home screen for full-screen use."}
          </p>
        </div>
        {!iosHint && (
          <button
            type="button"
            onClick={install}
            className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent/90"
          >
            Install
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-lg p-1 text-ink-muted hover:bg-panel-2"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
