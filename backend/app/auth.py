"""Google sign-in + session handling for the public deployment.

When ``settings.auth_configured`` is true (a Google client id + secret are set), the app
requires a valid session for every ``/api`` route except the auth handshake and health
probes (see ``app.main``). The flow is the standard OAuth 2.0 authorization-code grant:

    /api/auth/login     -> redirect to Google consent
    /api/auth/callback  -> exchange code, verify email, set a signed session cookie
    /api/auth/logout    -> clear the cookie

The session is a short-lived JWT (HS256, signed with ``AUTH_SECRET``) stored in an
HttpOnly, Secure, SameSite=Lax cookie. Because the frontend and API are served from the
same origin behind the Cloudflare tunnel, the cookie rides along with same-origin fetches
automatically. Non-browser clients (native agent, ESP32) send ``X-Device-Token`` instead.
"""

from __future__ import annotations

import datetime as dt
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import Request
from jose import JWTError, jwt

from app.config import settings

SESSION_COOKIE = "ai_visio_session"
STATE_COOKIE = "ai_visio_oauth_state"
_ALGORITHM = "HS256"

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"


def redirect_uri() -> str:
    """The OAuth callback URL that must be registered in the Google console."""
    base = settings.public_base_url.rstrip("/")
    return f"{base}/api/auth/callback"


def new_state() -> str:
    return secrets.token_urlsafe(24)


def google_login_url(state: str) -> str:
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",
    }
    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"


async def exchange_code_for_email(code: str) -> str | None:
    """Back-compat wrapper: return just the verified email."""
    profile = await exchange_code_for_profile(code)
    return profile["email"] if profile else None


async def exchange_code_for_profile(code: str) -> dict | None:
    """Swap an authorization code for tokens and return the verified Google profile
    ({email, name, picture}) or None. Token exchange is server-to-server over TLS.
    """
    data = {
        "code": code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": redirect_uri(),
        "grant_type": "authorization_code",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        tok = await client.post(GOOGLE_TOKEN_URL, data=data)
        if tok.status_code != 200:
            return None
        access_token = tok.json().get("access_token")
        if not access_token:
            return None
        info = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if info.status_code != 200:
            return None
        payload = info.json()
    if not payload.get("email_verified", False):
        return None
    email = payload.get("email")
    if not isinstance(email, str):
        return None
    return {
        "email": email.lower(),
        "name": payload.get("name") or "",
        "picture": payload.get("picture") or "",
    }


def _db_allowlist() -> dict[str, bool]:
    """The DB-managed allowlist as ``{email: is_admin}``.

    Tolerant of any error (e.g. the table not existing pre-migration) so auth never
    hard-fails on a database hiccup — it just falls back to the env-based allowlist.
    """
    try:
        from app.database import SessionLocal
        from app.models import AllowedEmail

        with SessionLocal() as db:
            return {r.email.lower(): bool(r.is_admin) for r in db.query(AllowedEmail).all()}
    except Exception:  # noqa: BLE001 - never let auth crash on a DB read
        return {}


def email_allowed(email: str) -> bool:
    e = email.lower()
    env = settings.allowed_email_set
    db = _db_allowlist()
    # No allowlist configured anywhere → open (any Google account may sign in).
    if not env and not db:
        return True
    return e in env or e in db


def create_session(email: str, name: str = "", picture: str = "") -> str:
    now = dt.datetime.now(dt.timezone.utc)
    claims = {
        "sub": email,
        "name": name,
        "picture": picture,
        "iat": int(now.timestamp()),
        "exp": int((now + dt.timedelta(seconds=settings.session_ttl_seconds)).timestamp()),
    }
    return jwt.encode(claims, settings.auth_secret, algorithm=_ALGORITHM)


def _claims(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.auth_secret, algorithms=[_ALGORITHM])
    except JWTError:
        return None


def email_from_session(token: str) -> str | None:
    claims = _claims(token)
    if not claims:
        return None
    sub = claims.get("sub")
    return sub if isinstance(sub, str) else None


def request_is_authorized(request: Request) -> bool:
    """True if the request carries a valid session cookie or the device token."""
    # Non-browser devices (agent, ESP32) present a shared token instead of a session.
    if settings.device_token:
        token = request.headers.get("x-device-token") or request.query_params.get("token")
        if token and secrets.compare_digest(token, settings.device_token):
            return True
    cookie = request.cookies.get(SESSION_COOKIE)
    if not cookie:
        return False
    email = email_from_session(cookie)
    return bool(email and email_allowed(email))


def current_email(request: Request) -> str | None:
    cookie = request.cookies.get(SESSION_COOKIE)
    if not cookie:
        return None
    email = email_from_session(cookie)
    if email and email_allowed(email):
        return email
    return None


def current_user_key(request: Request) -> str:
    """Stable key for per-account data: the signed-in email, or "local" when auth is off
    (local dev) or no valid session is present."""
    if not settings.auth_configured:
        return "local"
    return current_email(request) or "local"


def session_profile(request: Request) -> dict | None:
    """{email, name, picture} for the signed-in user, or None."""
    cookie = request.cookies.get(SESSION_COOKIE)
    if not cookie:
        return None
    claims = _claims(cookie)
    if not claims:
        return None
    email = claims.get("sub")
    if not isinstance(email, str) or not email_allowed(email):
        return None
    return {
        "email": email,
        "name": claims.get("name") or "",
        "picture": claims.get("picture") or "",
    }


def is_admin(email: str | None) -> bool:
    if not email:
        return False
    e = email.lower()
    if e in settings.admin_emails:
        return True
    return _db_allowlist().get(e, False)
