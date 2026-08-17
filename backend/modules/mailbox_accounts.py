"""Per-user cPanel mailbox credentials (encrypted at rest).

Shared IMAP/SMTP hosts stay in env (MAILBOX_IMAP_HOST, etc.).
Each AppUser stores their own mailbox email + encrypted password.
"""

from __future__ import annotations

import base64
import hashlib
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Iterator

from config import settings

_current_account: ContextVar["MailboxAccount | None"] = ContextVar(
    "mailbox_account", default=None
)
_current_user_id: ContextVar[int | None] = ContextVar("mailbox_user_id", default=None)


@dataclass(frozen=True)
class MailboxAccount:
    email: str
    password: str
    display_name: str | None = None


# Shared mailboxes use a fixed public From name (not the logged-in rep's name).
_MAILBOX_PUBLIC_SENDER_NAMES: dict[str, str] = {
    "info@kafi-group.com": "Asad Ali",
    "marketing@kafi-group.com": "Anjum Ali",
}


def public_sender_display_name(
    mailbox_email: str,
    fallback: str | None = None,
) -> str | None:
    """Return the customer-facing From name for known shared Kafi mailboxes."""
    mapped = _MAILBOX_PUBLIC_SENDER_NAMES.get((mailbox_email or "").strip().lower())
    if mapped:
        return mapped
    cleaned = (fallback or "").strip()
    return cleaned or None


def hosts_enabled() -> bool:
    """Feature flag — credentials are per-user."""
    return bool(settings.mailbox_enabled)


def get_active_mailbox() -> MailboxAccount | None:
    return _current_account.get()


def get_active_mailbox_user_id() -> int | None:
    return _current_user_id.get()


@contextmanager
def use_mailbox(
    account: MailboxAccount | None,
    *,
    user_id: int | None = None,
) -> Iterator[MailboxAccount | None]:
    if account is None:
        yield None
        return
    token = _current_account.set(account)
    uid_token = _current_user_id.set(user_id)
    try:
        yield account
    finally:
        _current_account.reset(token)
        _current_user_id.reset(uid_token)


def _fernet_keys() -> list[bytes]:
    keys: list[bytes] = []
    raw = (settings.mailbox_credentials_key or "").strip()
    if raw:
        # .env keys are sometimes pasted without trailing '=' padding.
        padded = raw + ("=" * ((4 - len(raw) % 4) % 4))
        keys.append(padded.encode("ascii"))
    # Deterministic fallback so local/dev still works without a key set.
    digest = hashlib.sha256(b"kafi-mailbox-dev-key").digest()
    keys.append(base64.urlsafe_b64encode(digest))
    return keys


def encrypt_mailbox_password(password: str) -> str:
    if not password:
        raise ValueError("Mailbox password is required")
    from cryptography.fernet import Fernet

    return Fernet(_fernet_keys()[0]).encrypt(password.encode("utf-8")).decode("ascii")


def decrypt_mailbox_password(token: str) -> str:
    if not token:
        raise ValueError("Mailbox password is missing")
    from cryptography.fernet import Fernet, InvalidToken

    last_exc: Exception | None = None
    for key in _fernet_keys():
        try:
            return Fernet(key).decrypt(token.encode("ascii")).decode("utf-8")
        except (InvalidToken, ValueError, TypeError) as exc:
            last_exc = exc
            continue
    raise ValueError("Could not decrypt mailbox password") from last_exc


def resolve_user_mailbox(user) -> MailboxAccount | None:
    """Build a MailboxAccount from AppUser columns, or None if not set up."""
    if user is None:
        return None
    email = (getattr(user, "mailbox_email", None) or "").strip()
    enc = (getattr(user, "mailbox_password_encrypted", None) or "").strip()
    if not email or not enc:
        return None
    if not bool(getattr(user, "mailbox_enabled", True)):
        return None
    try:
        password = decrypt_mailbox_password(enc)
    except ValueError:
        return None
    display = (getattr(user, "mailbox_display_name", None) or "").strip() or None
    if not display:
        display = (getattr(user, "full_name", None) or "").strip() or None
    display = public_sender_display_name(email, display)
    return MailboxAccount(email=email, password=password, display_name=display)


def user_mailbox_configured(user) -> bool:
    return resolve_user_mailbox(user) is not None


def set_user_mailbox(
    user,
    *,
    mailbox_email: str | None = None,
    mailbox_password: str | None = None,
    mailbox_display_name: str | None = None,
    mailbox_enabled: bool | None = None,
    clear_password: bool = False,
) -> None:
    """Mutate user mailbox fields (caller commits). Password omitted = keep existing."""
    if mailbox_email is not None:
        cleaned = mailbox_email.strip().lower()
        user.mailbox_email = cleaned or None
    if mailbox_display_name is not None:
        cleaned_name = mailbox_display_name.strip()
        user.mailbox_display_name = cleaned_name or None
    if mailbox_enabled is not None:
        user.mailbox_enabled = mailbox_enabled
    if clear_password:
        user.mailbox_password_encrypted = None
    elif mailbox_password is not None and mailbox_password.strip():
        user.mailbox_password_encrypted = encrypt_mailbox_password(mailbox_password)
