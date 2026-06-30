"""M2 solve loop (Gemini): image -> Gemini image understanding -> answer.

The same image is never sent to Gemini twice: each frame is hashed (sha256) and the
result is cached. A duplicate frame returns the cached answer with cached=True and
makes no API call (keeps cost low).
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from google.genai import errors as genai_errors
from pydantic import ValidationError

from app import gemini
from app.gemini import friendly_provider_error
from app.schemas import GeminiConfig, SolveResult

router = APIRouter(prefix="/api", tags=["solve"])

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # Gemini inline limit

# Simple in-memory dedup cache: image sha256 -> SolveResult. Capped to bound memory.
_CACHE: "OrderedDict[str, SolveResult]" = OrderedDict()
_CACHE_MAX = 500


def _cache_get(key: str) -> SolveResult | None:
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    return None


def _cache_put(key: str, value: SolveResult) -> None:
    _CACHE[key] = value
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)


@router.post("/solve", response_model=SolveResult)
async def solve(
    image: UploadFile = File(...),
    provider: str = Form(...),
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

    # Never send the same image to Gemini twice.
    digest = hashlib.sha256(data).hexdigest()
    cached = _cache_get(digest)
    if cached is not None:
        return cached.model_copy(update={"cached": True})

    try:
        started = time.perf_counter()
        result = gemini.solve_image(data, cfg)
        result.elapsed_ms = int((time.perf_counter() - started) * 1000)
    except genai_errors.APIError as exc:
        raise HTTPException(status_code=502, detail=friendly_provider_error(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    _cache_put(digest, result)
    return result
