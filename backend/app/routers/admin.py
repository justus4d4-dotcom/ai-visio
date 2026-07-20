"""Admin-only user management: invite emails to the allowlist and grant the admin role.

All routes require the caller to be an admin (env ``BOOTSTRAP_ADMINS`` or a DB
``allowed_emails`` row with ``is_admin``). Env-configured entries are shown read-only;
only DB entries can be edited or removed here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import auth
from app.config import settings
from app.database import get_db
from app.models import AllowedEmail

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _require_admin(request: Request) -> str | None:
    # Local dev (auth disabled) has full access, matching the profile endpoint.
    if not settings.auth_configured:
        return None
    email = auth.current_email(request)
    if not auth.is_admin(email):
        raise HTTPException(status_code=403, detail="Admin access required.")
    return email


class UserOut(BaseModel):
    email: str
    is_admin: bool
    source: str  # "env" (read-only) | "db" (editable)


class AddUser(BaseModel):
    email: str
    is_admin: bool = False


class UpdateUser(BaseModel):
    is_admin: bool


def _norm(email: str) -> str:
    return email.strip().lower()


@router.get("/users", response_model=list[UserOut])
def list_users(request: Request, db: Session = Depends(get_db)) -> list[UserOut]:
    _require_admin(request)
    out: dict[str, UserOut] = {}
    # Env-configured allowlist / bootstrap admins are read-only here.
    for e in settings.allowed_email_set:
        out[e] = UserOut(email=e, is_admin=e in settings.admin_emails, source="env")
    for e in settings.admin_emails:
        out[e] = UserOut(email=e, is_admin=True, source="env")
    # DB-managed entries take precedence and are editable.
    for row in db.query(AllowedEmail).all():
        out[row.email.lower()] = UserOut(
            email=row.email, is_admin=bool(row.is_admin), source="db"
        )
    return sorted(out.values(), key=lambda u: u.email)


@router.post("/users")
def add_user(body: AddUser, request: Request, db: Session = Depends(get_db)) -> dict:
    _require_admin(request)
    email = _norm(body.email)
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    row = db.query(AllowedEmail).filter(AllowedEmail.email == email).one_or_none()
    if row is not None:
        row.is_admin = body.is_admin
    else:
        db.add(
            AllowedEmail(
                email=email, is_admin=body.is_admin, added_by=auth.current_email(request)
            )
        )
    db.commit()
    auth.invalidate_allowlist_cache()
    return {"ok": True}


@router.patch("/users/{email}")
def update_user(
    email: str, body: UpdateUser, request: Request, db: Session = Depends(get_db)
) -> dict:
    _require_admin(request)
    row = db.query(AllowedEmail).filter(AllowedEmail.email == _norm(email)).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="That user isn't managed here.")
    row.is_admin = body.is_admin
    db.commit()
    auth.invalidate_allowlist_cache()
    return {"ok": True}


@router.delete("/users/{email}")
def remove_user(email: str, request: Request, db: Session = Depends(get_db)) -> dict:
    admin_email = _require_admin(request)
    target = _norm(email)
    if admin_email and target == admin_email.lower():
        raise HTTPException(status_code=400, detail="You can't remove yourself.")
    row = db.query(AllowedEmail).filter(AllowedEmail.email == target).one_or_none()
    if row is not None:
        db.delete(row)
        db.commit()
        auth.invalidate_allowlist_cache()
    return {"ok": True}
