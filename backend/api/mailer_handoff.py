"""Handoff + session exchange for the Vercel mailer app (SMTP off Railway Hobby)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.auth import UserRead, _to_user_read
from api.deps import get_current_user, get_db, get_session_token
from config import settings
from db.models import AppUser
from modules import activity as activity_module
from modules import auth as auth_module
from modules import buyers as buyers_module
from modules import email_activity
from modules.mailbox_accounts import resolve_user_mailbox

router = APIRouter(prefix="/mailer", tags=["mailer"])


def _require_mailer_config() -> tuple[str, str]:
    secret = (settings.mailer_handoff_secret or "").strip()
    public_url = (settings.mailer_public_url or "").strip().rstrip("/")
    if not secret or not public_url:
        raise HTTPException(
            status_code=503,
            detail=(
                "Vercel mailer is not configured. Set MAILER_HANDOFF_SECRET and "
                "MAILER_PUBLIC_URL on Railway."
            ),
        )
    return secret, public_url


class MailerHandoffRequest(BaseModel):
    buyer_ids: list[int] = Field(default_factory=list, max_length=500)


class MailerHandoffResponse(BaseModel):
    url: str
    token: str
    expires_in_seconds: int
    recipient_count: int
    skipped_no_email: int


class MailerScheduleBulkRequest(BaseModel):
    token: str = Field(min_length=10)
    subject: str = Field(min_length=1)
    body: str = Field(min_length=1)
    scheduled_at: datetime
    batch_size: int = Field(default=10, ge=1, le=15)
    message_delay_seconds: float = Field(default=2.0, ge=0)
    batch_pause_seconds: float = Field(default=45.0, ge=0)


class MailerScheduleBulkResponse(BaseModel):
    id: int
    recipient_count: int
    scheduled_at: str
    status: str
    message: str


class MailerSessionResponse(BaseModel):
    url: str
    code: str
    expires_in_seconds: int


class MailerSessionRedeemRequest(BaseModel):
    code: str = Field(min_length=10)


class MailerHandoffLoginRequest(BaseModel):
    token: str = Field(min_length=10)


class MailerAuthResponse(BaseModel):
    token: str
    user: UserRead


class MailerActivityReportRequest(BaseModel):
    """Outbound send lifecycle events from the Vercel mailer → Email Activity feed."""

    # Prefer session Bearer; handoff JWT is accepted for server-to-server reports.
    token: Optional[str] = Field(default=None, description="Bulk handoff JWT")
    kind: Literal["send_result", "bulk_started", "bulk_finished"] = "send_result"
    ok: Optional[bool] = None
    to_email: Optional[str] = None
    subject: Optional[str] = None
    company_name: Optional[str] = None
    buyer_id: Optional[int] = None
    interaction_id: Optional[int] = None
    error_message: Optional[str] = None
    send_mode: Literal["individual", "bulk"] = "individual"
    # When False, skip per-message rows (bulk summary events only).
    record_send: bool = True
    selected_count: Optional[int] = None
    sent_count: Optional[int] = None
    failed_count: Optional[int] = None
    skipped_count: Optional[int] = None


class MailerPrepareTrackedRequest(BaseModel):
    """Wrap a mailer body with an open-tracking pixel before SMTP send."""

    token: Optional[str] = Field(default=None, description="Bulk handoff JWT")
    to: str = Field(min_length=3)
    subject: str = Field(min_length=1)
    body: str = Field(min_length=1)
    buyer_id: Optional[int] = None
    send_mode: Literal["individual", "bulk"] = "individual"


class MailerPrepareTrackedResponse(BaseModel):
    body: str
    html: bool = True
    interaction_id: Optional[int] = None
    tracking_enabled: bool = False
    pixel_url: Optional[str] = None


class MailerActivityReportResponse(BaseModel):
    recorded: bool
    event_id: Optional[int] = None
    event_type: Optional[str] = None


class MailerAppendSentRequest(BaseModel):
    """Save a copy of a Vercel SMTP send into the user's IMAP Sent folder."""

    token: Optional[str] = Field(default=None, description="Bulk handoff JWT")
    to: str = Field(min_length=3)
    subject: str = Field(min_length=1)
    body: str = Field(min_length=1)
    cc: Optional[str] = None
    bcc: Optional[str] = None
    html: bool = True


class MailerAppendSentResponse(BaseModel):
    ok: bool
    message: str
    folder: Optional[str] = None


def _user_from_handoff_token(db: Session, token: str) -> AppUser:
    secret = (settings.mailer_handoff_secret or "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="MAILER_HANDOFF_SECRET not configured")
    try:
        data = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired handoff token") from exc
    user_id = data.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Handoff missing user")
    user = (
        db.query(AppUser)
        .filter(AppUser.id == int(user_id), AppUser.is_active.is_(True))
        .first()
    )
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def _resolve_report_user(
    db: Session,
    *,
    authorization: str | None,
    handoff_token: str | None,
) -> AppUser:
    session_token = auth_module.extract_session_token(
        authorization=authorization,
        cookie_header=None,
    )
    if session_token:
        user = auth_module.get_user_by_token(db, session_token)
        if user:
            return user
    if handoff_token and handoff_token.strip():
        return _user_from_handoff_token(db, handoff_token.strip())
    raise HTTPException(status_code=401, detail="auth_token or handoff token required")


class MailerSmtpCredentialsResponse(BaseModel):
    email: str
    password: str
    display_name: Optional[str] = None


@router.get("/smtp-credentials", response_model=MailerSmtpCredentialsResponse)
def get_mailer_smtp_credentials(
    token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """Return the caller's Sales Agent mailbox password for Vercel SMTP.

    Inbox IMAP already uses this password; mailer Vercel env can drift and cause
    535 Incorrect authentication. Prefer DB credentials for outbound SMTP.
    """
    user = _resolve_report_user(
        db,
        authorization=authorization,
        handoff_token=token,
    )
    account = resolve_user_mailbox(user)
    if not account:
        raise HTTPException(
            status_code=400,
            detail="Your company mailbox is not configured. Ask an admin (Users page).",
        )
    return MailerSmtpCredentialsResponse(
        email=account.email,
        password=account.password,
        display_name=account.display_name,
    )


@router.post("/session", response_model=MailerSessionResponse)
def create_mailer_session(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
    existing_token: str | None = Depends(get_session_token),
):
    """One-time code so Sales Agent can open the mailer already logged in."""
    secret, public_url = _require_mailer_config()
    session_token = existing_token
    if not session_token or not auth_module.get_user_by_token(db, session_token):
        session_token = auth_module.create_session(db, user).token

    expires_in = 90
    now = datetime.now(timezone.utc)
    code = jwt.encode(
        {
            "typ": "mailer_session",
            "session_token": session_token,
            "user_id": user.id,
            "username": user.username,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=expires_in)).timestamp()),
        },
        secret,
        algorithm="HS256",
    )
    if isinstance(code, bytes):
        code = code.decode("ascii")

    return MailerSessionResponse(
        url=f"{public_url}/auth/callback?code={code}&u={user.username}",
        code=code,
        expires_in_seconds=expires_in,
    )


@router.post("/session/redeem", response_model=MailerAuthResponse)
def redeem_mailer_session(
    payload: MailerSessionRedeemRequest,
    db: Session = Depends(get_db),
):
    secret, _ = _require_mailer_config()
    try:
        data = jwt.decode(payload.code, secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired mailer code") from exc

    if data.get("typ") != "mailer_session":
        raise HTTPException(status_code=401, detail="Invalid mailer code type")

    session_token = str(data.get("session_token") or "")
    user = auth_module.get_user_by_token(db, session_token)
    if not user:
        raise HTTPException(status_code=401, detail="Session expired — log in again")

    expected_id = data.get("user_id")
    if expected_id is not None and int(expected_id) != user.id:
        raise HTTPException(status_code=401, detail="Session user mismatch — log in again")

    expected_username = str(data.get("username") or "").strip()
    if expected_username and user.username != expected_username:
        raise HTTPException(status_code=401, detail="Session user mismatch — log in again")

    return MailerAuthResponse(token=session_token, user=_to_user_read(user))


@router.post("/handoff-login", response_model=MailerAuthResponse)
def login_from_bulk_handoff(
    payload: MailerHandoffLoginRequest,
    db: Session = Depends(get_db),
):
    """Exchange a bulk-send handoff JWT for a normal API session (mailer inbox access)."""
    secret, _ = _require_mailer_config()
    try:
        data = jwt.decode(payload.token, secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired handoff token") from exc

    user_id = data.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Handoff missing user")
    user = db.query(AppUser).filter(AppUser.id == int(user_id), AppUser.is_active.is_(True)).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    session = auth_module.create_session(db, user)
    return MailerAuthResponse(token=session.token, user=_to_user_read(user))


@router.post("/handoff", response_model=MailerHandoffResponse)
def create_mailer_handoff(
    payload: MailerHandoffRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    secret, public_url = _require_mailer_config()

    account = resolve_user_mailbox(user)
    if not account:
        raise HTTPException(
            status_code=400,
            detail="Your company mailbox is not configured. Ask an admin (Users page).",
        )

    buyer_ids = list(dict.fromkeys(payload.buyer_ids))
    if not buyer_ids:
        raise HTTPException(status_code=400, detail="Select at least one lead")

    leads: list[dict[str, Any]] = []
    skipped = 0
    for buyer_id in buyer_ids:
        buyer = buyers_module.get_buyer(db, buyer_id)
        if not buyer:
            skipped += 1
            continue
        contact = buyers_module.primary_contact_with_email(db, buyer_id)
        if not contact or not (contact.email or "").strip():
            skipped += 1
            continue
        leads.append(
            {
                "buyer_id": buyer_id,
                "company_name": buyer.company_name,
                "contact_name": contact.full_name,
                "contact_email": contact.email.strip(),
            }
        )

    if not leads:
        raise HTTPException(
            status_code=400,
            detail="None of the selected leads have a contact email",
        )

    expires_in = 20 * 60
    now = datetime.now(timezone.utc)
    token_payload = {
        "user_id": user.id,
        "username": user.username,
        "mailbox_email": account.email,
        "display_name": account.display_name,
        "buyer_ids": [row["buyer_id"] for row in leads],
        "leads": leads,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=expires_in)).timestamp()),
    }
    token = jwt.encode(token_payload, secret, algorithm="HS256")
    if isinstance(token, bytes):
        token = token.decode("ascii")

    return MailerHandoffResponse(
        url=f"{public_url}/bulk?token={token}",
        token=token,
        expires_in_seconds=expires_in,
        recipient_count=len(leads),
        skipped_no_email=skipped,
    )


@router.post("/schedule-bulk", response_model=MailerScheduleBulkResponse)
def schedule_bulk_email(
    payload: MailerScheduleBulkRequest,
    db: Session = Depends(get_db),
):
    """Queue a bulk email campaign for later delivery via Vercel mailer SMTP."""
    from modules import bulk_email_schedule

    user = _user_from_handoff_token(db, payload.token.strip())
    buyer_ids = list(
        dict.fromkeys(
            jwt.decode(
                payload.token.strip(),
                (settings.mailer_handoff_secret or "").strip(),
                algorithms=["HS256"],
            ).get("buyer_ids")
            or []
        )
    )
    if not buyer_ids:
        raise HTTPException(status_code=400, detail="Handoff token has no recipients")

    try:
        row = bulk_email_schedule.create_schedule(
            db,
            user=user,
            buyer_ids=[int(b) for b in buyer_ids],
            subject=payload.subject,
            body=payload.body,
            scheduled_at=payload.scheduled_at,
            batch_size=payload.batch_size,
            message_delay_seconds=payload.message_delay_seconds,
            batch_pause_seconds=payload.batch_pause_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    when = row.scheduled_at.isoformat() if row.scheduled_at else ""
    return MailerScheduleBulkResponse(
        id=row.id,
        recipient_count=len(row.leads or []),
        scheduled_at=when,
        status=row.status,
        message=f"Scheduled {len(row.leads or [])} emails for {when}",
    )


@router.post("/prepare-tracked-body", response_model=MailerPrepareTrackedResponse)
def prepare_mailer_tracked_body(
    payload: MailerPrepareTrackedRequest,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    """Create a tracking interaction and return HTML with an open pixel embedded."""
    from modules import email_tracking

    user = _resolve_report_user(
        db,
        authorization=authorization,
        handoff_token=payload.token,
    )
    to_email = (payload.to or "").strip()
    subject = (payload.subject or "").strip()
    body = payload.body or ""
    mode = "bulk" if payload.send_mode == "bulk" else "individual"

    interaction = email_tracking.ensure_outbound_tracking_interaction(
        db,
        user_id=user.id,
        to_email=to_email,
        subject=subject,
        body=body,
        buyer_id=payload.buyer_id,
        approved_by=user.username,
    )
    if not interaction:
        return MailerPrepareTrackedResponse(
            body=body,
            html=False,
            tracking_enabled=bool(email_tracking.public_api_base()),
        )

    plain, html_body = email_tracking.build_tracked_bodies(
        body,
        interaction_id=interaction.id,
        send_mode=mode,
    )
    pixel = email_tracking.open_pixel_url(
        interaction_id=interaction.id, send_mode=mode
    )
    return MailerPrepareTrackedResponse(
        body=html_body or plain or body,
        html=bool(html_body),
        interaction_id=interaction.id,
        tracking_enabled=bool(pixel),
        pixel_url=pixel,
    )


@router.post("/report-activity", response_model=MailerActivityReportResponse)
def report_mailer_activity(
    payload: MailerActivityReportRequest,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    """Record mailer SMTP sends into Sales Agent Email Activity / Insights."""
    from modules import email_tracking

    user = _resolve_report_user(
        db,
        authorization=authorization,
        handoff_token=payload.token,
    )

    contact_id = None
    company = (payload.company_name or "").strip() or None
    if payload.buyer_id:
        buyer = buyers_module.get_buyer(db, payload.buyer_id)
        if buyer and not company:
            company = buyer.company_name
        contact = buyers_module.primary_contact_with_email(db, payload.buyer_id)
        if contact:
            contact_id = contact.id

    mailbox = resolve_user_mailbox(user)
    source_details = {
        "channel": "email",
        "source": "mailer",
        "provider": "mailer",
        "mailbox_email": mailbox.email if mailbox else None,
    }

    if payload.kind == "bulk_started":
        selected = int(payload.selected_count or 0)
        event = email_activity.record_event(
            db,
            event_type="bulk_started",
            title=f"Bulk send started ({selected} leads)" if selected else "Bulk send started",
            message="Sending via Vercel mailer. Per-message updates are summarized when the batch finishes.",
            mailbox_user=user,
            details={
                **source_details,
                "selected_count": selected,
                "mode": "mailer",
                "send_mode": "bulk",
            },
        )
        return MailerActivityReportResponse(
            recorded=True, event_id=event.id, event_type=event.event_type
        )

    if payload.kind == "bulk_finished":
        sent_count = int(payload.sent_count or 0)
        failed_count = int(payload.failed_count or 0)
        skipped_count = int(payload.skipped_count or 0)
        selected = int(payload.selected_count or (sent_count + failed_count + skipped_count))
        if failed_count > 0 and sent_count > 0:
            event_type = "bulk_partial"
            title = f"Bulk send partial — {sent_count} sent, {failed_count} failed"
        elif failed_count > 0 and sent_count == 0:
            event_type = "send_failed"
            title = f"Bulk send failed — 0 of {selected} sent"
        else:
            event_type = "bulk_completed"
            title = f"Bulk send completed — {sent_count} sent"
        event = email_activity.record_event(
            db,
            event_type=event_type,
            title=title,
            message=(
                f"{sent_count} sent, {failed_count} failed, {skipped_count} skipped "
                f"out of {selected} selected (Vercel mailer)."
            ),
            mailbox_user=user,
            details={
                **source_details,
                "sent_count": sent_count,
                "failed_count": failed_count,
                "skipped_count": skipped_count,
                "selected_count": selected,
                "mode": "mailer",
                "send_mode": "bulk",
            },
        )
        if sent_count > 0:
            activity_module.log_activity(
                db,
                user_id=user.id,
                activity_type=activity_module.BULK_EMAILS_SENT,
                title="Bulk emails sent",
                summary=f"Sent {sent_count} bulk email{'s' if sent_count != 1 else ''} (mailer)",
                quantity=sent_count,
                entity_type="email_activity",
                entity_id=event.id,
                details={"mode": "mailer", "sent_count": sent_count},
            )
        return MailerActivityReportResponse(
            recorded=True, event_id=event.id, event_type=event.event_type
        )

    # kind == send_result
    if not payload.record_send:
        return MailerActivityReportResponse(recorded=False)

    mode = "bulk" if payload.send_mode == "bulk" else "individual"
    to_email = (payload.to_email or "").strip() or None
    subject = (payload.subject or "").strip() or None
    company_name = company or (to_email.split("@")[-1] if to_email else "recipient")

    if payload.ok:
        send_result = {
            "status": "sent",
            "message": "Email sent via Vercel mailer",
            "provider": "mailer",
        }
    else:
        send_result = {
            "status": "error",
            "message": (payload.error_message or "Send failed via Vercel mailer").strip(),
            "provider": "mailer",
        }

    interaction_id = payload.interaction_id
    event = email_activity.record_send_result(
        db,
        send_result=send_result,
        company_name=company_name,
        to_email=to_email,
        buyer_id=payload.buyer_id,
        contact_id=contact_id,
        interaction_id=interaction_id,
        subject=subject,
        send_mode=mode,
        mailbox_user=user,
    )
    # Merge source marker into details without a second write path.
    details = dict(event.details or {})
    details.update(source_details)
    details["send_mode"] = mode
    if interaction_id:
        details["interaction_id"] = interaction_id
    event.details = details
    db.commit()
    db.refresh(event)
    if payload.ok and interaction_id:
        email_tracking.mark_tracking_interaction_sent(db, interaction_id)
    if payload.ok and mode == "individual":
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.PERSONAL_EMAILS_SENT,
            title="Personal email sent",
            summary=f"Sent personal email to {to_email or company_name}",
            quantity=1,
            entity_type="email_activity",
            entity_id=event.id,
            details={
                "mode": "mailer",
                "to_email": to_email,
                "send_mode": "individual",
                "interaction_id": interaction_id,
            },
        )
    return MailerActivityReportResponse(
        recorded=True, event_id=event.id, event_type=event.event_type
    )


@router.post("/append-sent", response_model=MailerAppendSentResponse)
def append_mailer_sent_copy(
    payload: MailerAppendSentRequest,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    """After Vercel SMTP succeeds, APPEND a copy into IMAP Sent (cPanel does not auto-save)."""
    from modules import inbox as inbox_module

    user = _resolve_report_user(
        db,
        authorization=authorization,
        handoff_token=payload.token,
    )
    result = inbox_module.append_sent_copy(
        user,
        to=payload.to,
        subject=payload.subject,
        body=payload.body,
        cc=payload.cc,
        bcc=payload.bcc,
        html=payload.html,
    )
    return MailerAppendSentResponse(
        ok=bool(result.get("ok")),
        message=str(result.get("message") or ""),
        folder=result.get("folder"),
    )
