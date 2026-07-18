"use client";

// In-app replacements for the native window.confirm / window.alert, styled in the app's
// design language. Exposes:
//   const confirm = useConfirm(); await confirm({ message, ... }) -> Promise<boolean>
//   const toast = useToast();     toast("Saved", "success")
// Mounted once via <AlertsProvider> in the root layout.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type Toast = { id: number; message: string; kind: "info" | "success" | "error" };

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(() =>
  Promise.resolve(false),
);
const ToastContext = createContext<(message: string, kind?: Toast["kind"]) => void>(
  () => {},
);

export function useConfirm() {
  return useContext(ConfirmContext);
}
export function useToast() {
  return useContext(ToastContext);
}

export function AlertsProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const close = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOpts(null);
  }, []);

  const toast = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  // Escape / Enter shortcuts while a confirm dialog is open.
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [opts, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      <ToastContext.Provider value={toast}>
        {children}

        {opts && (
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onMouseDown={() => close(false)}
            role="alertdialog"
            aria-modal="true"
          >
            <div
              className="w-full max-w-sm rounded-2xl border border-line bg-app p-5 shadow-2xl"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {opts.title && (
                <h2 className="text-base font-semibold text-ink">{opts.title}</h2>
              )}
              <p className="mt-2 whitespace-pre-line text-sm text-ink-muted">
                {opts.message}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => close(false)}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-panel-2"
                >
                  {opts.cancelLabel ?? "Cancel"}
                </button>
                <button
                  type="button"
                  onClick={() => close(true)}
                  autoFocus
                  className={
                    "rounded-lg px-3 py-1.5 text-sm font-medium " +
                    (opts.danger
                      ? "bg-red-600 text-white hover:bg-red-500"
                      : "bg-accent text-accent-ink hover:bg-accent/90")
                  }
                >
                  {opts.confirmLabel ?? "Confirm"}
                </button>
              </div>
            </div>
          </div>
        )}

        {toasts.length > 0 && (
          <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[90] flex flex-col items-center gap-2 px-4">
            {toasts.map((t) => (
              <div
                key={t.id}
                className={
                  "pointer-events-auto flex max-w-md items-center gap-2 rounded-lg border px-4 py-2.5 text-sm shadow-lg backdrop-blur " +
                  (t.kind === "error"
                    ? "border-red-500/40 bg-red-500/10 text-red-700 dark:border-red-900 dark:bg-red-950/70 dark:text-red-200"
                    : t.kind === "success"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:border-green-900 dark:bg-green-950/70 dark:text-green-200"
                      : "border-line bg-panel text-ink")
                }
              >
                {t.message}
              </div>
            ))}
          </div>
        )}
      </ToastContext.Provider>
    </ConfirmContext.Provider>
  );
}
