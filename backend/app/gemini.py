"""Google Gemini image-understanding client (the only supported provider).

The captured screen image is sent directly to Gemini (no local OCR). To keep costs
low we:
  - default to the cheap `gemini-2.5-flash-lite` model,
  - disable "thinking" (thinking_budget=0),
  - downscale large frames before sending (fewer image tiles => fewer tokens),
  - and never send the same image twice (see app.routers.solve dedup cache).
"""

from __future__ import annotations

import io
import time

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from PIL import Image
from pydantic import BaseModel

from app.schemas import GeminiConfig, QuestionType, SolveResult
from app import pricing

# Transient statuses worth retrying (overload / rate limit).
_RETRY_STATUSES = {429, 503}
_RETRY_BACKOFF = (0.4, 0.9)  # seconds; kept short to respect the latency budget

# Max edge (px) we send to Gemini. Combined with media_resolution=LOW this keeps the
# image to a couple of tiles for fast, cheap inference while staying readable.
MAX_EDGE = 640

PROMPT = """You are an expert exam solver. The image is a screenshot of a \
multiple-choice question. Read the question and its options and choose the correct \
answer(s).

question_type values:
- "single": exactly one correct option (A/B/C/D/...)
- "truefalse": a true/false question
- "multi": more than one correct option
- "draganddrop": ordering/matching question; put the correct order/matches in answer_text
- "unknown": the image has no usable question

Return answer_letters as the letters of the correct option(s) (e.g. ["A"] or ["A","C"]); \
empty if not applicable. Keep answer_text under 12 words. confidence is 0..1. Answer \
fast; do not explain your reasoning."""


class _GeminiAnswer(BaseModel):
    question_text: str
    question_type: QuestionType
    answer_letters: list[str]
    answer_text: str
    confidence: float


def friendly_provider_error(exc: Exception) -> str:
    """Turn noisy provider errors (e.g. a proxy HTML block page) into a short message."""
    text = str(exc)
    lowered = text.lower()
    if "<html" in lowered or "web page blocked" in lowered or "zugang zu dieser seite" in lowered:
        return (
            "The Gemini endpoint was blocked by a network web filter/proxy and is not "
            "reachable from the current network."
        )
    if "503" in text or "unavailable" in lowered:
        return (
            "Gemini is temporarily overloaded (503). It retried automatically — please "
            "try again in a moment or pick another model (e.g. gemini-2.5-flash)."
        )
    if "429" in text or "resource_exhausted" in lowered or "rate limit" in lowered:
        return (
            "Gemini rate limit reached (429). Wait a few seconds and try again, or "
            "check your quota."
        )
    return text[:300]


def _downscale_png(image_bytes: bytes) -> tuple[bytes, str]:
    """Downscale to MAX_EDGE on the longest side and return (bytes, mime_type)."""
    img = Image.open(io.BytesIO(image_bytes))
    img = img.convert("RGB")
    if max(img.size) > MAX_EDGE:
        scale = MAX_EDGE / max(img.size)
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85)
    return out.getvalue(), "image/jpeg"


def _client(cfg: GeminiConfig) -> genai.Client:
    return genai.Client(api_key=cfg.api_key)


def list_models(cfg: GeminiConfig) -> list[str]:
    """Return Gemini model ids that support content generation."""
    client = _client(cfg)
    names: list[str] = []
    for m in client.models.list():
        actions = getattr(m, "supported_actions", None) or []
        if not actions or "generateContent" in actions:
            names.append(m.name.replace("models/", ""))
    return sorted(set(names))


def _generate_with_retry(client, model, data, mime, config):
    """Call generate_content, retrying briefly on transient 429/503 errors."""
    last_exc: Exception | None = None
    for attempt in range(len(_RETRY_BACKOFF) + 1):
        try:
            return client.models.generate_content(
                model=model,
                contents=[PROMPT, types.Part.from_bytes(data=data, mime_type=mime)],
                config=config,
            )
        except genai_errors.APIError as exc:
            status = getattr(exc, "code", None)
            if status not in _RETRY_STATUSES or attempt == len(_RETRY_BACKOFF):
                raise
            last_exc = exc
            time.sleep(_RETRY_BACKOFF[attempt])
    if last_exc:  # pragma: no cover - defensive
        raise last_exc


def solve_image(image_bytes: bytes, cfg: GeminiConfig) -> SolveResult:
    client = _client(cfg)
    data, mime = _downscale_png(image_bytes)

    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=_GeminiAnswer,
        temperature=0,
        # Speed: no thinking, small output, low image resolution (fewer tiles/tokens).
        thinking_config=types.ThinkingConfig(thinking_budget=0),
        max_output_tokens=200,
        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_LOW,
    )

    resp = _generate_with_retry(client, cfg.model, data, mime, config)

    prompt_tokens = output_tokens = total_tokens = None
    if resp.usage_metadata is not None:
        prompt_tokens = resp.usage_metadata.prompt_token_count
        output_tokens = resp.usage_metadata.candidates_token_count
        total_tokens = resp.usage_metadata.total_token_count
    cost = pricing.estimate_cost(cfg.model, prompt_tokens, output_tokens)

    parsed: _GeminiAnswer | None = resp.parsed
    if parsed is None:
        # Gemini returned no parseable structured output (blocked, truncated, or a
        # non-question image). Return a graceful "unknown" result instead of crashing
        # so the device/UI shows a friendly message and the call is still metered.
        return SolveResult(
            question_text="",
            question_type="unknown",
            answer_letters=[],
            answer_text="No answer could be read from this image.",
            confidence=0.0,
            reasoning=None,
            model=cfg.model,
            tokens_used=total_tokens,
            prompt_tokens=prompt_tokens,
            output_tokens=output_tokens,
            cost_usd=cost,
            cached=False,
        )

    return SolveResult(
        question_text=parsed.question_text.strip(),
        question_type=parsed.question_type,
        answer_letters=[s.strip().upper() for s in parsed.answer_letters],
        answer_text=parsed.answer_text.strip(),
        confidence=float(parsed.confidence or 0.0),
        reasoning=None,
        model=cfg.model,
        tokens_used=total_tokens,
        prompt_tokens=prompt_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
        cached=False,
    )
