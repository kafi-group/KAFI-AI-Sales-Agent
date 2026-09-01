"""Read-only bridge for Kafi Main SaaS / PA dashboard (bank-recon-demo).

Authenticated with header: x-bridge-secret: <AGENT_BRIDGE_SECRET>
Server-side only — never expose the secret to browsers.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.deps import get_db, verify_agent_bridge_secret
from modules import agent_bridge as bridge_module

_BRIDGE_DEPS = [Depends(verify_agent_bridge_secret)]


def _mount_bridge_routes(router: APIRouter) -> None:
    @router.get("/summary")
    def agent_bridge_summary(db: Session = Depends(get_db)) -> dict:
        try:
            return bridge_module.bridge_summary(db)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not build summary: {exc}") from exc

    @router.get("/leads")
    def agent_bridge_leads(
        limit: int = Query(default=20, ge=1, le=100),
        db: Session = Depends(get_db),
    ) -> dict:
        try:
            return bridge_module.bridge_leads(db, limit=limit)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not list leads: {exc}") from exc

    @router.get("/pipeline")
    def agent_bridge_pipeline(db: Session = Depends(get_db)) -> dict:
        try:
            return bridge_module.bridge_pipeline(db)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not load pipeline: {exc}") from exc

    @router.get("/calls")
    def agent_bridge_calls(
        limit: int = Query(default=20, ge=1, le=100),
        db: Session = Depends(get_db),
    ) -> dict:
        try:
            return bridge_module.bridge_calls(db, limit=limit)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not list calls: {exc}") from exc

    @router.get("/performance")
    def agent_bridge_performance(db: Session = Depends(get_db)) -> dict:
        try:
            return bridge_module.bridge_performance(db)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not load performance: {exc}") from exc

    @router.get("/emails")
    def agent_bridge_emails(
        limit: int = Query(default=20, ge=1, le=100),
        db: Session = Depends(get_db),
    ) -> dict:
        try:
            return bridge_module.bridge_emails(db, limit=limit)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not list emails: {exc}") from exc

    @router.post("/send-email")
    def agent_bridge_send_email(
        payload: dict,
        db: Session = Depends(get_db),
    ) -> dict:
        try:
            return bridge_module.send_bridge_email(db, payload)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not send email: {exc}") from exc


router = APIRouter(
    prefix="/agent-bridge",
    tags=["agent-bridge"],
    dependencies=_BRIDGE_DEPS,
)
_mount_bridge_routes(router)

# Alias under /api/webhooks/ so the path bypasses session auth even on older deploys.
webhook_router = APIRouter(
    prefix="/webhooks/agent-bridge",
    tags=["agent-bridge"],
    dependencies=_BRIDGE_DEPS,
)
_mount_bridge_routes(webhook_router)
