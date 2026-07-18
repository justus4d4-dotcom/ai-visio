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
    """Swap an authorization code for tokens and return the verified email (or None).

    The token exchange happens server-to-server over TLS directly with Google, and the
    email is then read from Google's userinfo endpoint using the returned access token.
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
    return email.lower() if isinstance(email, str) else None


def email_allowed(email: str) -> bool:
    allow = settings.allowed_email_set
    return not allow or email.lower() in allow


def create_session(email: str) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    claims = {
        "sub": email,
        "iat": int(now.timestamp()),
        "exp": int((now + dt.timedelta(seconds=settings.session_ttl_seconds)).timestamp()),
    }
    return jwt.encode(claims, settings.auth_secret, algorithm=_ALGORITHM)


def email_from_session(token: str) -> str | None:
    try:
        claims = jwt.decode(token, settings.auth_secret, algorithms=[_ALGORITHM])
    except JWTError:
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


def is_admin(email: str | None) -> bool:
    return bool(email) and email.lower() in settings.admin_emails
