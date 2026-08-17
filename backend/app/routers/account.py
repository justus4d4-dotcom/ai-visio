"""Account endpoints: per-user settings sync + profile identity.

Settings (main-app / camera / display) are stored server-side, keyed by the signed-in
Google email, so they follow the user across devices. The blob is encrypted at rest
because it contains the BYOK Gemini key.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import auth, settings_store
from app.config import settings as app_settings
from app.database import get_db

router = APIRouter(prefix="/api", tags=["account"])


class SettingsBody(BaseModel):
    # Free-form settings document: { provider: {...}, camera: {...}, display: {...} }.
    settings: dict


class Profile(BaseModel):
    auth_required: bool
    authenticated: bool
    email: str | None = None
    name: str | None = None
    picture: str | None = None
    is_admin: bool = False


@router.get("/profile", response_model=Profile)
def get_profile(request: Request) -> Profile:
    if not app_settings.auth_configured:
        return Profile(auth_required=False, authenticated=True, email=None, is_admin=True)
    prof = auth.session_profile(request) or {}
    email = prof.get("email")
    return Profile(
        auth_required=True,
        authenticated=bool(email),
        email=email,
        name=prof.get("name") or None,
        picture=prof.get("picture") or None,
        is_admin=auth.is_admin(email),
    )


@router.get("/settings")
def get_settings(request: Request, db: Session = Depends(get_db)) -> dict:
    """The signed-in user's synced settings (empty object if none saved yet)."""
    return settings_store.get_settings(db, auth.current_user_key(request))


@router.put("/settings")
def put_settings(
    body: SettingsBody, request: Request, db: Session = Depends(get_db)
) -> dict:
    user_key = auth.current_user_key(request)
    # Browser settings updates know only their editable sections. Preserve metadata
    # reported by connected displays instead of letting a normal UI save erase it.
    merged = {**settings_store.get_settings(db, user_key), **body.settings}
    settings_store.set_settings(db, user_key, merged)
    return {"ok": True}
