"""FastAPI application entrypoint.

M1 (Foundation): boots, configures CORS, exposes a health/info endpoint that the
frontend uses to confirm connectivity. Feature routers are added in later milestones.
"""

from __future__ import annotations

# Use the OS trust store (e.g. macOS keychain / corporate root CAs) for TLS so the
# backend can reach providers behind SSL-inspecting proxies. Must run before any TLS.
import truststore

truststore.inject_into_ssl()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app import auth as auth_mod
from app.config import settings
from app.database import engine
from app.routers import providers, remote, solve
from app.routers import auth as auth_router
from app.routers import account, devices, history, usage
from app.routers import updates

app = FastAPI(title="AI Image Interpreter backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths reachable without a session: the OAuth handshake itself and unauthenticated
# health/info probes. The firmware-image download is also exempt because the ESP32 that
# pulls it during an OTA cannot perform the browser OAuth flow (it only serves a public
# firmware blob on the LAN). Everything else under /api requires a valid Google session
# (or the device token) once sign-in is configured.
_AUTH_EXEMPT_PREFIXES = (
    "/api/auth/",
    "/api/info",
    "/health",
    "/api/devices/firmware/binary",
)


@app.middleware("http")
async def require_login(request, call_next):
    """Gate every /api route behind Google sign-in when auth is configured."""
    path = request.url.path
    if (
        settings.auth_configured
        and request.method != "OPTIONS"
        and path.startswith("/api/")
        and not path.startswith(_AUTH_EXEMPT_PREFIXES)
        and not auth_mod.request_is_authorized(request)
    ):
        return JSONResponse({"detail": "Authentication required."}, status_code=401)
    return await call_next(request)


app.include_router(solve.router)
app.include_router(providers.router)
app.include_router(remote.router)
app.include_router(history.router)
app.include_router(usage.router)
app.include_router(updates.router)
app.include_router(devices.router)
app.include_router(account.router)
app.include_router(auth_router.router)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness + database connectivity check."""
    db_ok = True
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001 - report rather than crash the probe
        db_ok = False
    return {
        "status": "ok",
        "service": "ai-image-interpreter-backend",
        "version": app.version,
        "database": "ok" if db_ok else "unavailable",
    }


@app.get("/api/info")
def info() -> dict[str, object]:
    """Basic info the frontend can display to confirm it reached the backend."""
    return {
        "name": "AI Image Interpreter",
        "milestone": "M3 - Auto-detection",
        "cors_origins": settings.cors_origins,
    }
