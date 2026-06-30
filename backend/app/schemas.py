"""Pydantic schemas for the API."""

from __future__ import annotations

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
    elapsed_ms: int | None = None
    cached: bool = False  # True when returned from the dedup cache (no API call made)
