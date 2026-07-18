export type ProviderConfig = {
  api_key: string;
  model: string;
  // Fine-tuning (optional; omitted fields fall back to backend defaults).
  max_edge?: number;
  media_resolution?: "low" | "medium" | "high";
  temperature?: number;
  thinking_budget?: number;
  max_output_tokens?: number;
  system_prompt?: string;
  extra_context?: string;
  auto_escalate?: boolean;
  // Per-request timeout (seconds) for the Gemini call.
  timeout_s?: number;
  // Cached case-study scenario text, merged in per solve (not a persisted setting).
  case_context?: string;
};

export type SolveResult = {
  question_text: string;
  question_type: "single" | "truefalse" | "multi" | "draganddrop" | "general" | "unknown";
  answer_letters: string[];
  answer_text: string;
  // Full free-form answer for the tablet / browser (empty on legacy results).
  full_answer?: string;
  confidence: number;
  reasoning?: string | null;
  model: string;
  tokens_used?: number | null;
  prompt_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  elapsed_ms?: number | null;
  cached: boolean;
};

const STORAGE_KEY = "aiexams.gemini";

// Shown in the dropdown before a connection test. After a successful test the list is
// replaced with the models actually available to your key. Lite models are cheapest.
export const DEFAULT_GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
];

export const DEFAULT_CONFIG: ProviderConfig = {
  api_key: "",
  model: "gemini-2.5-flash-lite",
  max_edge: 1280,
  media_resolution: "medium",
  temperature: 0,
  thinking_budget: 0,
  max_output_tokens: 800,
  system_prompt: "",
  extra_context: "",
  auto_escalate: true,
  timeout_s: 30,
};

export function loadConfig(): ProviderConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cfg: ProviderConfig) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

// The list of models a successful connection test returned, cached so the dropdown stays
// populated across visits without re-testing. Refreshed via the "refresh models" button.
const MODELS_KEY = "aiexams.models";

export function loadCachedModels(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MODELS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveCachedModels(models: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODELS_KEY, JSON.stringify(models));
  } catch {
    /* ignore */
  }
}

// ── Account-synced settings ────────────────────────────────────────────────
// All settings live in the signed-in account (server-side) and follow the user across
// devices; localStorage is only an offline cache. The blob has three sections:
// provider (main app), camera, and display (ESP32 prefs).

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const ACCOUNT_KEY = "aiexams.account";

export type CameraConfig = { fps: number; preset: number };
export const DEFAULT_CAMERA: CameraConfig = { fps: 8, preset: 1 };

export type DisplayConfig = {
  brightness: number; // 0–255 ESP32 backlight
  text_size: "small" | "medium" | "large";
  show_confidence: boolean;
  show_subtext: boolean;
  show_cached_badge: boolean;
};
export const DEFAULT_DISPLAY: DisplayConfig = {
  brightness: 200,
  text_size: "medium",
  show_confidence: true,
  show_subtext: true,
  show_cached_badge: true,
};

export type AccountSettings = {
  provider: ProviderConfig;
  camera: CameraConfig;
  display: DisplayConfig;
};

function mergeAccount(raw: unknown): AccountSettings {
  const r = (raw ?? {}) as Partial<AccountSettings>;
  return {
    provider: { ...DEFAULT_CONFIG, ...(r.provider ?? {}) },
    camera: { ...DEFAULT_CAMERA, ...(r.camera ?? {}) },
    display: { ...DEFAULT_DISPLAY, ...(r.display ?? {}) },
  };
}

/** Synchronous best-effort read from the localStorage cache (for first paint). */
export function cachedAccount(): AccountSettings {
  if (typeof window === "undefined") return mergeAccount(null);
  try {
    const raw = window.localStorage.getItem(ACCOUNT_KEY);
    return mergeAccount(raw ? JSON.parse(raw) : null);
  } catch {
    return mergeAccount(null);
  }
}

/** Load the account settings from the server, falling back to the cache when offline. */
export async function loadAccount(): Promise<AccountSettings> {
  try {
    const res = await fetch(`${API_URL}/api/settings`, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error();
    const merged = mergeAccount(await res.json());
    try {
      window.localStorage.setItem(ACCOUNT_KEY, JSON.stringify(merged));
    } catch {
      /* ignore */
    }
    return merged;
  } catch {
    return cachedAccount();
  }
}

/** Persist the full account settings (cache + server). */
export async function saveAccount(s: AccountSettings): Promise<void> {
  try {
    window.localStorage.setItem(ACCOUNT_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  try {
    await fetch(`${API_URL}/api/settings`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: s }),
    });
  } catch {
    /* offline: cache holds it until next successful save */
  }
}

/** Read-modify-write a single section so pages don't clobber each other's settings. */
async function patchSection<K extends keyof AccountSettings>(
  key: K,
  value: AccountSettings[K],
): Promise<void> {
  const cur = await loadAccount();
  await saveAccount({ ...cur, [key]: value });
}

export const saveProvider = (p: ProviderConfig) => patchSection("provider", p);
export const saveCamera = (c: CameraConfig) => patchSection("camera", c);
export const saveDisplay = (d: DisplayConfig) => patchSection("display", d);
