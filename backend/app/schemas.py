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
