"""Inbox — per-user cPanel/IMAP mailbox (inbox, sent, trash, archive)."""

from __future__ import annotations

import time
from typing import Any

from db.models import AppUser
from integrations.outlook_client import FOLDER_KEYS, outlook_client
from modules.email_threads import group_messages_into_threads, message_key
from modules.inbox_cutoff import get_inbox_since, set_inbox_since_to_now
from modules.mailbox_accounts import (
    hosts_enabled,
    resolve_user_mailbox,
    use_mailbox,
    user_mailbox_configured,
)


def _mailbox_provider() -> str:
    """Label for UI — oauth Graph path vs standard IMAP/SMTP (e.g. cPanel)."""
    if outlook_client._use_oauth():  # noqa: SLF001
        return "outlook"
    return "imap"


# Brief cache so analyze / reopen does not re-hit IMAP for the same thread.
_THREAD_DETAIL_CACHE: dict[str, dict[str, Any]] = {}
_THREAD_DETAIL_TTL_SEC = 45.0


def _thread_cache_key(user: AppUser, thread_id: str) -> str:
    account = resolve_user_mailbox(user)
    email = (account.email if account else "") or f"user:{user.id}"
    return f"{email.lower()}:{thread_id}"


def _thread_cache_get(user: AppUser, thread_id: str) -> dict[str, Any] | None:
    entry = _THREAD_DETAIL_CACHE.get(_thread_cache_key(user, thread_id))
    if not entry:
        return None
    if time.monotonic() - float(entry.get("at") or 0) > _THREAD_DETAIL_TTL_SEC:
        _THREAD_DETAIL_CACHE.pop(_thread_cache_key(user, thread_id), None)
        return None
    data = entry.get("data")
    return dict(data) if isinstance(data, dict) else None


def _thread_cache_set(user: AppUser, thread_id: str, data: dict[str, Any]) -> None:
    key = _thread_cache_key(user, thread_id)
    _THREAD_DETAIL_CACHE[key] = {"at": time.monotonic(), "data": dict(data)}
    if len(_THREAD_DETAIL_CACHE) > 40:
        oldest = sorted(_THREAD_DETAIL_CACHE.items(), key=lambda item: item[1].get("at") or 0)
        for cache_key, _ in oldest[:-20]:
            _THREAD_DETAIL_CACHE.pop(cache_key, None)


def is_configured(user: AppUser | None = None) -> bool:
    if not hosts_enabled():
        return False
    if user is not None:
        return user_mailbox_configured(user)
    return outlook_client.is_configured


def _empty_status() -> dict[str, Any]:
    return {
        "configured": False,
        "email": None,
        "emails": [],
        "mailboxes": [],
        "unread_count": 0,
        "showing_since": None,
    }


def status(user: AppUser) -> dict[str, Any]:
    if not hosts_enabled():
        return _empty_status()
    account = resolve_user_mailbox(user)
    if not account:
        return _empty_status()

    from modules.inbox_cutoff import has_active_cutoff

    with use_mailbox(account, user_id=user.id):
        unread = 0
        try:
            unread = outlook_client.unread_count()
        except Exception:  # noqa: BLE001
            unread = 0

        mailbox = {
            "provider": _mailbox_provider(),
            "email": account.email,
            "configured": True,
        }
        return {
            "configured": True,
            "email": account.email,
            "emails": [account.email],
            "mailboxes": [mailbox],
            "unread_count": unread,
            "showing_since": get_inbox_since(user_id=user.id).isoformat()
            if has_active_cutoff(user_id=user.id)
            else None,
        }


def list_folders(user: AppUser) -> dict[str, Any]:
    """Sidebar folder metadata and approximate counts."""
    empty = {
        "configured": False,
        "folders": [
            {
                "key": key,
                "imap_name": None,
                "available": False,
                "count": 0,
                "unread_count": 0,
            }
            for key in FOLDER_KEYS
        ],
    }
    account = resolve_user_mailbox(user) if hosts_enabled() else None
    if not account:
        return empty
    with use_mailbox(account, user_id=user.id):
        try:
            counts = outlook_client.folder_counts(limit=100)
        except Exception:  # noqa: BLE001
            counts = {
                key: {
                    "key": key,
                    "imap_name": "INBOX" if key == "inbox" else None,
                    "available": key == "inbox",
                    "count": 0,
                    "unread_count": 0,
                }
                for key in FOLDER_KEYS
            }
        return {
            "configured": True,
            "folders": [
                counts.get(
                    key,
                    {"key": key, "available": False, "count": 0, "unread_count": 0},
                )
                for key in FOLDER_KEYS
            ],
        }


def list_messages(
    user: AppUser,
    *,
    limit: int = 25,
    offset: int = 0,
    unread_only: bool = False,
    folder: str = "inbox",
    search_text: str | None = None,
) -> list[dict[str, Any]]:
    account = resolve_user_mailbox(user)
    if not account:
        return []
    key = (folder or "inbox").strip().lower()
    if key not in FOLDER_KEYS:
        raise ValueError(f"Unknown folder: {folder}")
    with use_mailbox(account, user_id=user.id):
        if key == "inbox":
            messages = outlook_client.list_messages(
                limit=limit,
                offset=offset,
                unread_only=unread_only,
                search_text=search_text,
            )
        else:
            messages = outlook_client.list_folder_messages(
                key,
                limit=limit,
                offset=offset,
                unread_only=unread_only,
                search_text=search_text,
            )
        return [{**message, "provider": _mailbox_provider()} for message in messages]


def search_mail(
    user: AppUser,
    *,
    query: str,
    scope: str,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    text = (query or "").strip()
    if not text:
        raise ValueError("Search query is required")
    scope_key = (scope or "inbox").strip().lower()
    if scope_key == "all":
        combined: list[dict[str, Any]] = []
        for folder in ("inbox", "sent", "archive", "trash"):
            combined.extend(
                list_messages(
                    user,
                    limit=limit,
                    offset=0,
                    folder=folder,
                    search_text=text,
                )
            )
        combined.sort(key=lambda m: m.get("date") or "", reverse=True)
        page = combined[offset : offset + limit]
        return {
            "items": page,
            "total": len(combined),
            "offset": offset,
            "limit": limit,
            "has_more": len(combined) > offset + limit,
        }
    if scope_key.startswith("label:"):
        label_id = int(scope_key.split(":", 1)[1])
        from db.models import MailLabel
        from db.session import SessionLocal
        from modules import mail_labels as labels_module

        db = SessionLocal()
        try:
            label = (
                db.query(MailLabel)
                .filter(MailLabel.id == label_id, MailLabel.user_id == user.id)
                .first()
            )
            if not label:
                raise ValueError("Label not found")
            inbox_rows = list_messages(user, limit=200, folder="inbox", search_text=text)
            sent_rows = list_messages(user, limit=80, folder="sent", search_text=text)
            matched = [
                m
                for m in inbox_rows + sent_rows
                if labels_module.message_matches_label_rules(
                    from_email=m.get("from_email"),
                    to_addrs=m.get("to") or [],
                    from_name=m.get("from_name"),
                    subject=m.get("subject"),
                    preview=m.get("preview"),
                    body_text=m.get("body_text"),
                    label=label,
                )
            ]
            page = matched[offset : offset + limit]
            return {
                "items": page,
                "total": len(matched),
                "offset": offset,
                "limit": limit,
                "has_more": len(matched) > offset + limit,
            }
        finally:
            db.close()
    if scope_key not in FOLDER_KEYS:
        raise ValueError(f"Unknown search scope: {scope}")
    items = list_messages(
        user,
        limit=limit,
        offset=offset,
        folder=scope_key,
        search_text=text,
    )
    return {
        "items": items,
        "total": len(items) + offset if len(items) >= limit else offset + len(items),
        "offset": offset,
        "limit": limit,
        "has_more": len(items) >= limit,
    }


def list_inbox_for_query_scan(user: AppUser, *, limit: int = 10) -> list[dict[str, Any]]:
    """Force a live IMAP inbox scan with message bodies (for AI Mode New Lead)."""
    account = resolve_user_mailbox(user)
    if not account:
        return []
    with use_mailbox(account, user_id=user.id):
        messages = outlook_client.list_inbox_for_query_scan(limit=limit)
        return [{**message, "provider": _mailbox_provider()} for message in messages]


def get_message(user: AppUser, uid: str, *, folder: str = "INBOX") -> dict[str, Any] | None:
    account = resolve_user_mailbox(user)
    if not account:
        return None
    with use_mailbox(account, user_id=user.id):
        message = outlook_client.get_message(uid, folder=folder)
        if not message:
            return None
        return {**message, "provider": _mailbox_provider()}


def unread_count(user: AppUser) -> int:
    account = resolve_user_mailbox(user)
    if not account:
        return 0
    with use_mailbox(account, user_id=user.id):
        try:
            return outlook_client.unread_count()
        except Exception:  # noqa: BLE001
            return 0


def mark_read(user: AppUser, uid: str, seen: bool = True, *, folder: str = "INBOX") -> None:
    account = resolve_user_mailbox(user)
    if not account:
        return
    with use_mailbox(account, user_id=user.id):
        outlook_client.mark_read(uid, seen, folder=folder)


def move_message(
    user: AppUser,
    uid: str,
    *,
    from_folder: str,
    to_folder: str,
) -> dict[str, Any]:
    account = resolve_user_mailbox(user)
    if not account:
        return {"status": "error", "message": "Mailbox not configured for your account"}
    with use_mailbox(account, user_id=user.id):
        return outlook_client.move_message(
            uid,
            from_folder=from_folder,
            to_folder_key=to_folder,
        )


def move_thread_messages(
    user: AppUser,
    thread_id: str,
    *,
    to_folder: str,
) -> dict[str, Any]:
    """Move all inbound (non-Sent) messages in a thread to trash/archive/inbox."""
    to_key = (to_folder or "").strip().lower()
    if to_key not in ("trash", "archive", "inbox"):
        return {
            "status": "error",
            "message": "Threads can only be moved to inbox, trash, or archive",
            "moved_count": 0,
        }

    thread = get_thread(user, thread_id, mark_seen=False)
    if not thread or not thread.get("messages"):
        return {"status": "error", "message": "Conversation not found", "moved_count": 0}

    moved = 0
    errors: list[str] = []
    for msg in thread["messages"]:
        folder = (msg.get("folder") or "INBOX").strip()
        if folder.lower().startswith("sent"):
            continue
        if to_key == "trash" and ("trash" in folder.lower() or "deleted" in folder.lower()):
            continue
        if to_key == "archive" and "archive" in folder.lower():
            continue
        if to_key == "inbox" and folder.upper() == "INBOX":
            continue
        result = move_message(
            user, str(msg["uid"]), from_folder=folder, to_folder=to_key
        )
        if result.get("status") == "ok":
            moved += 1
        else:
            errors.append(result.get("message") or "move failed")

    if moved == 0 and errors:
        return {
            "status": "error",
            "message": errors[0],
            "moved_count": 0,
        }
    return {
        "status": "ok",
        "message": f"Moved {moved} message{'s' if moved != 1 else ''} to {to_key}",
        "moved_count": moved,
        "to_folder": to_key,
    }


def empty_trash(user: AppUser) -> dict[str, Any]:
    account = resolve_user_mailbox(user)
    if not account:
        return {"status": "error", "message": "Mailbox not configured for your account", "deleted_count": 0}
    with use_mailbox(account, user_id=user.id):
        return outlook_client.empty_trash()


def reset_cutoff(user: AppUser) -> dict[str, str]:
    return {"showing_since": set_inbox_since_to_now(user_id=user.id).isoformat()}


def clear_cutoff(user: AppUser) -> dict[str, str | None]:
    from modules.inbox_cutoff import clear_inbox_cutoff

    clear_inbox_cutoff(user_id=user.id)
    return {"showing_since": None}


def _strip_thread_internals(thread: dict[str, Any]) -> dict[str, Any]:
    return {
        "thread_id": thread["thread_id"],
        "subject": thread["subject"],
        "participants": thread["participants"],
        "message_count": thread["message_count"],
        "unread_count": thread["unread_count"],
        "latest_date": thread["latest_date"],
        "latest_preview": thread["latest_preview"],
        "latest_from_email": thread["latest_from_email"],
        "latest_from_name": thread["latest_from_name"],
        "has_attachments": thread["has_attachments"],
        "provider": _mailbox_provider(),
        "triage_category": thread.get("triage_category"),
        "triage_label": thread.get("triage_label"),
    }


def list_threads(
    user: AppUser,
    *,
    limit: int = 40,
    offset: int = 0,
    unread_only: bool = False,
    search_text: str | None = None,
    triage_category: str | None = None,
) -> dict[str, Any]:
    account = resolve_user_mailbox(user)
    if not account:
        return {"items": [], "total": 0, "offset": offset, "limit": limit, "has_more": False}
    window = min(max((offset + limit) * 3, 100), 500)
    with use_mailbox(account, user_id=user.id):
        raw = outlook_client.list_conversation_messages(
            limit=window,
            offset=0,
            unread_only=unread_only,
            search_text=search_text,
        )
        stamped = [{**m, "provider": _mailbox_provider()} for m in raw]
        threads = group_messages_into_threads(stamped, mailbox_email=account.email)
        if unread_only:
            threads = [t for t in threads if t.get("unread_count", 0) > 0]
        from modules import mail_labels as labels_module
        from db.session import SessionLocal

        db = SessionLocal()
        try:
            labels = labels_module.list_labels(db, user.id)
            visible = [
                t
                for t in threads
                if not labels_module.thread_matches_label_rules(t, labels)
            ]
        finally:
            db.close()
        from modules.inbox_triage import enrich_thread_with_triage

        visible = [enrich_thread_with_triage(t) for t in visible]
        # Auto-archive low-priority info threads on inbox sync (newsletters, noreply, etc.)
        kept: list[dict[str, Any]] = []
        archived_info = 0
        for t in visible:
            if t.get("triage_category") == "info" and archived_info < 12:
                try:
                    result = move_thread_messages(user, t["thread_id"], to_folder="archive")
                    if result.get("status") == "ok" and (result.get("moved_count") or 0) > 0:
                        archived_info += 1
                        continue
                except Exception:  # noqa: BLE001
                    pass
            kept.append(t)
        visible = kept
        triage_counts: dict[str, int] = {"": len(visible)}
        for t in visible:
            cat = (t.get("triage_category") or "").strip().lower()
            if cat:
                triage_counts[cat] = triage_counts.get(cat, 0) + 1
        triage_key = (triage_category or "").strip().lower()
        if triage_key:
            visible = [t for t in visible if (t.get("triage_category") or "") == triage_key]
        total_estimate = len(visible)
        if not search_text:
            try:
                counts = outlook_client.folder_counts(limit=100)
                total_estimate = int(counts.get("inbox", {}).get("count") or total_estimate)
            except Exception:  # noqa: BLE001
                pass
        page = [_strip_thread_internals(t) for t in visible[offset : offset + limit]]
        return {
            "items": page,
            "total": total_estimate,
            "offset": offset,
            "limit": limit,
            "has_more": len(visible) > offset + limit or window < total_estimate,
            "triage_counts": triage_counts,
        }


def get_thread(
    user: AppUser, thread_id: str, *, mark_seen: bool = True
) -> dict[str, Any] | None:
    account = resolve_user_mailbox(user)
    if not account:
        return None

    cached = _thread_cache_get(user, thread_id)
    if cached and (not mark_seen or cached.get("unread_count", 0) == 0):
        return cached

    with use_mailbox(account, user_id=user.id):
        raw = outlook_client.list_conversation_messages(limit=120, unread_only=False)
        stamped = [{**m, "provider": _mailbox_provider()} for m in raw]
        threads = group_messages_into_threads(stamped, mailbox_email=account.email)
        match = next((t for t in threads if t["thread_id"] == thread_id), None)
        if not match:
            return None

        details = outlook_client.get_messages_by_keys(match["message_keys"])
        detail_by_key = {
            message_key(m): {**m, "provider": _mailbox_provider()} for m in details
        }
        ordered = [detail_by_key[k] for k in match["message_keys"] if k in detail_by_key]

        if mark_seen:
            to_mark = [
                (msg.get("folder") or "INBOX", str(msg["uid"]))
                for msg in ordered
                if msg.get("unread") and msg.get("direction") != "outbound"
            ]
            if to_mark:
                try:
                    outlook_client.mark_read_many(to_mark, seen=True)
                    for msg in ordered:
                        if msg.get("unread") and msg.get("direction") != "outbound":
                            msg["unread"] = False
                except Exception:  # noqa: BLE001
                    for folder, uid in to_mark:
                        try:
                            outlook_client.mark_read(uid, True, folder=folder)
                            for msg in ordered:
                                if str(msg.get("uid")) == uid:
                                    msg["unread"] = False
                        except Exception:  # noqa: BLE001
                            pass

        summary = _strip_thread_internals(match)
        summary["unread_count"] = sum(1 for m in ordered if m.get("unread"))
        summary["messages"] = ordered
        _thread_cache_set(user, thread_id, summary)
        return summary


def _reply_subject(original_subject: str | None) -> str:
    subject = (original_subject or "").strip()
    if subject.lower().startswith("re:"):
        return subject
    return f"Re: {subject}" if subject else "Re:"


def _quote_original(original: dict[str, Any]) -> str:
    """Build a plain-text quote of the original message for reply context."""
    sender = original.get("from_name") or original.get("from_email") or "sender"
    when = original.get("date")
    when_label = ""
    if when is not None:
        try:
            when_label = when.strftime("%Y-%m-%d %H:%M") if hasattr(when, "strftime") else str(when)
        except Exception:  # noqa: BLE001
            when_label = str(when)

    raw = (original.get("body_text") or "").strip()
    if not raw and original.get("body_html"):
        import re

        raw = re.sub(r"<[^>]+>", " ", original["body_html"] or "")
        raw = re.sub(r"\s+", " ", raw).strip()
    if not raw:
        raw = (original.get("preview") or "").strip()

    quoted_lines = [f"> {line}" if line else ">" for line in raw.splitlines()] or [">"]
    header = f"On {when_label}, {sender} wrote:" if when_label else f"{sender} wrote:"
    return "\n".join([header, *quoted_lines])


def _log_email_activity(
    user: AppUser,
    *,
    send_result: dict[str, Any] | None,
    to_email: str | None,
    subject: str | None,
    send_mode: str = "individual",
    source: str = "inbox",
    interaction_id: int | None = None,
) -> None:
    """Write Email Activity for Sales Agent Mail (compose / reply). Best-effort."""
    from modules import email_activity
    from db.session import SessionLocal

    db = SessionLocal()
    try:
        to_addr = (to_email or "").strip() or None
        company = (to_addr.split("@")[-1] if to_addr and "@" in to_addr else None) or "recipient"
        event = email_activity.record_send_result(
            db,
            send_result=send_result
            or {"status": "error", "message": "Send failed", "provider": "smtp"},
            company_name=company,
            to_email=to_addr,
            subject=(subject or "").strip() or None,
            send_mode=send_mode,
            mailbox_user=user,
            interaction_id=interaction_id,
        )
        details = dict(event.details or {})
        details["channel"] = "email"
        details["source"] = source
        if interaction_id:
            details["interaction_id"] = interaction_id
        event.details = details
        db.commit()
        if (send_result or {}).get("status") == "sent" and interaction_id:
            from modules import email_tracking

            email_tracking.mark_tracking_interaction_sent(db, interaction_id)
    except Exception:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    finally:
        db.close()


def _prepare_tracked_send(
    user: AppUser,
    *,
    to_email: str,
    subject: str,
    body: str,
) -> tuple[str, int | None]:
    """Attach an open-tracking pixel when PUBLIC_API_BASE_URL (or Railway domain) is set."""
    from db.session import SessionLocal
    from modules import email_tracking

    db = SessionLocal()
    try:
        interaction = email_tracking.ensure_outbound_tracking_interaction(
            db,
            user_id=user.id,
            to_email=to_email,
            subject=subject,
            body=body,
            approved_by=user.username,
        )
        if not interaction:
            return body, None
        _plain, html_body = email_tracking.build_tracked_bodies(
            body,
            interaction_id=interaction.id,
            send_mode="individual",
        )
        return (html_body or body), interaction.id
    except Exception:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return body, None
    finally:
        db.close()


def reply(
    user: AppUser,
    uid: str,
    body: str,
    *,
    folder: str = "INBOX",
    to: str | None = None,
    subject: str | None = None,
    cc: str | None = None,
    bcc: str | None = None,
    include_quote: bool = True,
) -> dict[str, Any]:
    account = resolve_user_mailbox(user)
    if not account:
        return {
            "status": "not_configured",
            "message": "No mailbox configured for your account. Ask an admin to set your company email.",
        }

    with use_mailbox(account, user_id=user.id):
        original = outlook_client.get_message(uid, folder=folder)
        if not original:
            return {"status": "error", "message": "Original message not found"}
        original = {**original, "provider": _mailbox_provider()}

        recipient = to or original.get("from_email")
        if original.get("direction") == "outbound" and not to:
            tos = original.get("to") or []
            recipient = tos[0] if tos else recipient

        reply_subject = subject or _reply_subject(original.get("subject"))
        send_body = (body or "").rstrip()
        if include_quote and original:
            quote = _quote_original(original)
            already_quoted = (
                send_body.lstrip().startswith("On ")
                or "\n>" in send_body
                or send_body.startswith(">")
            )
            if quote and not already_quoted:
                send_body = f"{send_body}\n\n{quote}" if send_body else quote

        tracked_body, track_interaction_id = _prepare_tracked_send(
            user,
            to_email=str(recipient or ""),
            subject=reply_subject,
            body=send_body,
        )
        result = outlook_client.send_reply(
            to=recipient,
            subject=reply_subject,
            body=tracked_body,
            cc=cc,
            bcc=bcc,
            interaction_id=track_interaction_id,
            send_mode="individual",
        )

        if result.get("status") == "sent":
            try:
                outlook_client.mark_read(uid, True, folder=folder)
            except Exception:  # noqa: BLE001
                pass
            result = {
                **result,
                "to": recipient,
                "subject": reply_subject,
                "from": account.email,
            }

        _log_email_activity(
            user,
            send_result=result,
            to_email=str(recipient or ""),
            subject=reply_subject,
            source="inbox_reply",
            interaction_id=track_interaction_id,
        )
        return result


def reply_to_thread(
    user: AppUser,
    thread_id: str,
    body: str,
    *,
    to: str | None = None,
    subject: str | None = None,
    cc: str | None = None,
    bcc: str | None = None,
) -> dict[str, Any]:
    thread = get_thread(user, thread_id, mark_seen=False)
    if not thread or not thread.get("messages"):
        return {"status": "error", "message": "Conversation not found"}

    messages = thread["messages"]
    target = None
    for msg in reversed(messages):
        if msg.get("direction") != "outbound":
            target = msg
            break
    if target is None:
        target = messages[-1]

    return reply(
        user,
        str(target["uid"]),
        body,
        folder=target.get("folder") or "INBOX",
        to=to,
        subject=subject or _reply_subject(thread.get("subject")),
        cc=cc,
        bcc=bcc,
        include_quote=True,
    )


def compose(
    user: AppUser,
    *,
    to: str,
    subject: str,
    body: str,
    cc: str | None = None,
) -> dict[str, Any]:
    """Send a new outbound email from the logged-in user's mailbox (SMTP/OAuth)."""
    account = resolve_user_mailbox(user)
    if not account:
        return {
            "status": "not_configured",
            "message": "No mailbox configured for your account. Ask an admin to set your company email.",
        }

    recipient = (to or "").strip()
    if not recipient or "@" not in recipient:
        return {"status": "error", "message": "Enter a valid recipient email address"}
    subject_clean = (subject or "").strip() or "(no subject)"
    body_clean = (body or "").rstrip()
    if not body_clean:
        return {"status": "error", "message": "Email body cannot be empty"}

    with use_mailbox(account, user_id=user.id):
        tracked_body, track_interaction_id = _prepare_tracked_send(
            user,
            to_email=recipient,
            subject=subject_clean,
            body=body_clean,
        )
        result = outlook_client.send_reply(
            to=recipient,
            subject=subject_clean,
            body=tracked_body,
            cc=(cc or "").strip() or None,
            interaction_id=track_interaction_id,
            send_mode="individual",
        )
        if result.get("status") == "sent":
            result = {
                **result,
                "to": recipient,
                "subject": subject_clean,
                "from": account.email,
            }
        else:
            result = {
                **(result or {}),
                "to": recipient,
                "subject": subject_clean,
            }

        _log_email_activity(
            user,
            send_result=result,
            to_email=recipient,
            subject=subject_clean,
            source="inbox_compose",
            interaction_id=track_interaction_id,
        )
        return result


def append_sent_copy(
    user: AppUser,
    *,
    to: str,
    subject: str,
    body: str,
    cc: str | None = None,
    bcc: str | None = None,
    html: bool = True,
) -> dict[str, Any]:
    """IMAP APPEND a Sent copy for a message already delivered via Vercel SMTP.

    cPanel SMTP does not auto-save to Sent — the mailer calls this after sendMail.
    """
    from email import utils as email_utils
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    account = resolve_user_mailbox(user)
    if not account:
        return {
            "ok": False,
            "message": "No mailbox configured for your account.",
        }

    recipient = (to or "").strip()
    if not recipient or "@" not in recipient:
        return {"ok": False, "message": "Valid To address required"}
    subject_clean = (subject or "").strip() or "(no subject)"
    body_clean = (body or "").rstrip()
    if not body_clean:
        return {"ok": False, "message": "Body cannot be empty"}

    from_addr = account.email
    display_name = (account.display_name or "").strip()
    message = MIMEMultipart("alternative")
    message["From"] = f"{display_name} <{from_addr}>" if display_name else from_addr
    message["To"] = recipient
    cc_clean = (cc or "").strip()
    if cc_clean:
        message["Cc"] = cc_clean
    bcc_clean = (bcc or "").strip()
    if bcc_clean:
        message["Bcc"] = bcc_clean
    message["Subject"] = subject_clean
    message["Date"] = email_utils.formatdate(localtime=True)
    message["Message-ID"] = email_utils.make_msgid(domain=from_addr.split("@")[-1])
    message["Reply-To"] = from_addr
    message.attach(MIMEText(body_clean, "plain", "utf-8"))
    if html:
        message.attach(
            MIMEText(body_clean.replace("\n", "<br/>"), "html", "utf-8")
        )

    raw = (
        message.as_bytes()
        if hasattr(message, "as_bytes")
        else message.as_string().encode("utf-8")
    )

    with use_mailbox(account, user_id=user.id):
        ok = outlook_client.append_outbound_to_sent(raw)

    if not ok:
        return {
            "ok": False,
            "message": "Could not append to IMAP Sent folder (folder missing or IMAP error).",
        }
    return {"ok": True, "message": "Saved to Sent", "folder": "sent"}
