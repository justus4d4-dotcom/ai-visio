"use client";

// "Devices" section for the Settings modal: upload a compiled ESP32 firmware image and
// push it over-the-air to every connected round display at once. The backend stores the
// image and broadcasts an OTA command over the WebSocket hub; each device downloads the
// binary over HTTP and flashes itself (see firmware/src/main.cpp + app/routers/devices.py).

import { useCallback, useEffect, useRef, useState } from "react";

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
  const fileRef = useRef<HTMLInputElement>(null);

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
    const id = setInterval(loadDevices, 3000);
    return () => clearInterval(id);
  }, [loadFirmware, loadLatest, loadDevices]);

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
        <p className="text-sm text-neutral-400">ESP32 firmware (OTA)</p>
        <span
          className={
            "rounded px-2 py-0.5 text-xs " +
            (count > 0 ? "bg-green-900 text-green-300" : "bg-neutral-800 text-neutral-400")
          }
        >
          {count} connected
        </span>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-red-900 bg-red-950/60 p-3 text-sm text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-lg border border-green-900 bg-green-950/40 p-3 text-sm text-green-300">
          {notice}
        </p>
      )}

      <section className="mt-3 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
        {/* Suggested firmware = the latest GitHub release asset. */}
        {latest?.available ? (
          <div className="mb-3 rounded-lg border border-indigo-900/70 bg-indigo-950/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <span className="text-neutral-400">Latest on GitHub: </span>
                <span className="font-mono text-neutral-100">{latest.tag}</span>
                <span className="ml-2 text-xs text-neutral-500">{fmtBytes(latest.size)}</span>
                {firmware?.stored && firmware.version === latest.tag ? (
                  <span className="ml-2 rounded bg-green-900/60 px-2 py-0.5 text-xs text-green-300">
                    loaded
                  </span>
                ) : (
                  <span className="ml-2 rounded bg-amber-900/70 px-2 py-0.5 text-xs text-amber-300">
                    suggested
                  </span>
                )}
              </div>
              <button
                onClick={useLatest}
                disabled={fetching || (firmware?.stored && firmware.version === latest.tag)}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
              >
                {fetching ? "Fetching…" : "Use latest from GitHub"}
              </button>
            </div>
          </div>
        ) : (
          latest?.detail && <p className="mb-3 text-xs text-neutral-500">{latest.detail}</p>
        )}

        <p className="text-xs uppercase tracking-wide text-neutral-500">Active firmware</p>
        {firmware?.stored ? (
          <div className="mt-1 text-sm text-neutral-200">
            <span className="font-mono">{firmware.version || firmware.filename}</span>
            <span className="ml-2 text-xs text-neutral-500">{fmtBytes(firmware.size)}</span>
            <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">
              {firmware.source === "github" ? "from GitHub" : "manual upload"}
            </span>
            <p className="mt-1 break-all font-mono text-[11px] text-neutral-500">
              md5 {firmware.md5}
            </p>
            {firmware.uploaded_at && (
              <p className="text-[11px] text-neutral-500">
                loaded {new Date(firmware.uploaded_at).toLocaleString()}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-neutral-500">
            No firmware loaded yet. Use the latest from GitHub above, or upload a{" "}
            <span className="font-mono">.bin</span> manually below.
          </p>
        )}

        <p className="mt-4 text-xs text-neutral-500">Or upload a .bin manually (alternative):</p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-neutral-400">Version label (optional)</span>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="e.g. v0.6.0"
              className="w-36 rounded border border-neutral-700 bg-neutral-950 p-2 text-sm"
            />
          </label>
          <input ref={fileRef} type="file" accept=".bin" onChange={onFile} className="hidden" />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="rounded-lg border border-neutral-700 px-3 py-2 text-sm hover:bg-neutral-800 disabled:opacity-40"
          >
            {uploading ? "Uploading…" : firmware?.stored ? "Replace .bin" : "Upload .bin"}
          </button>
          <button
            onClick={pushOta}
            disabled={pushing || !firmware?.stored || count === 0}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
            title={
              count === 0
                ? "No devices connected"
                : !firmware?.stored
                  ? "Upload a firmware image first"
                  : "Flash all connected devices"
            }
          >
            {pushing ? "Sending…" : "Update all devices"}
          </button>
        </div>
      </section>

      {devices.length > 0 && (
        <ul className="mt-3 space-y-2">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            >
              <span className="font-mono text-xs text-neutral-400">{d.remote ?? d.id.slice(0, 8)}</span>
              <span
                className={
                  "rounded px-1.5 py-0.5 text-xs " +
                  (d.ota_status === "updating"
                    ? "bg-amber-900/70 text-amber-200"
                    : d.ota_status === "failed"
                      ? "bg-red-900/70 text-red-200"
                      : d.ota_status === "requested"
                        ? "bg-indigo-900/70 text-indigo-200"
                        : "bg-neutral-800 text-neutral-400")
                }
              >
                {d.ota_status ?? "connected"}
                {d.ota_progress != null ? ` ${d.ota_progress}%` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-neutral-500">
        Devices must be flashed once over USB first; afterwards firmware can be pushed here.
        Each display downloads the image over your LAN and reboots into it.
      </p>
    </div>
  );
}
