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
