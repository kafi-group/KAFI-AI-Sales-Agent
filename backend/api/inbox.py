"""Inbox API — per-user IMAP mailbox and replies from the dashboard."""

from fastapi import APIRouter, Depends, HTTPException, Query

from api.deps import get_current_user_released
from db.session import SessionLocal
from api.schemas import (
    InboxAnalyzeRequest,
    InboxAnalyzeResponse,
    InboxComposeRequest,
    InboxComposeResponse,
    InboxEmptyTrashResponse,
    InboxFoldersResponse,
    InboxMessageDetail,
    InboxMessageSummary,
    InboxMoveRequest,
    InboxMoveResponse,
    InboxReplyRequest,
    InboxReplyResponse,
    InboxStatus,
    InboxThreadDetail,
    InboxThreadListResponse,
    InboxThreadMoveRequest,
    InboxThreadSummary,
    InboxMailAiQueryRequest,
    InboxMailAiQueryResponse,
    InboxMailSearchRequest,
    InboxMessageListResponse,
    InboxUnreadCount,
)
from db.models import AppUser
from modules import inbox as inbox_module
from modules import inbox_assistant as inbox_assistant_module
from modules import inbox_mail_ai as inbox_mail_ai_module
from modules.mailbox_accounts import hosts_enabled, resolve_user_mailbox

router = APIRouter(prefix="/inbox", tags=["inbox"])

_VALID_FOLDERS = {"inbox", "sent", "trash", "archive"}


def _guard_configured(user: AppUser) -> None:
    if not hosts_enabled():
        raise HTTPException(
            503,
            "Inbox is not enabled. Set MAILBOX_ENABLED=true and IMAP/SMTP hosts in backend/.env",
        )
    if not resolve_user_mailbox(user):
        raise HTTPException(
            503,
            "No mailbox configured for your account. Ask an admin to set your company email on the Users page.",
        )


def _inbox_error_message(exc: Exception) -> str:
    return f"Could not read inbox: {exc}"


@router.get("/status", response_model=InboxStatus)
def inbox_status(user: AppUser = Depends(get_current_user_released)):
    return inbox_module.status(user)


@router.get("/folders", response_model=InboxFoldersResponse)
def inbox_folders(user: AppUser = Depends(get_current_user_released)):
    return inbox_module.list_folders(user)


@router.get("/unread-count", response_model=InboxUnreadCount)
def inbox_unread_count(user: AppUser = Depends(get_current_user_released)):
    return {"count": inbox_module.unread_count(user)}


@router.get("/urgent-unreplied")
def get_urgent_unreplied_emails(user: AppUser = Depends(get_current_user_released)):
    """Fetch unreplied urgent and action-required threads for the active mailbox."""
    if not inbox_module.resolve_user_mailbox(user):
        return {"urgent_threads": [], "count": 0}
    try:
        threads = inbox_module.get_urgent_unreplied_threads(user)
        return {"urgent_threads": threads, "count": len(threads)}
    except Exception as exc:
        return {"urgent_threads": [], "count": 0, "error": str(exc)}


@router.post("/reset-cutoff")
def reset_inbox_cutoff(user: AppUser = Depends(get_current_user_released)):
    _guard_configured(user)
    return inbox_module.reset_cutoff(user)


@router.post("/clear-cutoff")
def clear_inbox_cutoff(user: AppUser = Depends(get_current_user_released)):
    """Show all mailbox mail again (undo 'New mail only')."""
    _guard_configured(user)
    return inbox_module.clear_cutoff(user)


@router.post("/clear-all-cutoffs")
def clear_all_inbox_cutoffs(user: AppUser = Depends(get_current_user_released)):
    """Show all historic mailbox mail for ALL team users."""
    _guard_configured(user)
    return inbox_module.clear_all_cutoffs()


@router.get("/threads", response_model=InboxThreadListResponse)
def list_inbox_threads(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    unread_only: bool = Query(default=False),
    q: str | None = Query(default=None, max_length=200),
    triage_category: str | None = Query(default=None, max_length=40),
    user: AppUser = Depends(get_current_user_released),
):
    _guard_configured(user)
    try:
        result = inbox_module.list_threads(
            user,
            limit=limit,
            offset=offset,
            unread_only=unread_only,
            search_text=q,
            triage_category=triage_category,
        )
        return result
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, _inbox_error_message(exc)) from exc


@router.get("/threads/{thread_id}", response_model=InboxThreadDetail)
def get_inbox_thread(thread_id: str, user: AppUser = Depends(get_current_user_released)):
    _guard_configured(user)
    try:
        thread = inbox_module.get_thread(user, thread_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not read conversation: {exc}") from exc
    if not thread:
        raise HTTPException(404, "Conversation not found")
    return thread


@router.post("/compose", response_model=InboxComposeResponse)
def compose_inbox_mail(
    payload: InboxComposeRequest,
    user: AppUser = Depends(get_current_user_released),
):
    """Compose and send a new email from the logged-in user's mailbox."""
    from modules import activity as activity_module

    _guard_configured(user)
    try:
        result = inbox_module.compose(
            user,
            to=payload.to,
            subject=payload.subject,
            body=payload.body,
            cc=payload.cc,
            bcc=payload.bcc,
            attachments=payload.attachments,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not send email: {exc}") from exc
    if result.get("status") != "sent":
        raise HTTPException(502, result.get("message", "Send failed"))

    subject = result.get("subject") or payload.subject or "(no subject)"
    to_addr = result.get("to") or payload.to
    db = SessionLocal()
    try:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.INBOX_REPLIED,
            title="Compose email sent",
            summary=f"Sent “{subject}” → {to_addr}",
            entity_type="inbox_compose",
            entity_id=None,
            details={
                "subject": subject,
                "to": to_addr,
                "from": result.get("from"),
            },
        )
        db.commit()
    finally:
        db.close()
    return {
        "status": result.get("status", "sent"),
        "message": result.get("message", "Sent"),
        "to": to_addr,
        "subject": subject,
        "from_email": result.get("from"),
    }


@router.post("/threads/{thread_id}/reply", response_model=InboxReplyResponse)
def reply_inbox_thread(
    thread_id: str,
    payload: InboxReplyRequest,
    user: AppUser = Depends(get_current_user_released),
):
    from modules import activity as activity_module

    _guard_configured(user)
    try:
        result = inbox_module.reply_to_thread(
            user,
            thread_id,
            payload.body,
            to=payload.to,
            subject=payload.subject,
            cc=payload.cc,
            bcc=payload.bcc,
            attachments=payload.attachments,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not send reply: {exc}") from exc
    if result.get("status") != "sent":
        raise HTTPException(502, result.get("message", "Reply failed"))

    subject = result.get("subject") or payload.subject or "(no subject)"
    to_addr = result.get("to") or payload.to or ""
    db = SessionLocal()
    try:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.INBOX_REPLIED,
            title="Inbox reply sent",
            summary=f"Replied to “{subject}”" + (f" → {to_addr}" if to_addr else ""),
            entity_type="inbox_thread",
            entity_id=None,
            details={"thread_id": thread_id, "subject": subject, "to": to_addr},
        )
        db.commit()
    finally:
        db.close()
    return result


@router.post("/threads/{thread_id}/move", response_model=InboxMoveResponse)
def move_inbox_thread(
    thread_id: str,
    payload: InboxThreadMoveRequest,
    user: AppUser = Depends(get_current_user_released),
):
    _guard_configured(user)
    to_folder = payload.to_folder.strip().lower()
    if to_folder not in ("inbox", "trash", "archive"):
        raise HTTPException(400, "to_folder must be inbox, trash, or archive")
    try:
        result = inbox_module.move_thread_messages(user, thread_id, to_folder=to_folder)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not move conversation: {exc}") from exc
    if result.get("status") != "ok":
        raise HTTPException(502, result.get("message", "Move failed"))
    return {
        "status": result.get("status", "ok"),
        "message": result.get("message", "Moved"),
        "to_folder": result.get("to_folder"),
        "to_folder_key": result.get("to_folder"),
        "moved_count": result.get("moved_count", 0),
    }


@router.post("/threads/{thread_id}/analyze", response_model=InboxAnalyzeResponse)
def analyze_inbox_thread(
    thread_id: str,
    payload: InboxAnalyzeRequest = InboxAnalyzeRequest(),
    user: AppUser = Depends(get_current_user_released),
):
    """Summarize a conversation and draft a reply the rep can edit before sending."""
    _guard_configured(user)
    try:
        result = inbox_assistant_module.analyze_inbox_thread(
            user, thread_id, goal=payload.goal
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not analyze conversation: {exc}") from exc
    if not result:
        raise HTTPException(404, "Conversation not found")
    return result


@router.post("/messages/{uid}/analyze", response_model=InboxAnalyzeResponse)
def analyze_inbox_message(
    uid: str,
    payload: InboxAnalyzeRequest = InboxAnalyzeRequest(),
    user: AppUser = Depends(get_current_user_released),
):
    """Summarize a single message and draft a reply."""
    _guard_configured(user)
    folder = payload.folder or "INBOX"
    try:
        result = inbox_assistant_module.analyze_inbox_message(
            user, uid, folder=folder, goal=payload.goal
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not analyze message: {exc}") from exc
    if not result:
        raise HTTPException(404, "Message not found")
    return result


@router.get("/messages", response_model=InboxMessageListResponse)
def list_inbox_messages(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    unread_only: bool = Query(default=False),
    folder: str = Query(default="inbox", description="Logical folder: inbox|sent|trash|archive"),
    q: str | None = Query(default=None, max_length=200),
    user: AppUser = Depends(get_current_user_released),
):
    _guard_configured(user)
    key = folder.strip().lower()
    if key not in _VALID_FOLDERS:
        raise HTTPException(400, f"folder must be one of: {', '.join(sorted(_VALID_FOLDERS))}")
    try:
        items = inbox_module.list_messages(
            user,
            limit=limit,
            offset=offset,
            unread_only=unread_only,
            folder=key,
            search_text=q,
        )
        total = len(items)
        if not q:
            folders = inbox_module.list_folders(user)
            for row in folders.get("folders") or []:
                if row.get("key") == key:
                    total = int(row.get("count") or total)
                    break
        return {
            "items": items,
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": len(items) >= limit,
        }
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, _inbox_error_message(exc)) from exc


@router.post("/search", response_model=InboxMessageListResponse)
def search_inbox_mail(
    payload: InboxMailSearchRequest,
    user: AppUser = Depends(get_current_user_released),
):
    _guard_configured(user)
    scope = (payload.scope or "inbox").strip().lower()
    try:
        return inbox_module.search_mail(
            user,
            query=payload.query,
            scope=scope,
            limit=payload.limit,
            offset=payload.offset,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, _inbox_error_message(exc)) from exc


@router.post("/ai-query", response_model=InboxMailAiQueryResponse)
def inbox_ai_query(
    payload: InboxMailAiQueryRequest,
    user: AppUser = Depends(get_current_user_released),
):
    _guard_configured(user)
    try:
        return inbox_mail_ai_module.query_mailbox(
            user,
            question=payload.question,
            unread_only=payload.unread_only,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Mail assistant error: {exc}") from exc


@router.get("/messages/{uid}", response_model=InboxMessageDetail)
def get_inbox_message(
    uid: str,
    folder: str = Query(default="INBOX"),
    user: AppUser = Depends(get_current_user_released),
):
    _guard_configured(user)
    try:
        message = inbox_module.get_message(user, uid, folder=folder)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not read message: {exc}") from exc
    if not message:
        raise HTTPException(404, "Message not found")
    return message


@router.post("/messages/{uid}/read", response_model=InboxUnreadCount)
def mark_inbox_message_read(
    uid: str,
    folder: str = Query(default="INBOX"),
    user: AppUser = Depends(get_current_user_released),
):
    _guard_configured(user)
    try:
        inbox_module.mark_read(user, uid, True, folder=folder)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not update message: {exc}") from exc
    return {"count": inbox_module.unread_count(user)}


@router.post("/messages/{uid}/move", response_model=InboxMoveResponse)
def move_inbox_message(
    uid: str,
    payload: InboxMoveRequest,
    user: AppUser = Depends(get_current_user_released),
):
    _guard_configured(user)
    to_folder = payload.to_folder.strip().lower()
    if to_folder not in _VALID_FOLDERS:
        raise HTTPException(400, f"to_folder must be one of: {', '.join(sorted(_VALID_FOLDERS))}")
    try:
        result = inbox_module.move_message(
            user,
            uid,
            from_folder=payload.from_folder,
            to_folder=to_folder,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not move message: {exc}") from exc
    if result.get("status") != "ok":
        raise HTTPException(502, result.get("message", "Move failed"))
    return {
        "status": result.get("status", "ok"),
        "message": result.get("message", "Moved"),
        "from_folder": result.get("from_folder"),
        "to_folder": result.get("to_folder"),
        "to_folder_key": result.get("to_folder_key"),
        "moved_count": 1,
    }


@router.post("/trash/empty", response_model=InboxEmptyTrashResponse)
def empty_inbox_trash(user: AppUser = Depends(get_current_user_released)):
    _guard_configured(user)
    try:
        result = inbox_module.empty_trash(user)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not empty trash: {exc}") from exc
    if result.get("status") != "ok":
        raise HTTPException(502, result.get("message", "Empty trash failed"))
    return result


@router.post("/messages/{uid}/reply", response_model=InboxReplyResponse)
def reply_inbox_message(
    uid: str,
    payload: InboxReplyRequest,
    user: AppUser = Depends(get_current_user_released),
):
    from modules import activity as activity_module

    _guard_configured(user)
    try:
        result = inbox_module.reply(
            user,
            uid,
            payload.body,
            folder=payload.folder or "INBOX",
            to=payload.to,
            subject=payload.subject,
            cc=payload.cc,
            bcc=payload.bcc,
            attachments=payload.attachments,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not send reply: {exc}") from exc
    if result.get("status") != "sent":
        raise HTTPException(502, result.get("message", "Reply failed"))

    subject = result.get("subject") or payload.subject or "(no subject)"
    to_addr = result.get("to") or payload.to or ""
    db = SessionLocal()
    try:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.INBOX_REPLIED,
            title="Inbox reply sent",
            summary=f"Replied to “{subject}”" + (f" → {to_addr}" if to_addr else ""),
            entity_type="inbox_message",
            entity_id=None,
            details={"uid": uid, "subject": subject, "to": to_addr},
        )
        db.commit()
    finally:
        db.close()
    return result
