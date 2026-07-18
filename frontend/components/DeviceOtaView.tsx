"use client";

// "Devices" section for the Settings modal: upload a compiled ESP32 firmware image and
// push it over-the-air to every connected round display at once. The backend stores the
// image and broadcasts an OTA command over the WebSocket hub; each device downloads the
// binary over HTTP and flashes itself (see firmware/src/main.cpp + app/routers/devices.py).

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DISPLAY, loadAccount, saveDisplay, type DisplayConfig } from "@/lib/settings";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Firmware = {
  stored: boolean;
  version?: string | null;
  filename?: string | null;
  md5?: string | null;
  size?: number | null;
  uploaded_at?: string | null;
  source?: string | null;
};

type Device = {
  id: string;
  name?: string | null;
  remote?: string | null;
  connected_at?: string;
  ota_status?: string;
  ota_progress?: number;
};

type FirmwareLatest = {
  available: boolean;
  tag?: string | null;
  name?: string | null;
  size?: number | null;
  updated_at?: string | null;
  detail?: string | null;
};

const fmtBytes = (n?: number | null) =>
  n == null ? "" : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;

export default function DeviceOtaView() {
  const [firmware, setFirmware] = useState<Firmware | null>(null);
  const [latest, setLatest] = useState<FirmwareLatest | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [count, setCount] = useState(0);
  const [version, setVersion] = useState("");
  const [uploading, setUploading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [display, setDisplay] = useState<DisplayConfig>(DEFAULT_DISPLAY);
  const [openGear, setOpenGear] = useState<string | null>(null);
  const [saveAll, setSaveAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFirmware = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/devices/firmware`, { cache: "no-store" });
      if (res.ok) setFirmware(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  const loadLatest = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/devices/firmware/latest`, { cache: "no-store" });
      if (res.ok) setLatest(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/devices/connected`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setCount(data.count ?? 0);
        setDevices(data.devices ?? []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadFirmware();
    loadLatest();
    loadDevices();
    loadAccount()
      .then((a) => setDisplay(a.display))
      .catch(() => {});
    const id = setInterval(loadDevices, 3000);
    return () => clearInterval(id);
  }, [loadFirmware, loadLatest, loadDevices]);

  async function deployOne(id: string, name: string) {
    if (!firmware?.stored) {
      setError("Upload or select a firmware image first.");
      return;
    }
    if (!confirm(`Deploy firmware to ${name}?`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_URL}/api/devices/${id}/ota`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail ?? `Failed (${res.status})`);
      setNotice(`Update sent to ${name}.`);
      loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deploy failed.");
    }
  }

  // Auto-save the display config to the account and push it to the target device
  // (or all devices when "Save to all" is checked), debounced so sliders don't spam.
  function changeDisplay(patch: Partial<DisplayConfig>, deviceId: string) {
    const next = { ...display, ...patch };
    setDisplay(next);
    if (pushRef.current) clearTimeout(pushRef.current);
    pushRef.current = setTimeout(async () => {
      try {
        await saveDisplay(next);
        const url = saveAll
          ? `${API_URL}/api/devices/display`
          : `${API_URL}/api/devices/${deviceId}/display`;
        await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
      } catch {
        /* ignore transient push errors */
      }
    }, 500);
  }

  async function useLatest() {
    setFetching(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_URL}/api/devices/firmware/fetch`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail ?? `Failed (${res.status})`);
      setFirmware(data);
      setNotice(`Loaded ${data.version ?? data.filename} from GitHub.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not fetch firmware from GitHub.");
    } finally {
      setFetching(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("firmware", file, file.name);
      form.append("version", version.trim());
      const res = await fetch(`${API_URL}/api/devices/firmware`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail ?? `Upload failed (${res.status})`);
      setFirmware(data);
      setNotice(`Uploaded ${data.filename} (${fmtBytes(data.size)}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function pushOta() {
    if (
      !confirm(
        `Push the firmware to ${count} connected device${count === 1 ? "" : "s"}?\n\n` +
          "Each display will download the image, flash itself, and reboot.",
      )
    )
      return;
    setPushing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_URL}/api/devices/ota`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail ?? `Failed (${res.status})`);
      setNotice(`Update sent to ${data.targeted} device${data.targeted === 1 ? "" : "s"}.`);
      loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the update.");
    } finally {
      setPushing(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">Display firmware (OTA)</p>
        <span
          className={
            "rounded px-2 py-0.5 text-xs " +
            (count > 0 ? "bg-emerald-500/15 text-emerald-700 dark:bg-green-900 dark:text-green-300" : "bg-panel-2 text-ink-muted")
          }
        >
          {count} connected
        </span>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
          {notice}
        </p>
      )}

      <section className="mt-3 rounded-xl border border-line bg-panel p-4">
        {/* Suggested firmware = the latest GitHub release asset. */}
        {latest?.available ? (
          <div className="mb-3 rounded-lg border border-accent/40 bg-accent/10 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <span className="text-ink-muted">Latest on GitHub: </span>
                <span className="font-mono text-ink">{latest.tag}</span>
                <span className="ml-2 text-xs text-ink-muted">{fmtBytes(latest.size)}</span>
                {firmware?.stored && firmware.version === latest.tag ? (
                  <span className="ml-2 rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:bg-green-900/60 dark:text-green-300">
                    loaded
                  </span>
                ) : (
                  <span className="ml-2 rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/60 dark:text-amber-300">
                    suggested
                  </span>
                )}
              </div>
              <button
                onClick={useLatest}
                disabled={fetching || (firmware?.stored && firmware.version === latest.tag)}
                className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:bg-accent/90 disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" className={"h-4 w-4 " + (fetching ? "animate-spin" : "")} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {fetching ? <path d="M21 12a9 9 0 1 1-2.64-6.36" /> : <path d="M12 3v10M8 9l4 4 4-4M5 21h14" />}
                </svg>
                {fetching ? "Fetching…" : "Use latest from GitHub"}
              </button>
            </div>
          </div>
        ) : (
          latest?.detail && <p className="mb-3 text-xs text-ink-muted">{latest.detail}</p>
        )}

        <p className="text-xs uppercase tracking-wide text-ink-muted">Active firmware</p>
        {firmware?.stored ? (
          <div className="mt-1 text-sm text-ink">
            <span className="font-mono">{firmware.version || firmware.filename}</span>
            <span className="ml-2 text-xs text-ink-muted">{fmtBytes(firmware.size)}</span>
            <span className="ml-2 rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-muted">
              {firmware.source === "github" ? "from GitHub" : "manual upload"}
            </span>
            <p className="mt-1 break-all font-mono text-[11px] text-ink-muted">
              md5 {firmware.md5}
            </p>
            {firmware.uploaded_at && (
              <p className="text-[11px] text-ink-muted">
                loaded {new Date(firmware.uploaded_at).toLocaleString()}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">
            No firmware loaded yet. Use the latest from GitHub above, or upload a{" "}
            <span className="font-mono">.bin</span> manually below.
          </p>
        )}

        <p className="mt-4 text-xs text-ink-muted">Or upload a .bin manually (alternative):</p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-muted">Version label (optional)</span>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="e.g. v0.6.0"
              className="w-36 rounded border border-line bg-app p-2 text-sm"
            />
          </label>
          <input ref={fileRef} type="file" accept=".bin" onChange={onFile} className="hidden" />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-panel-2 disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15V5M8 9l4-4 4 4M5 21h14" />
            </svg>
            {uploading ? "Uploading…" : firmware?.stored ? "Replace .bin" : "Upload .bin"}
          </button>
          <button
            onClick={pushOta}
            disabled={pushing || !firmware?.stored || count === 0}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:bg-accent/90 disabled:opacity-40"
            title={
              count === 0
                ? "No devices connected"
                : !firmware?.stored
                  ? "Upload a firmware image first"
                  : "Flash all connected devices"
            }
          >
            <svg viewBox="0 0 24 24" className={"h-4 w-4 " + (pushing ? "animate-spin" : "")} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {pushing ? <path d="M21 12a9 9 0 1 1-2.64-6.36" /> : <path d="M12 3v10M8 9l4 4 4-4M5 21h14" />}
            </svg>
            {pushing ? "Sending…" : "Update all devices"}
          </button>
        </div>
      </section>

      {devices.length > 0 && (
        <ul className="mt-3 space-y-2">
          {devices.map((d) => (
            <li
              key={d.id}
              className="rounded-lg border border-line bg-panel text-sm"
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{d.name ?? "Display"}</p>
                  <p className="truncate font-mono text-[11px] text-ink-muted">
                    {d.remote ?? d.id.slice(0, 8)}
                  </p>
                </div>
                <span
                  className={
                    "shrink-0 rounded px-1.5 py-0.5 text-xs " +
                    (d.ota_status === "updating"
                      ? "bg-amber-500/15 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200"
                      : d.ota_status === "failed" || d.ota_status === "no_response"
                        ? "bg-red-500/15 text-red-700 dark:bg-red-900/60 dark:text-red-200"
                        : d.ota_status === "requested"
                          ? "bg-accent/15 text-accent dark:bg-accent/25 dark:text-accent"
                          : "bg-emerald-500/15 text-emerald-700 dark:bg-green-900/60 dark:text-green-300")
                  }
                >
                  {d.ota_status === "no_response" ? "no response" : d.ota_status ?? "connected"}
                  {d.ota_progress != null ? ` ${d.ota_progress}%` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => deployOne(d.id, d.name ?? "this device")}
                  disabled={!firmware?.stored}
                  title="Deploy firmware to this device"
                  aria-label="Deploy firmware to this device"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line text-ink hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v10M8 9l4 4 4-4M5 21h14" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setOpenGear(openGear === d.id ? null : d.id)}
                  title="Display settings"
                  aria-expanded={openGear === d.id}
                  className={
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-ink hover:bg-panel-2 " +
                    (openGear === d.id ? "border-accent bg-panel-2" : "border-line")
                  }
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
              </div>

              {openGear === d.id && (
                <div className="space-y-3 border-t border-line px-3 py-3">
                  <div>
                    <label className="flex items-center justify-between text-xs text-ink">
                      <span>Brightness</span>
                      <span className="font-mono text-ink-muted">{display.brightness}</span>
                    </label>
                    <input
                      type="range"
                      min={20}
                      max={255}
                      value={display.brightness}
                      onChange={(e) => changeDisplay({ brightness: Number(e.target.value) }, d.id)}
                      className="mt-1 w-full accent-accent"
                    />
                  </div>

                  <label className="flex items-center justify-between text-xs text-ink">
                    <span>Text size</span>
                    <select
                      value={display.text_size}
                      onChange={(e) =>
                        changeDisplay({ text_size: e.target.value as DisplayConfig["text_size"] }, d.id)
                      }
                      className="rounded-md border border-line bg-app px-2 py-1 text-xs text-ink"
                    >
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large">Large</option>
                    </select>
                  </label>

                  <label className="flex items-center justify-between text-xs text-ink">
                    <span>Show confidence</span>
                    <input
                      type="checkbox"
                      checked={display.show_confidence}
                      onChange={(e) => changeDisplay({ show_confidence: e.target.checked }, d.id)}
                      className="h-4 w-4 accent-accent"
                    />
                  </label>

                  <label className="flex items-center justify-between text-xs text-ink">
                    <span>Show subtext</span>
                    <input
                      type="checkbox"
                      checked={display.show_subtext}
                      onChange={(e) => changeDisplay({ show_subtext: e.target.checked }, d.id)}
                      className="h-4 w-4 accent-accent"
                    />
                  </label>

                  <label className="flex items-center justify-between text-xs text-ink">
                    <span>Show cached badge</span>
                    <input
                      type="checkbox"
                      checked={display.show_cached_badge}
                      onChange={(e) => changeDisplay({ show_cached_badge: e.target.checked }, d.id)}
                      className="h-4 w-4 accent-accent"
                    />
                  </label>

                  <label className="flex items-center gap-2 border-t border-line pt-3 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      checked={saveAll}
                      onChange={(e) => setSaveAll(e.target.checked)}
                      className="h-4 w-4 accent-accent"
                    />
                    <span>Save to all devices</span>
                  </label>
                  <p className="text-[11px] text-ink-muted">
                    Changes save automatically and push{saveAll ? " to all connected displays" : " to this display"}.
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-ink-muted">
        Devices must be flashed once over USB first; afterwards firmware can be pushed here.
        Each display downloads the image over your LAN and reboots into it.
      </p>
      {devices.some((d) => d.ota_status === "no_response") && (
        <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          A device didn&apos;t respond to the update. That usually means it is still running
          firmware from before OTA support was added, so it ignores the push. Flash it once
          over USB or WiFi (<span className="font-mono">pio run -e waveshare-s3-round-ota -t
          upload --upload-port &lt;device-ip&gt;</span>); after that, push-OTA works from here.
          Also check the device&apos;s backend URL is the plain <span className="font-mono">http://LAN-IP:8000</span>
          it can reach (not an HTTPS tunnel).
        </p>
      )}
    </div>
  );
}
