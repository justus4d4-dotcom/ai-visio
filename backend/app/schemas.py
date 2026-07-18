"""Pydantic schemas for the API."""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, Field

# "general" = the screen is not a multiple-choice question; the model still gives its
# best free-form answer (see gemini.PROMPT / Feature 3+4). "unknown" is kept for legacy
# rows and the rare case where nothing at all could be produced.
QuestionType = Literal["single", "truefalse", "multi", "draganddrop", "general", "unknown"]


class GeminiConfig(BaseModel):
    """BYOK config for Google Gemini (the only supported provider)."""

    api_key: str = Field(..., min_length=1)
    model: str = "gemini-2.5-flash-lite"

    # ── Fine-tuning (all optional; defaults reproduce the built-in behaviour) ──
    # Image: longest edge (px) sent to Gemini. Higher = more legible but slower/costlier.
    max_edge: int = Field(1280, ge=256, le=4096)
    # Detail Gemini tokenises the image at. low=fastest/cheapest, high=most accurate.
    media_resolution: Literal["low", "medium", "high"] = "medium"
    # Sampling temperature (0 = deterministic; higher = more varied/creative).
    temperature: float = Field(0.0, ge=0.0, le=2.0)
    # "Thinking" token budget. 0 = off (fastest); higher can improve hard questions.
    thinking_budget: int = Field(0, ge=0, le=8192)
    # Cap on the answer size. Higher than the old 200 so the full free-form answer
    # (Feature 3) isn't truncated; the short ESP32 summary stays short regardless.
    max_output_tokens: int = Field(800, ge=32, le=4096)
    # Override the built-in solver prompt entirely (blank = use the default).
    system_prompt: str = ""
    # Extra instructions/context appended to the prompt (e.g. subject, language).
    extra_context: str = ""
    # Retry an unreadable frame with a stronger model (off = single call = faster).
    auto_escalate: bool = True
    # Per-request timeout (seconds) for the Gemini call. Requests that exceed it are
    # aborted and logged as a "timeout" failure instead of hanging (Feature 2).
    timeout_s: float = Field(30.0, ge=5.0, le=120.0)


class ProviderTestResult(BaseModel):
    ok: bool
    models: list[str] = []
    detail: str | None = None


class SolveResult(BaseModel):
    question_text: str
    question_type: QuestionType
    answer_letters: list[str]
    # Short one-line summary, sized for the tiny ESP32 display.
    answer_text: str
    # Full free-form answer for the tablet / browser (Feature 1+3). Empty for legacy
    # callers; the ESP32 ignores it and shows answer_text/answer_letters instead.
    full_answer: str = ""
    confidence: float
    reasoning: str | None = None
    model: str
    tokens_used: int | None = None
    prompt_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    elapsed_ms: int | None = None
    cached: bool = False  # True when returned from the dedup cache (no API call made)


class HistoryItem(BaseModel):
    """A persisted question/answer record (metadata only; image fetched separately)."""

    id: str
    question_text: str
    question_type: str
    answer_letters: list[str] = []
    answer_text: str | None = None
    full_answer: str | None = None
    confidence: float | None = None
    provider_label: str | None = None
    tokens_used: int | None = None
    has_image: bool = False
    # Outcome of the logged request (Feature 2): "success" | "error" | "timeout".
    status: str = "success"
    error_type: str | None = None
    error_detail: str | None = None
    elapsed_ms: int | None = None
    created_at: dt.datetime


class UsageTotals(BaseModel):
    """Aggregate LLM-usage figures over some window."""

    calls: int = 0
    billable_calls: int = 0  # calls that actually hit the API (not served from cache)
    cached_calls: int = 0
    prompt_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0


class UsageDayPoint(BaseModel):
    day: str  # YYYY-MM-DD (UTC)
    calls: int
    total_tokens: int
    cost_usd: float


class UsageModelPoint(BaseModel):
    model: str
    calls: int
    total_tokens: int
    cost_usd: float


class UsageSummary(BaseModel):
    today: UsageTotals
    last_7_days: UsageTotals
    all_time: UsageTotals
    daily: list[UsageDayPoint] = []  # most-recent first, last ~30 days
    by_model: list[UsageModelPoint] = []


# ── Self-update ──────────────────────────────────────────────────────────────
class ReleaseInfo(BaseModel):
    """A published GitHub release, mapped to the fields the UI needs."""

    tag: str
    name: str | None = None
    notes: str | None = None  # markdown release body
    published_at: dt.datetime | None = None
    url: str | None = None  # html_url of the release page
    prerelease: bool = False


class UpdateStatus(BaseModel):
    """Current-vs-latest comparison shown in the Update section."""

    current_version: str  # tag/ref the deployment is currently on
    latest_version: str | None = None  # newest release tag, if any
    update_available: bool = False
    releases: list[ReleaseInfo] = []  # newest first (release history)
    repo: str
    can_apply: bool = False  # server allows triggering an update
    in_progress: bool = False  # an update is currently running
    detail: str | None = None  # populated when releases could not be fetched


class UpdateApplyResult(BaseModel):
    started: bool
    target: str
    detail: str | None = None


class UpdateProgress(BaseModel):
    """Tail of the update log plus a coarse state for the UI to poll."""

    state: Literal["idle", "running", "success", "failed"]
    target: str | None = None
    log: str = ""
