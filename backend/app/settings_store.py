"""Per-account settings persistence (Fernet-encrypted JSON blob)."""

from __future__ import annotations

import datetime as dt
import json

from sqlalchemy.orm import Session

from app import crypto, models


def get_settings(db: Session, user_key: str) -> dict:
    row = db.get(models.UserSetting, user_key)
    if row is None:
        return {}
    try:
        return json.loads(crypto.decrypt(row.data_encrypted) or "{}")
    except (json.JSONDecodeError, ValueError):
        return {}


def set_settings(db: Session, user_key: str, data: dict) -> None:
    enc = crypto.encrypt(json.dumps(data))
    now = dt.datetime.now(dt.timezone.utc)
    row = db.get(models.UserSetting, user_key)
    if row is None:
        db.add(models.UserSetting(user_key=user_key, data_encrypted=enc, updated_at=now))
    else:
        row.data_encrypted = enc
        row.updated_at = now
    db.commit()
