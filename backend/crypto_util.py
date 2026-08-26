"""
Symmetric encryption for third-party (ERP) credentials stored at rest.

We store the student's CampusHub password so BunkMax can re-sync attendance
without the student re-entering it. That password belongs to a third party, so
it is encrypted with Fernet (AES-128-CBC + HMAC-SHA256) using a key that lives
only in the environment (ERP_CRED_KEY), never in the database or the repo.

Generate a key once with:

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

and set it as ERP_CRED_KEY in the deployment environment.
"""

import logging
import os
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger("crypto_util")


class CredentialCryptoError(RuntimeError):
    """Raised when encryption/decryption cannot be performed."""


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    key = os.getenv("ERP_CRED_KEY", "").strip()

    if not key:
        raise CredentialCryptoError(
            "ERP_CRED_KEY is not configured. Generate one with "
            "Fernet.generate_key() and set it in the environment."
        )

    try:
        return Fernet(key.encode())
    except Exception as exc:  # malformed key
        raise CredentialCryptoError("ERP_CRED_KEY is not a valid Fernet key") from exc


def encrypt(plaintext: str) -> str:
    """Encrypt a UTF-8 string, returning a URL-safe base64 token."""
    if plaintext is None:
        raise CredentialCryptoError("Nothing to encrypt")

    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    """Decrypt a token produced by encrypt(). Raises on tamper/wrong key."""
    if not token:
        raise CredentialCryptoError("Nothing to decrypt")

    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise CredentialCryptoError(
            "Stored credential could not be decrypted (key changed or data corrupt)"
        ) from exc


def is_configured() -> bool:
    """True when a usable ERP_CRED_KEY is present. Never raises."""
    try:
        _fernet()
        return True
    except CredentialCryptoError:
        return False
