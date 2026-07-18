"""M2 solve loop (Gemini): image -> Gemini image understanding -> answer.

Every frame the client sends is solved by the LLM. The frontend already suppresses
re-solving the same on-screen question (it only calls /api/solve once the frame's
perceptual hash has changed past a threshold), so the backend does not do its own
perceptual dedup: an 8x8 average hash cannot tell two differently-worded questions
apart when they share the same layout, which previously caused new questions to be
answered from a stale cache.
"""

from __future__ import annotations

import io
import json
import logging
import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from google.genai import errors as genai_errors
from PIL import Image
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app import gemini, history_store, usage_store
from app.database import get_db
from app.gemini import friendly_provider_error
from app.schemas import GeminiConfig, SolveResult

router = APIRouter(prefix="/api", tags=["solve"])

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # Gemini inline limit


def _classify_error(exc: Exception) -> tuple[str, int, str]:
    """Map a solve exception to (log_status, http_status, user_detail).

    Timeouts are singled out because they are the most common failure and get their own
    "timeout" status in the request log (Feature 2).
    """
    signature = f"{type(exc).__name__} {exc}".lower()
    if "timeout" in signature or "timed out" in signature or "deadline" in signature:
        return (
            "timeout",
            504,
            "The Gemini request timed out. Increase the timeout in Settings, pick a "
            "lighter model, or try again.",
        )
    if isinstance(exc, genai_errors.APIError):
        return "error", 502, friendly_provider_error(exc)
    if isinstance(exc, ValueError):
        return "error", 422, str(exc)
    return "error", 502, friendly_provider_error(exc)


def _phash(data: bytes) -> int:
    """8x8 grayscale average hash of the frame, as a 64-bit int (0 on decode failure).

    Only used to derive a stable digest for the history row's ocr_hash column.
    """
    try:
        img = Image.open(io.BytesIO(data)).convert("L").resize((8, 8), Image.LANCZOS)
    except Exception:  # noqa: BLE001 - unreadable bytes: fall back to a zero digest
        return 0
    pixels = list(img.getdata())
    avg = sum(pixels) / len(pixels)
    bits = 0
    for i, p in enumerate(pixels):
        if p >= avg:
            bits |= 1 << i
    return bits


@router.post("/solve", response_model=SolveResult)
async def solve(
    image: UploadFile = File(...),
    provider: str = Form(...),
    db: Session = Depends(get_db),
) -> SolveResult:
    try:
        cfg = GeminiConfig(**json.loads(provider))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid Gemini config: {exc}")

    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large")

    # Digest of the frame, stored on the history row (ocr_hash).
    ph = _phash(data)
    digest = f"{ph:016x}"

    # If the frame is unreadable, retry with progressively more capable models (up to
    # MAX_SOLVE_ATTEMPTS). Each attempt is a real API call, so it is metered. Every
    # request — success OR failure — is logged to the request log (Feature 2).
    result: SolveResult | None = None
    started = time.perf_counter()
    try:
        for model in gemini.fallback_models(cfg.model, cfg.auto_escalate):
            result = gemini.solve_image(data, cfg.model_copy(update={"model": model}))
            # Record every metered API call for the monitoring dashboard (best-effort).
            try:
                usage_store.record_usage(db, result)
            except Exception:  # noqa: BLE001
                logging.exception("Failed to record usage event")
            if not gemini.is_unreadable(result):
                break
    except Exception as exc:  # noqa: BLE001 - log why it failed, then surface it
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        log_status, http_status, detail = _classify_error(exc)
        logging.warning("Solve failed (%s): %s", log_status, exc)
        # Log the failed request (with its image + reason) so it shows in History.
        try:
            history_store.save_request(
                db,
                data,
                digest,
                status=log_status,
                error_type=type(exc).__name__,
                error_detail=str(exc),
                elapsed_ms=elapsed_ms,
                provider_label=cfg.model,
            )
        except Exception:  # noqa: BLE001
            logging.exception("Failed to log failed request")
        raise HTTPException(status_code=http_status, detail=detail)

    result.elapsed_ms = int((time.perf_counter() - started) * 1000)

    # Persist every solve to the request log / history (Feature 2 + 4: we always answer,
    # so there is always a row to show on the tablet and in History).
    try:
        history_store.save_request(db, data, digest, result=result, status="success")
    except Exception:  # noqa: BLE001
        logging.exception("Failed to persist answer to history")

    return result


@router.post("/extract-scenario")
async def extract_scenario(
    image: UploadFile = File(...),
    provider: str = Form(...),
) -> dict[str, str]:
    """Transcribe a captured case-study scenario screen to plain text.

    Part of the case-study flow: the browser captures one or more scenario screens, each
    is transcribed here, and the combined text is cached client-side and sent as
    ``case_context`` on later solves. No history row is written for a capture.
    """
    try:
        cfg = GeminiConfig(**json.loads(provider))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid Gemini config: {exc}")

    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large")

    try:
        text = gemini.extract_scenario(data, cfg)
    except Exception as exc:  # noqa: BLE001
        _, http_status, detail = _classify_error(exc)
        logging.warning("Scenario extraction failed: %s", exc)
        raise HTTPException(status_code=http_status, detail=detail)

    return {"text": text}
