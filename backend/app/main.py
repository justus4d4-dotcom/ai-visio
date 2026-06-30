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
from sqlalchemy import text

from app.config import settings
from app.database import engine
from app.routers import providers, remote, solve
from app.routers import history

app = FastAPI(title="AI Image Interpreter backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(solve.router)
app.include_router(providers.router)
app.include_router(remote.router)
app.include_router(history.router)


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
