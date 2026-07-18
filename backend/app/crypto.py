"""Small symmetric-encryption helper for data at rest (e.g. the BYOK API key).

Uses Fernet (AES-128-CBC + HMAC) with a key derived deterministically from
``settings.encryption_key`` so any passphrase in the env works without needing a
pre-formatted 32-byte urlsafe-base64 Fernet key.
"""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


def _fernet() -> Fernet:
    # Derive a valid 32-byte Fernet key from whatever passphrase is configured.
    digest = hashlib.sha256(settings.encryption_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(plaintext: str) -> str:
    if not plaintext:
        return ""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""
