"""Pydantic schemas for the API."""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, Field

QuestionType = Literal["single", "truefalse", "multi", "draganddrop", "unknown"]


class GeminiConfig(BaseModel):
    """BYOK config for Google Gemini (the only supported provider)."""

    api_key: str = Field(..., min_length=1)
    model: str = "gemini-2.5-flash-lite"


class ProviderTestResult(BaseModel):
    ok: bool
    models: list[str] = []
    detail: str | None = None


class SolveResult(BaseModel):
    question_text: str
    question_type: QuestionType
    answer_letters: list[str]
    answer_text: str
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
    confidence: float | None = None
    provider_label: str | None = None
    tokens_used: int | None = None
    has_image: bool = False
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
