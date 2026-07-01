"""Gemini connection test + model listing for the settings UI."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from google.genai import errors as genai_errors

from app import gemini
from app.gemini import friendly_provider_error
from app.schemas import GeminiConfig, ProviderTestResult

router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.post("/test", response_model=ProviderTestResult)
def test_provider(cfg: GeminiConfig) -> ProviderTestResult:
    """Validate the Gemini API key and return the available model ids."""
    try:
        models = gemini.list_models(cfg)
    except genai_errors.APIError as exc:
        msg = str(exc)
        if "API_KEY_INVALID" in msg or "API key not valid" in msg:
            raise HTTPException(status_code=401, detail="Invalid Gemini API key.")
        status = getattr(exc, "code", 502) or 502
        if status in (401, 403):
            raise HTTPException(status_code=401, detail="Invalid Gemini API key.")
        raise HTTPException(status_code=502, detail=friendly_provider_error(exc))
    return ProviderTestResult(ok=True, models=models)


@router.get("/default-prompt")
def default_prompt() -> dict[str, str]:
    """The built-in solver prompt, so the settings UI can show it for editing."""
    return {"prompt": gemini.PROMPT}
