export type ProviderConfig = {
  api_key: string;
  model: string;
};

export type SolveResult = {
  question_text: string;
  question_type: "single" | "truefalse" | "multi" | "draganddrop" | "unknown";
  answer_letters: string[];
  answer_text: string;
  confidence: number;
  reasoning?: string | null;
  model: string;
  tokens_used?: number | null;
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
