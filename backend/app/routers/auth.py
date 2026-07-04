"""OAuth 2.0 endpoints for Google sign-in. See ``app.auth`` for the flow overview."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

from app import auth
from app.config import settings

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Cookie hardening. Secure=True is fine behind the HTTPS Cloudflare tunnel; SameSite=Lax
# lets the cookie ride the top-level OAuth redirect back from Google.
_COOKIE_KW = dict(httponly=True, secure=True, samesite="lax", path="/")


def _safe_next(raw: str | None) -> str:
    """Only allow same-site relative redirect targets (prevent open redirects)."""
    if raw and raw.startswith("/") and not raw.startswith("//"):
        return raw
    return "/"


@router.get("/me")
def me(request: Request) -> JSONResponse:
    """Tell the frontend whether auth is required and who (if anyone) is signed in."""
    if not settings.auth_configured:
        return JSONResponse({"auth_required": False, "authenticated": True, "email": None})
    email = auth.current_email(request)
    return JSONResponse(
        {"auth_required": True, "authenticated": bool(email), "email": email}
    )


@router.get("/login")
def login(request: Request, next: str | None = None) -> RedirectResponse:
    """Kick off Google sign-in; remembers where to return via a signed state cookie."""
    if not settings.auth_configured:
        return RedirectResponse(url=_safe_next(next))
    state = auth.new_state()
    resp = RedirectResponse(url=auth.google_login_url(state))
    # Bind the OAuth state + the post-login target to this browser for the callback.
    resp.set_cookie(auth.STATE_COOKIE, f"{state}|{_safe_next(next)}", max_age=600, **_COOKIE_KW)
    return resp


@router.get("/callback")
async def callback(request: Request, code: str | None = None, state: str | None = None):
    """Google redirects here with an auth code; verify it and set the session cookie."""
    raw_state = request.cookies.get(auth.STATE_COOKIE) or ""
    expected_state, _, next_target = raw_state.partition("|")
    if not code or not state or not expected_state or state != expected_state:
        return _deny("Sign-in failed (invalid state). Please try again.")

    email = await auth.exchange_code_for_email(code)
    if not email:
        return _deny("Sign-in failed (could not verify your Google account).")
    if not auth.email_allowed(email):
        return _deny(f"{email} is not authorized to access this app.")

    resp = RedirectResponse(url=_safe_next(next_target), status_code=303)
    resp.set_cookie(
        auth.SESSION_COOKIE,
        auth.create_session(email),
        max_age=settings.session_ttl_seconds,
        **_COOKIE_KW,
    )
    resp.delete_cookie(auth.STATE_COOKIE, path="/")
    return resp


@router.post("/logout")
def logout() -> JSONResponse:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.SESSION_COOKIE, path="/")
    return resp


def _deny(message: str) -> JSONResponse:
    resp = JSONResponse({"detail": message}, status_code=403)
    resp.delete_cookie(auth.STATE_COOKIE, path="/")
    return resp
