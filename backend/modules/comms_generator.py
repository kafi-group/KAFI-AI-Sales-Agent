from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from db.models import (
    Buyer,
    Channel,
    Contact,
    Direction,
    HandledBy,
    Interaction,
    InteractionStatus,
)
from integrations.mail_client import mail_client
from integrations.whatsapp_client import whatsapp_client
from modules.email_attachments import (
    copy_attachments,
    merge_attachments,
    public_attachments,
    resolve_attachment_list,
)

WHATSAPP_SESSION_WINDOW_HOURS = 24


def _whatsapp_unread_count(db: Session, contact_id: int) -> int:
    """Inbound messages since the last outbound — awaiting a reply."""
    last_outbound = (
        db.query(Interaction)
        .filter(
            Interaction.contact_id == contact_id,
            Interaction.channel == Channel.whatsapp,
            Interaction.direction == Direction.outbound,
        )
        .order_by(Interaction.created_at.desc())
        .first()
    )
    query = db.query(Interaction).filter(
        Interaction.contact_id == contact_id,
        Interaction.channel == Channel.whatsapp,
        Interaction.direction == Direction.inbound,
    )
    if last_outbound and last_outbound.created_at:
        query = query.filter(Interaction.created_at > last_outbound.created_at)
    return int(query.count())


class CommsGenerator:
    """Template-based draft messages. LLM generation plugs in later."""

    def generate_email_draft(
        self,
        db: Session,
        *,
        contact_id: int,
        goal: str,
        product_name: str | None = None,
        attachments: list[dict] | None = None,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")
        buyer = db.get(Buyer, contact.buyer_id)

        company = buyer.company_name if buyer else "your company"
        subject = f"Kafi Commodities — {goal}"

        # Template fallback
        fallback = (
            f"Dear {contact.full_name},\n\n"
            f"I hope this message finds you well. Following up regarding {goal.lower()} "
            f"for {company}."
        )
        if product_name:
            fallback += f"\n\nWe would be pleased to discuss our {product_name} offering."
        fallback += (
            "\n\nPlease let us know a convenient time to connect.\n\n"
            "Best regards,\nKafi Commodities Sales Team"
        )

        from modules.llm_client import llm_client
        buyer_context = (
            f"Buyer: {company}, Country: {getattr(buyer, 'country', 'unknown')}, "
            f"Industry: {getattr(buyer, 'industry', 'unknown')}"
        )
        body = llm_client.draft_email(
            buyer_country=getattr(buyer, "country", "") or "",
            target_language=contact.preferred_language or "en",
            buyer_context=buyer_context,
            goal=goal,
            product_specs=product_name or "Kafi ESSENCE range",
            fallback_body=fallback,
        )

        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject,
            content=body,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
            attachments=copy_attachments(resolve_attachment_list(attachments)),
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def generate_product_interest_email(
        self,
        db: Session,
        *,
        contact_id: int,
        products: list[dict[str, str]],
        attachments: list[dict] | None = None,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")
        if not contact.email:
            raise ValueError("Contact has no email address")

        buyer = db.get(Buyer, contact.buyer_id)
        company = buyer.company_name if buyer else "your company"

        lines = []
        for item in products:
            name = item.get("name", "")
            category = item.get("category", "")
            if category:
                cat_label = category.replace("_", " ").title()
                lines.append(f"• {name} ({cat_label})")
            else:
                lines.append(f"• {name}")

        product_block = "\n".join(lines)
        subject = f"Kafi Commodities — ESSENCE products for {company}"
        fallback_body = (
            f"Dear {contact.full_name},\n\n"
            f"I hope this message finds you well. Based on what we know about "
            f"{company}, we believe the following products from our Kafi ESSENCE "
            f"range may be a good fit for your business:\n\n"
            f"{product_block}\n\n"
            f"We would be pleased to share specifications, packaging options, and "
            f"pricing tailored to your market. Let us know which lines you would "
            f"like to explore further.\n\n"
            f"Best regards,\nKafi Commodities Sales Team"
        )

        from modules.llm_client import llm_client
        buyer_context = (
            f"Buyer: {company}, Country: {getattr(buyer, 'country', 'unknown')}, "
            f"Industry: {getattr(buyer, 'industry', 'unknown')}"
        )
        product_specs = product_block
        body = llm_client.draft_email(
            buyer_country=getattr(buyer, "country", "") or "",
            target_language=contact.preferred_language or "en",
            buyer_context=buyer_context,
            goal="introduce Kafi ESSENCE product range",
            product_specs=product_specs,
            fallback_body=fallback_body,
        )

        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject,
            content=body,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
            attachments=copy_attachments(resolve_attachment_list(attachments)),
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def generate_quotation_email(
        self,
        db: Session,
        *,
        contact_id: int,
        buyer_name: str,
        product_name: str,
        quantity: float,
        unit_price: float,
        unit_label: str,
        line_total: float,
        incoterms: str | None,
        validity_date,
        lines: list[dict] | None = None,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")
        if not contact.email:
            raise ValueError("Contact has no email address")

        if lines and len(lines) > 1:
            subject = f"Kafi Commodities — Quotation for {buyer_name}"
            product_lines = "\n".join(
                f"- {row['product_name']}: {row['quantity']} @ {row['unit_price']} "
                f"({row.get('price_unit') or unit_label}) = USD {row['line_total']:,.2f}"
                for row in lines
            )
            body = (
                f"Dear {contact.full_name},\n\n"
                f"Please find below our quotation for {buyer_name}.\n\n"
                f"{product_lines}\n\n"
                f"Grand total: USD {line_total:,.2f}\n"
                f"Incoterms: {incoterms or 'FOB'}\n"
                f"Validity: {validity_date}\n\n"
                f"We can share specification sheets and arrange samples on request.\n\n"
                f"Best regards,\nKafi Commodities Export Team"
            )
        else:
            subject = f"Kafi Commodities — Quotation for {product_name}"
            body = (
                f"Dear {contact.full_name},\n\n"
                f"Please find below our quotation for {product_name} "
                f"for {buyer_name}.\n\n"
                f"Product: {product_name}\n"
                f"Quantity: {quantity}\n"
                f"Unit price: {unit_price} ({unit_label})\n"
                f"Incoterms: {incoterms or 'FOB'}\n"
                f"Line total: USD {line_total:,.2f}\n"
                f"Validity: {validity_date}\n\n"
                f"We can share the full specification sheet and arrange samples on request.\n\n"
                f"Best regards,\nKafi Commodities Export Team"
            )
        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject,
            content=body,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def generate_whatsapp_reply(
        self,
        db: Session,
        *,
        contact_id: int,
        inbound_message: str,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")

        reply = (
            f"Thank you for your message. We have received your inquiry and "
            f"will respond with details shortly.\n\n(Original: {inbound_message[:200]})"
        )
        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.whatsapp,
            direction=Direction.outbound,
            content=reply,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def _find_whatsapp_contact(self, db: Session, wa_id: str) -> Contact | None:
        """Match by Meta wa_id, E.164 phone, or bare digits."""
        from integrations.voice_client import normalize_e164

        raw = (wa_id or "").strip()
        if not raw:
            return None
        digits = "".join(ch for ch in raw if ch.isdigit())
        normalized = normalize_e164(raw) or normalize_e164(digits)

        candidates = [raw, digits]
        if normalized:
            candidates.append(normalized)
            candidates.append(normalized.lstrip("+"))
        # Deduplicate while preserving order
        seen: set[str] = set()
        keys: list[str] = []
        for key in candidates:
            if key and key not in seen:
                seen.add(key)
                keys.append(key)

        contact = (
            db.query(Contact)
            .filter(Contact.wa_id.in_(keys))
            .order_by(Contact.id.asc())
            .first()
        )
        if contact:
            return contact

        phone_keys = [k for k in keys if k.startswith("+") or len(k) >= 10]
        if phone_keys:
            contact = (
                db.query(Contact)
                .filter(Contact.phone.in_(phone_keys))
                .order_by(Contact.id.asc())
                .first()
            )
            if contact:
                return contact

        # Last-resort: match phone/wa_id by trailing digits (country-code drift).
        if len(digits) >= 10:
            tail = digits[-10:]
            for row in (
                db.query(Contact)
                .filter((Contact.phone.isnot(None)) | (Contact.wa_id.isnot(None)))
                .order_by(Contact.id.desc())
                .limit(500)
                .all()
            ):
                for value in (row.phone, row.wa_id):
                    if value and "".join(ch for ch in value if ch.isdigit()).endswith(tail):
                        return row
        return None

    def _ensure_whatsapp_contact(
        self,
        db: Session,
        *,
        wa_id: str,
        profile_name: str | None = None,
    ) -> Contact:
        """Find or auto-create a buyer+contact so inbound WhatsApp is never dropped."""
        from integrations.voice_client import normalize_e164

        contact = self._find_whatsapp_contact(db, wa_id)
        if contact:
            return contact

        digits = "".join(ch for ch in (wa_id or "") if ch.isdigit())
        phone = normalize_e164(wa_id) or normalize_e164(digits) or (f"+{digits}" if digits else wa_id)
        display = (profile_name or "").strip() or phone or wa_id
        buyer = Buyer(
            company_name=display,
            source="whatsapp_inbound",
            remarks="Auto-created from inbound WhatsApp message",
        )
        db.add(buyer)
        db.flush()
        contact = Contact(
            buyer_id=buyer.id,
            full_name=display,
            phone=phone,
            wa_id=digits or wa_id,
            whatsapp_opt_in=True,
            data_source="whatsapp_inbound",
        )
        db.add(contact)
        db.flush()
        return contact

    def record_inbound_whatsapp_message(
        self,
        db: Session,
        *,
        wa_id: str,
        message_text: str,
        provider_message_id: str | None = None,
        profile_name: str | None = None,
        create_reply_draft: bool = True,
    ) -> Interaction | None:
        """Webhook entrypoint — logs inbound WhatsApp, opens the 24h window.

        Unknown senders are auto-created as individual leads so messages always
        appear in WhatsApp inbox.
        """
        if provider_message_id:
            existing = (
                db.query(Interaction)
                .filter(Interaction.provider_message_id == provider_message_id)
                .first()
            )
            if existing:
                return existing

        contact = self._ensure_whatsapp_contact(
            db, wa_id=wa_id, profile_name=profile_name
        )
        digits = "".join(ch for ch in (wa_id or "") if ch.isdigit())
        contact.wa_id = contact.wa_id or digits or wa_id
        if not contact.phone:
            from integrations.voice_client import normalize_e164

            contact.phone = normalize_e164(wa_id) or normalize_e164(digits)
        if profile_name and (
            not contact.full_name
            or contact.full_name.startswith("+")
            or contact.data_source == "whatsapp_inbound"
        ):
            contact.full_name = profile_name.strip()
            buyer = db.get(Buyer, contact.buyer_id)
            if buyer and buyer.source == "whatsapp_inbound":
                buyer.company_name = profile_name.strip()

        contact.whatsapp_window_expires_at = datetime.now(timezone.utc) + timedelta(
            hours=WHATSAPP_SESSION_WINDOW_HOURS
        )
        inbound = Interaction(
            contact_id=contact.id,
            channel=Channel.whatsapp,
            direction=Direction.inbound,
            content=message_text,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.human,
            status=InteractionStatus.sent,
            provider_message_id=provider_message_id,
        )
        db.add(inbound)
        db.commit()
        db.refresh(inbound)

        if create_reply_draft:
            self.generate_whatsapp_reply(
                db, contact_id=contact.id, inbound_message=message_text
            )
        return inbound

    def create_manual_whatsapp_draft(
        self,
        db: Session,
        *,
        contact_id: int,
        content: str,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")
        if not contact.phone and not contact.wa_id:
            raise ValueError("Contact has no phone number on file")

        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.whatsapp,
            direction=Direction.outbound,
            content=content,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.human,
            status=InteractionStatus.draft,
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def list_whatsapp_conversations(
        self,
        db: Session,
        *,
        assigned_to_user_id: int | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[dict], int]:
        """One row per contact that has at least one WhatsApp interaction, most-recent first."""
        page = max(1, page)
        page_size = min(max(1, page_size), 100)

        from sqlalchemy import func as sa_func, or_

        meta_condition = (
            (Interaction.channel == Channel.whatsapp)
            & (Interaction.contact_id.isnot(None))
            & (
                (Interaction.template_name.isnot(None))
                | (Interaction.provider_message_id.like("wamid.%"))
                | (Interaction.provider_message_id.like("meta_%"))
                | (Interaction.wa_status.isnot(None))
            )
            & (
                (Interaction.provider_message_id.is_(None))
                | (~Interaction.provider_message_id.like("baileys%"))
            )
        )

        latest_q = (
            db.query(
                Interaction.contact_id.label("contact_id"),
                sa_func.max(Interaction.created_at).label("last_at"),
            )
            .filter(meta_condition)
        )
        if assigned_to_user_id is not None:
            latest_q = (
                latest_q.join(Contact, Interaction.contact_id == Contact.id)
                .join(Buyer, Contact.buyer_id == Buyer.id)
                .filter(Buyer.assigned_to_user_id == assigned_to_user_id)
            )
        if assigned_to_user_id is not None:
            total = (
                db.query(sa_func.count(sa_func.distinct(Interaction.contact_id)))
                .join(Contact, Interaction.contact_id == Contact.id)
                .join(Buyer, Contact.buyer_id == Buyer.id)
                .filter(meta_condition, Buyer.assigned_to_user_id == assigned_to_user_id)
                .scalar()
                or 0
            )
        else:
            total = (
                db.query(sa_func.count(sa_func.distinct(Interaction.contact_id)))
                .filter(meta_condition)
                .scalar()
                or 0
            )

        rows = (
            db.query(latest_sub)
            .order_by(latest_sub.c.last_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        contact_ids = [r.contact_id for r in rows if r.contact_id is not None]
        if not contact_ids:
            return [], total

        # Batch load contacts with buyers
        contacts = (
            db.query(Contact)
            .filter(Contact.id.in_(contact_ids))
            .all()
        )
        contacts_by_id = {c.id: c for c in contacts}
        buyer_ids = [c.buyer_id for c in contacts if c.buyer_id]
        buyers_by_id = {}
        if buyer_ids:
            buyers = db.query(Buyer).filter(Buyer.id.in_(buyer_ids)).all()
            buyers_by_id = {b.id: b for b in buyers}

        # Batch load the most recent Meta interaction for each contact
        recent_interactions = (
            db.query(Interaction)
            .filter(
                Interaction.contact_id.in_(contact_ids),
                meta_condition,
            )
            .order_by(Interaction.created_at.desc())
            .all()
        )
        latest_interaction_by_contact: dict[int, Interaction] = {}
        for ix in recent_interactions:
            if ix.contact_id and ix.contact_id not in latest_interaction_by_contact:
                latest_interaction_by_contact[ix.contact_id] = ix

        def _is_clean_name(val: str | None, phone_str: str | None = None) -> bool:
            if not val:
                return False
            s = str(val).strip()
            if not s:
                return False
            stripped = "".join(ch for ch in s if ch.isalnum())
            if not stripped or stripped.isdigit():
                return False
            if phone_str:
                p_digits = "".join(ch for ch in phone_str if ch.isdigit())
                s_digits = "".join(ch for ch in s if ch.isdigit())
                if p_digits and s_digits and p_digits == s_digits:
                    return False
            return True

        # Pre-lookup master contacts for any inbound/unresolved contacts by phone
        phone_to_master: dict[str, tuple[str | None, str | None]] = {}
        candidate_phones: set[str] = set()
        for cid in contact_ids:
            c = contacts_by_id.get(cid)
            if c:
                raw_phone = (c.phone or c.wa_id or "").strip()
                digits = "".join(ch for ch in raw_phone if ch.isdigit())
                if digits:
                    candidate_phones.add(digits)
                    if len(digits) >= 10:
                        candidate_phones.add(digits[-10:])

        if candidate_phones:
            phone_filters = []
            for p in list(candidate_phones)[:40]:
                phone_filters.append(Contact.phone.like(f"%{p}%"))
                phone_filters.append(Contact.wa_id.like(f"%{p}%"))

            master_matches = (
                db.query(Contact)
                .join(Buyer, Contact.buyer_id == Buyer.id)
                .filter(
                    Contact.data_source != "whatsapp_inbound",
                    or_(*phone_filters),
                )
                .limit(50)
                .all()
            )
            for mc in master_matches:
                for ph in (mc.phone, mc.wa_id, mc.primary_phone, mc.secondary_mobile):
                    if not ph:
                        continue
                    digs = "".join(ch for ch in ph if ch.isdigit())
                    if not digs:
                        continue
                    mbuyer = mc.buyer
                    cname = mc.full_name if _is_clean_name(mc.full_name, ph) else None
                    comp = mbuyer.company_name if mbuyer and _is_clean_name(mbuyer.company_name, ph) else None
                    if cname or comp:
                        phone_to_master[digs] = (cname, comp)
                        if len(digs) >= 10:
                            phone_to_master[digs[-10:]] = (cname, comp)

        conversations: list[dict] = []
        now_utc = datetime.now(timezone.utc)
        for row in rows:
            if not row.contact_id:
                continue
            contact = contacts_by_id.get(row.contact_id)
            if not contact:
                continue
            buyer = buyers_by_id.get(contact.buyer_id)
            last_message = latest_interaction_by_contact.get(contact.id)
            expires = contact.whatsapp_window_expires_at
            if expires is not None and expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            within_window = bool(expires and expires > now_utc)

            contact_phone = contact.phone or contact.wa_id
            contact_name = contact.full_name if _is_clean_name(contact.full_name, contact_phone) else None
            company_name = buyer.company_name if (buyer and _is_clean_name(buyer.company_name, contact_phone)) else None

            # Fallback to master contact list match if available
            raw_digs = "".join(ch for ch in (contact_phone or "") if ch.isdigit())
            master_info = phone_to_master.get(raw_digs) or (phone_to_master.get(raw_digs[-10:]) if len(raw_digs) >= 10 else None)
            if master_info:
                master_cname, master_comp = master_info
                if not contact_name and master_cname:
                    contact_name = master_cname
                if not company_name and master_comp:
                    company_name = master_comp

            conversations.append(
                {
                    "contact_id": contact.id,
                    "buyer_id": contact.buyer_id,
                    "company_name": company_name,
                    "contact_name": contact_name,
                    "contact_phone": contact_phone,
                    "whatsapp_opt_in": contact.whatsapp_opt_in,
                    "within_session_window": within_window,
                    "window_expires_at": contact.whatsapp_window_expires_at,
                    "last_message": last_message.content if last_message else None,
                    "last_message_at": last_message.created_at if last_message else None,
                    "last_direction": (
                        last_message.direction.value
                        if (last_message and hasattr(last_message.direction, "value"))
                        else (str(last_message.direction) if last_message else None)
                    ),
                }
            )
        return conversations, total

    def list_whatsapp_messages(
        self,
        db: Session,
        *,
        contact_id: int,
        limit: int = 200,
    ) -> list[Interaction]:
        from sqlalchemy import or_

        meta_condition = (
            (Interaction.channel == Channel.whatsapp)
            & (Interaction.contact_id == contact_id)
            & (
                (Interaction.template_name.isnot(None))
                | (Interaction.provider_message_id.like("wamid.%"))
                | (Interaction.provider_message_id.like("meta_%"))
                | (Interaction.wa_status.isnot(None))
            )
            & (
                (Interaction.provider_message_id.is_(None))
                | (~Interaction.provider_message_id.like("baileys%"))
            )
        )
        return (
            db.query(Interaction)
            .filter(meta_condition)
            .order_by(Interaction.created_at.asc())
            .limit(limit)
            .all()
        )

    def get_whatsapp_buyer_preview(
        self,
        db: Session,
        *,
        buyer_id: int,
        recent: int = 3,
    ) -> dict:
        """Recent WhatsApp messages for a buyer profile card (most-active contact)."""
        from sqlalchemy import func as sa_func

        recent = max(1, min(int(recent or 3), 10))
        latest = (
            db.query(
                Interaction.contact_id.label("contact_id"),
                sa_func.max(Interaction.created_at).label("last_at"),
            )
            .join(Contact, Contact.id == Interaction.contact_id)
            .filter(
                Contact.buyer_id == buyer_id,
                Interaction.channel == Channel.whatsapp,
            )
            .group_by(Interaction.contact_id)
            .order_by(sa_func.max(Interaction.created_at).desc())
            .first()
        )
        if not latest:
            return {
                "buyer_id": buyer_id,
                "contact_id": None,
                "contact_name": None,
                "contact_phone": None,
                "within_session_window": False,
                "total_messages": 0,
                "messages": [],
            }

        contact = db.get(Contact, latest.contact_id)
        if not contact:
            return {
                "buyer_id": buyer_id,
                "contact_id": None,
                "contact_name": None,
                "contact_phone": None,
                "within_session_window": False,
                "total_messages": 0,
                "messages": [],
            }

        total = (
            db.query(Interaction)
            .filter(
                Interaction.contact_id == contact.id,
                Interaction.channel == Channel.whatsapp,
            )
            .count()
        )
        # Newest first, then reverse so the preview reads like a short chat.
        newest = (
            db.query(Interaction)
            .filter(
                Interaction.contact_id == contact.id,
                Interaction.channel == Channel.whatsapp,
            )
            .order_by(Interaction.created_at.desc())
            .limit(recent)
            .all()
        )
        messages = list(reversed(newest))

        expires = contact.whatsapp_window_expires_at
        if expires is not None and expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        within_window = bool(expires and expires > datetime.now(timezone.utc))

        return {
            "buyer_id": buyer_id,
            "contact_id": contact.id,
            "contact_name": contact.full_name,
            "contact_phone": contact.phone or contact.wa_id,
            "within_session_window": within_window,
            "total_messages": total,
            "messages": messages,
        }

    def update_whatsapp_message_status(
        self,
        db: Session,
        *,
        provider_message_id: str,
        status: str,
    ) -> Interaction | None:
        interaction = (
            db.query(Interaction)
            .filter(Interaction.provider_message_id == provider_message_id)
            .first()
        )
        if not interaction:
            return None
        interaction.wa_status = status
        db.commit()
        db.refresh(interaction)
        return interaction

    def create_whatsapp_campaign_drafts(
        self,
        db: Session,
        *,
        buyer_ids: list[int],
        template_id: int,
        template_variables: list[str] | None = None,
        require_opt_in: bool = False,
        send: bool = True,
        user_id: int | None = None,
    ) -> dict:
        import time

        from config import settings
        from modules import email_activity
        from modules import whatsapp_templates as templates_module

        # Bulk WhatsApp always delivers immediately (approval queue removed).
        send = True

        template = templates_module.get_template(db, template_id)
        if not template:
            raise ValueError("WhatsApp template not found")
        from db.models import WhatsAppTemplateStatus

        if template.status != WhatsAppTemplateStatus.approved:
            raise ValueError(
                f"Template '{template.name}' is not approved by Meta yet "
                f"(status: {template.status.value})"
            )

        variables = template_variables or []

        created: list[dict] = []
        skipped: list[dict] = []
        sent_count = 0
        failed_count = 0
        is_bulk_batch = send and len(buyer_ids) > 1
        record_each = send and not is_bulk_batch

        if is_bulk_batch:
            email_activity.record_event(
                db,
                event_type="bulk_started",
                title=f"Bulk WhatsApp send started ({len(buyer_ids)} leads)",
                message=f"Sending approved template '{template.name}'. "
                "Per-message updates are summarized when the batch finishes.",
                user_id=user_id,
                details={"buyer_ids": buyer_ids, "template_id": template_id, "channel": "whatsapp"},
            )

        for index, buyer_id in enumerate(buyer_ids):
            buyer = db.get(Buyer, buyer_id)
            if not buyer:
                skipped.append({"buyer_id": buyer_id, "reason": "lead not found"})
                continue
            try:
                from modules import buyers as buyers_module

                contact = buyers_module.primary_contact_with_phone(db, buyer_id)
                if not contact:
                    raise ValueError(f"No contact with a phone number for {buyer.company_name}")
                if (
                    require_opt_in
                    and template.category
                    and template.category.upper() == "MARKETING"
                    and not contact.whatsapp_opt_in
                ):
                    raise ValueError(
                        f"{buyer.company_name} contact has not opted in to WhatsApp marketing"
                    )

                if template.body_text and template.variable_count > 0:
                    buyer_variables = templates_module.merge_template_variables(
                        variables,
                        templates_module.suggest_template_variables(
                            template.body_text,
                            template.variable_count,
                            contact_name=contact.full_name,
                            company_name=buyer.company_name,
                            country=buyer.country,
                        ),
                    )
                else:
                    buyer_variables = variables

                rendered_body = (
                    templates_module.render_variables(template.body_text, buyer_variables)
                    if template.body_text
                    else template.name
                )

                draft = Interaction(
                    contact_id=contact.id,
                    channel=Channel.whatsapp,
                    direction=Direction.outbound,
                    content=rendered_body,
                    language=contact.preferred_language or "en",
                    handled_by=HandledBy.human,
                    status=InteractionStatus.draft,
                    template_name=template.name,
                )
                db.add(draft)
                db.commit()
                db.refresh(draft)

                item = {
                    "buyer_id": buyer_id,
                    "company_name": buyer.company_name,
                    "interaction_id": draft.id,
                    "contact_id": draft.contact_id,
                    "sent": False,
                    "send_status": None,
                    "send_message": None,
                }
                if send:
                    _approved, send_result = self.approve_draft(
                        db,
                        draft.id,
                        approved_by="dashboard_user",
                        send=True,
                        record_activity=record_each,
                        template_name=template.name,
                        template_language=template.language or "en_US",
                        template_variables=buyer_variables,
                        user_id=user_id,
                    )
                    status = (send_result or {}).get("status")
                    item["sent"] = status == "sent"
                    item["send_status"] = status
                    item["send_message"] = (send_result or {}).get("message")
                    if status == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1
                    if (
                        index < len(buyer_ids) - 1
                        and settings.bulk_whatsapp_message_delay_seconds > 0
                    ):
                        time.sleep(settings.bulk_whatsapp_message_delay_seconds)
                created.append(item)
            except ValueError as exc:
                reason = str(exc)
                skipped.append(
                    {"buyer_id": buyer_id, "company_name": buyer.company_name, "reason": reason}
                )
                if record_each:
                    email_activity.record_event(
                        db,
                        event_type="send_failed",
                        title=f"Skipped — {buyer.company_name}",
                        message=reason,
                        buyer_id=buyer_id,
                        user_id=user_id,
                        details={"reason": reason, "channel": "whatsapp"},
                    )

        if is_bulk_batch:
            if failed_count > 0 and sent_count > 0:
                event_type = "bulk_partial"
                title = f"Bulk WhatsApp send partial — {sent_count} sent, {failed_count} failed"
            elif failed_count > 0 and sent_count == 0:
                event_type = "send_failed"
                title = f"Bulk WhatsApp send failed — 0 of {len(buyer_ids)} sent"
            else:
                event_type = "bulk_completed"
                title = f"Bulk WhatsApp send completed — {sent_count} sent"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=title,
                message=(
                    f"{sent_count} sent, {failed_count} failed, {len(skipped)} skipped "
                    f"out of {len(buyer_ids)} selected."
                ),
                user_id=user_id,
                details={
                    "sent_count": sent_count,
                    "failed_count": failed_count,
                    "skipped_count": len(skipped),
                    "selected_count": len(buyer_ids),
                    "template_id": template_id,
                    "channel": "whatsapp",
                    "skipped": skipped[:20],
                },
            )

        return {
            "created_count": len(created),
            "skipped_count": len(skipped),
            "sent_count": sent_count,
            "failed_count": failed_count,
            "created": created,
            "skipped": skipped,
        }

    def approve_draft(
        self,
        db: Session,
        interaction_id: int,
        *,
        content: str | None = None,
        approved_by: str = "sales_rep",
        send: bool = True,
        record_activity: bool = True,
        send_mode: str = "individual",
        template_name: str | None = None,
        template_language: str = "en_US",
        template_variables: list[str] | None = None,
        mailbox_user=None,
        user_id: int | None = None,
    ) -> tuple[Interaction, dict | None]:
        draft = db.get(Interaction, interaction_id)
        if not draft:
            raise ValueError("Interaction not found")
        if draft.status not in (InteractionStatus.draft, InteractionStatus.approved):
            raise ValueError(f"Cannot approve interaction in status {draft.status}")

        if content:
            draft.content = content
        draft.status = InteractionStatus.approved
        draft.approved_by = approved_by
        db.commit()
        db.refresh(draft)

        send_result: dict | None = None
        if send and draft.channel == Channel.email:
            send_result = self._send_email_draft(
                db,
                draft,
                record_activity=record_activity,
                send_mode=send_mode,
                mailbox_user=mailbox_user,
            )
        elif send and draft.channel == Channel.whatsapp:
            send_result = self._send_whatsapp_draft(
                db,
                draft,
                record_activity=record_activity,
                template_name=template_name or draft.template_name,
                template_language=template_language,
                template_variables=template_variables,
                user_id=user_id,
            )

        return draft, send_result

    def _send_email_draft(
        self,
        db: Session,
        draft: Interaction,
        *,
        record_activity: bool,
        send_mode: str = "individual",
        mailbox_user=None,
    ) -> dict:
        contact = db.get(Contact, draft.contact_id)
        if not contact or not contact.email:
            if record_activity:
                from modules import email_activity

                buyer = db.get(Buyer, contact.buyer_id) if contact else None
                email_activity.record_event(
                    db,
                    event_type="invalid_recipient",
                    title=f"Invalid recipient — {buyer.company_name if buyer else 'lead'}",
                    message="Contact has no email address — cannot send.",
                    buyer_id=contact.buyer_id if contact else None,
                    contact_id=draft.contact_id,
                    interaction_id=draft.id,
                    details={"send_mode": send_mode},
                    mailbox_user=mailbox_user,
                )
            raise ValueError("Contact has no email address — cannot send")

        mode = "bulk" if send_mode == "bulk" else "individual"
        send_result = mail_client.send_approved(
            to=contact.email,
            subject=draft.subject or "Kafi Commodities",
            body=draft.content,
            attachments=draft.attachments or [],
            interaction_id=draft.id,
            send_mode=mode,
            mailbox_user=mailbox_user,
        )
        if send_result.get("status") == "sent":
            draft.status = InteractionStatus.sent
            db.commit()
            db.refresh(draft)

        if record_activity:
            from modules import email_activity

            buyer = db.get(Buyer, contact.buyer_id)
            email_activity.record_send_result(
                db,
                send_result=send_result,
                company_name=buyer.company_name if buyer else "Unknown",
                to_email=contact.email,
                buyer_id=contact.buyer_id,
                contact_id=contact.id,
                interaction_id=draft.id,
                subject=draft.subject,
                send_mode=mode,
                mailbox_user=mailbox_user,
            )
        return send_result

    def _send_whatsapp_draft(
        self,
        db: Session,
        draft: Interaction,
        *,
        record_activity: bool,
        template_name: str | None,
        template_language: str,
        template_variables: list[str] | None,
        user_id: int | None = None,
    ) -> dict:
        from modules import email_activity

        contact = db.get(Contact, draft.contact_id)
        buyer = db.get(Buyer, contact.buyer_id) if contact else None
        phone = None
        if contact:
            from integrations.voice_client import normalize_e164

            raw = contact.phone or contact.wa_id
            phone = normalize_e164(raw) if raw else None
            if not phone and contact.wa_id:
                digits = "".join(ch for ch in contact.wa_id if ch.isdigit())
                phone = f"+{digits}" if digits else None

        if not contact or not phone:
            if record_activity:
                email_activity.record_event(
                    db,
                    event_type="invalid_recipient",
                    title=f"WhatsApp invalid recipient — {buyer.company_name if buyer else 'lead'}",
                    message="Contact has no phone number — cannot send WhatsApp message.",
                    buyer_id=contact.buyer_id if contact else None,
                    contact_id=draft.contact_id,
                    interaction_id=draft.id,
                    details={"channel": "whatsapp"},
                )
            raise ValueError("Contact has no phone number — cannot send WhatsApp message")

        expires = contact.whatsapp_window_expires_at
        if expires is not None and expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        within_window = bool(expires and expires > datetime.now(timezone.utc))

        components = None
        if template_name and template_variables:
            from modules.whatsapp_templates import build_body_component

            components = build_body_component(template_variables)

        send_result = whatsapp_client.send_approved(
            phone=phone,
            message=draft.content,
            template_name=template_name,
            template_language=template_language,
            template_components=components,
            within_session_window=within_window,
        )

        if send_result.get("status") == "sent":
            draft.status = InteractionStatus.sent
            draft.provider_message_id = send_result.get("provider_message_id")
            draft.template_name = template_name
            draft.wa_status = "sent"
            db.commit()
            db.refresh(draft)

        if record_activity:
            event_type = "sent" if send_result.get("status") == "sent" else "send_failed"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=(
                    f"WhatsApp sent — {buyer.company_name if buyer else 'lead'}"
                    if event_type == "sent"
                    else f"WhatsApp send failed — {buyer.company_name if buyer else 'lead'}"
                ),
                message=send_result.get("message") or "",
                user_id=user_id,
                buyer_id=contact.buyer_id,
                contact_id=contact.id,
                interaction_id=draft.id,
                details={"channel": "whatsapp", "template_name": template_name},
            )
        return send_result

    def reject_draft(self, db: Session, interaction_id: int) -> Interaction:
        draft = db.get(Interaction, interaction_id)
        if not draft:
            raise ValueError("Interaction not found")
        draft.status = InteractionStatus.rejected
        db.commit()
        db.refresh(draft)
        return draft

    def list_drafts(
        self,
        db: Session,
        *,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[Interaction], int]:
        page = max(1, page)
        page_size = min(max(1, page_size), 100)
        base_query = db.query(Interaction).filter(
            Interaction.status == InteractionStatus.draft
        )
        total = base_query.count()
        drafts = (
            base_query.order_by(Interaction.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return drafts, total

    def update_draft_attachments(
        self,
        db: Session,
        interaction_id: int,
        attachments: list[dict],
    ) -> Interaction:
        draft = db.get(Interaction, interaction_id)
        if not draft:
            raise ValueError("Interaction not found")
        if draft.status != InteractionStatus.draft:
            raise ValueError("Can only edit attachments on draft interactions")
        if draft.channel != Channel.email:
            raise ValueError("Attachments are only supported for email drafts")
        draft.attachments = resolve_attachment_list(attachments, draft.attachments)
        db.commit()
        db.refresh(draft)
        return draft

    def create_manual_email_draft(
        self,
        db: Session,
        *,
        buyer_id: int,
        subject: str,
        body: str,
        contact_id: int | None = None,
        attachments: list[dict] | None = None,
    ) -> Interaction:
        from modules import buyers as buyers_module

        buyer = db.get(Buyer, buyer_id)
        if not buyer:
            raise ValueError(f"Buyer {buyer_id} not found")

        subject_clean = (subject or "").strip()
        body_clean = (body or "").strip()
        if not subject_clean:
            raise ValueError("Subject is required")
        if not body_clean:
            raise ValueError("Email body is required")

        contact: Contact | None = None
        if contact_id is not None:
            contact = db.get(Contact, contact_id)
            if not contact or contact.buyer_id != buyer_id:
                raise ValueError("Contact not found for this lead")
            if not (contact.email or "").strip():
                raise ValueError("Selected contact has no email address")
        else:
            contact = buyers_module.primary_contact_with_email(db, buyer_id)
            if not contact:
                raise ValueError(f"No contact with email for {buyer.company_name}")

        draft = Interaction(
            contact_id=contact.id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject_clean,
            content=body_clean,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.human,
            status=InteractionStatus.draft,
            attachments=copy_attachments(resolve_attachment_list(attachments)),
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def generate_draft_from_template(
        self,
        db: Session,
        *,
        buyer_id: int,
        template_id: int,
        extra_attachments: list[dict] | None = None,
    ) -> Interaction:
        from modules import buyers as buyers_module
        from modules.email_templates import get_template, render_template_text

        buyer = db.get(Buyer, buyer_id)
        if not buyer:
            raise ValueError(f"Buyer {buyer_id} not found")

        template = get_template(db, template_id)
        if not template:
            raise ValueError("Email template not found")

        contact = buyers_module.primary_contact_with_email(db, buyer_id)
        if not contact:
            raise ValueError(f"No contact with email for {buyer.company_name}")

        subject = render_template_text(template.subject, buyer=buyer, contact=contact)
        body = render_template_text(template.body, buyer=buyer, contact=contact)
        attachments = merge_attachments(
            resolve_attachment_list(template.attachments),
            resolve_attachment_list(extra_attachments),
        )

        draft = Interaction(
            contact_id=contact.id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject,
            content=body,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
            attachments=copy_attachments(resolve_attachment_list(attachments)),
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def create_bulk_manual_drafts(
        self,
        db: Session,
        *,
        buyer_ids: list[int],
        subject: str,
        body: str,
        attachments: list[dict] | None = None,
        send: bool = True,
        mailbox_user=None,
    ) -> dict:
        import time

        from config import settings
        from modules import buyers as buyers_module, email_activity
        from modules.email_templates import render_template_text

        subject_clean = (subject or "").strip()
        body_clean = (body or "").strip()
        if not subject_clean:
            raise ValueError("Subject is required")
        if not body_clean:
            raise ValueError("Email body is required")

        # Bulk compose always delivers immediately (approval queue removed for email).
        send = True

        created: list[dict] = []
        skipped: list[dict] = []
        sent_count = 0
        failed_count = 0
        is_bulk_batch = send and len(buyer_ids) > 1
        record_each = send and not is_bulk_batch

        if is_bulk_batch:
            email_activity.record_event(
                db,
                event_type="bulk_started",
                title=f"Bulk send started ({len(buyer_ids)} leads)",
                message="Sending personalized manual emails. Per-message updates are summarized when the batch finishes.",
                details={"buyer_ids": buyer_ids, "mode": "manual"},
                mailbox_user=mailbox_user,
            )

        for index, buyer_id in enumerate(buyer_ids):
            buyer = db.get(Buyer, buyer_id)
            if not buyer:
                skipped.append({"buyer_id": buyer_id, "reason": "lead not found"})
                continue
            try:
                contact = buyers_module.primary_contact_with_email(db, buyer_id)
                if not contact:
                    raise ValueError(f"No contact with email for {buyer.company_name}")

                subject_rendered = render_template_text(subject_clean, buyer=buyer, contact=contact)
                body_rendered = render_template_text(body_clean, buyer=buyer, contact=contact)

                draft = Interaction(
                    contact_id=contact.id,
                    channel=Channel.email,
                    direction=Direction.outbound,
                    subject=subject_rendered,
                    content=body_rendered,
                    language=contact.preferred_language or "en",
                    handled_by=HandledBy.human,
                    status=InteractionStatus.draft,
                    attachments=copy_attachments(resolve_attachment_list(attachments)),
                )
                db.add(draft)
                db.commit()
                db.refresh(draft)

                item = {
                    "buyer_id": buyer_id,
                    "company_name": buyer.company_name,
                    "interaction_id": draft.id,
                    "contact_id": draft.contact_id,
                    "sent": False,
                    "send_status": None,
                    "send_message": None,
                }
                if send:
                    _approved, send_result = self.approve_draft(
                        db,
                        draft.id,
                        approved_by="dashboard_user",
                        send=True,
                        record_activity=record_each,
                        send_mode="bulk" if is_bulk_batch else "individual",
                        mailbox_user=mailbox_user,
                    )
                    status = (send_result or {}).get("status")
                    item["sent"] = status == "sent"
                    item["send_status"] = status
                    item["send_message"] = (send_result or {}).get("message")
                    if status == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1
                    if index < len(buyer_ids) - 1 and settings.bulk_email_message_delay_seconds > 0:
                        time.sleep(settings.bulk_email_message_delay_seconds)
                created.append(item)
            except ValueError as exc:
                reason = str(exc)
                skipped.append(
                    {
                        "buyer_id": buyer_id,
                        "company_name": buyer.company_name if buyer else None,
                        "reason": reason,
                    }
                )
                if record_each:
                    event_type = (
                        "skipped_no_email"
                        if "email" in reason.lower()
                        else "send_failed"
                    )
                    email_activity.record_event(
                        db,
                        event_type=event_type,
                        title=f"Skipped — {buyer.company_name if buyer else buyer_id}",
                        message=reason,
                        buyer_id=buyer_id,
                        details={"reason": reason},
                        mailbox_user=mailbox_user,
                    )

        if is_bulk_batch:
            if failed_count > 0 and sent_count > 0:
                event_type = "bulk_partial"
                title = f"Bulk send partial — {sent_count} sent, {failed_count} failed"
            elif failed_count > 0 and sent_count == 0 and len(skipped) == len(buyer_ids):
                event_type = "bulk_partial"
                title = f"Bulk send finished — all {len(skipped)} skipped"
            elif failed_count > 0 and sent_count == 0:
                event_type = "send_failed"
                title = f"Bulk send failed — 0 of {len(buyer_ids)} sent"
            else:
                event_type = "bulk_completed"
                title = f"Bulk send completed — {sent_count} sent"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=title,
                message=(
                    f"{sent_count} sent, {failed_count} failed, {len(skipped)} skipped "
                    f"out of {len(buyer_ids)} selected."
                ),
                details={
                    "sent_count": sent_count,
                    "failed_count": failed_count,
                    "skipped_count": len(skipped),
                    "selected_count": len(buyer_ids),
                    "mode": "manual",
                    "skipped": skipped[:20],
                    "failures": [
                        {
                            "company_name": row.get("company_name"),
                            "send_status": row.get("send_status"),
                            "send_message": row.get("send_message"),
                        }
                        for row in created
                        if not row.get("sent")
                    ][:20],
                },
                mailbox_user=mailbox_user,
            )

        return {
            "created_count": len(created),
            "skipped_count": len(skipped),
            "sent_count": sent_count,
            "failed_count": failed_count,
            "created": created,
            "skipped": skipped,
        }

    def create_bulk_drafts_from_template(
        self,
        db: Session,
        *,
        buyer_ids: list[int],
        template_id: int,
        extra_attachments: list[dict] | None = None,
        send: bool = True,
        mailbox_user=None,
    ) -> dict:
        import time

        from config import settings
        from modules import email_activity

        # Bulk compose always delivers immediately (approval queue removed for email).
        send = True

        created: list[dict] = []
        skipped: list[dict] = []
        sent_count = 0
        failed_count = 0
        # Multi-lead bulk: one start + one summary only (no per-email spam).
        is_bulk_batch = send and len(buyer_ids) > 1
        # Single-lead template send: keep normal per-email activity events.
        record_each = send and not is_bulk_batch

        if is_bulk_batch:
            email_activity.record_event(
                db,
                event_type="bulk_started",
                title=f"Bulk send started ({len(buyer_ids)} leads)",
                message="Sending personalized emails from the selected template. Per-message updates are summarized when the batch finishes.",
                details={"buyer_ids": buyer_ids, "template_id": template_id},
                mailbox_user=mailbox_user,
            )

        for index, buyer_id in enumerate(buyer_ids):
            buyer = db.get(Buyer, buyer_id)
            if not buyer:
                skipped.append({"buyer_id": buyer_id, "reason": "lead not found"})
                continue
            try:
                draft = self.generate_draft_from_template(
                    db,
                    buyer_id=buyer_id,
                    template_id=template_id,
                    extra_attachments=extra_attachments,
                )
                item = {
                    "buyer_id": buyer_id,
                    "company_name": buyer.company_name,
                    "interaction_id": draft.id,
                    "contact_id": draft.contact_id,
                    "sent": False,
                    "send_status": None,
                    "send_message": None,
                }
                if send:
                    _approved, send_result = self.approve_draft(
                        db,
                        draft.id,
                        approved_by="dashboard_user",
                        send=True,
                        record_activity=record_each,
                        send_mode="bulk" if is_bulk_batch else "individual",
                        mailbox_user=mailbox_user,
                    )
                    status = (send_result or {}).get("status")
                    item["sent"] = status == "sent"
                    item["send_status"] = status
                    item["send_message"] = (send_result or {}).get("message")
                    if status == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1
                    if index < len(buyer_ids) - 1 and settings.bulk_email_message_delay_seconds > 0:
                        time.sleep(settings.bulk_email_message_delay_seconds)
                created.append(item)
            except ValueError as exc:
                reason = str(exc)
                skipped.append(
                    {
                        "buyer_id": buyer_id,
                        "company_name": buyer.company_name,
                        "reason": reason,
                    }
                )
                if record_each:
                    event_type = (
                        "skipped_no_email"
                        if "email" in reason.lower()
                        else "send_failed"
                    )
                    email_activity.record_event(
                        db,
                        event_type=event_type,
                        title=f"Skipped — {buyer.company_name}",
                        message=reason,
                        buyer_id=buyer_id,
                        details={"reason": reason},
                        mailbox_user=mailbox_user,
                    )

        if is_bulk_batch:
            if failed_count > 0 and sent_count > 0:
                event_type = "bulk_partial"
                title = f"Bulk send partial — {sent_count} sent, {failed_count} failed"
            elif failed_count > 0 and sent_count == 0 and len(skipped) == len(buyer_ids):
                event_type = "bulk_partial"
                title = f"Bulk send finished — all {len(skipped)} skipped"
            elif failed_count > 0 and sent_count == 0:
                event_type = "send_failed"
                title = f"Bulk send failed — 0 of {len(buyer_ids)} sent"
            else:
                event_type = "bulk_completed"
                title = f"Bulk send completed — {sent_count} sent"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=title,
                message=(
                    f"{sent_count} sent, {failed_count} failed, {len(skipped)} skipped "
                    f"out of {len(buyer_ids)} selected."
                ),
                details={
                    "sent_count": sent_count,
                    "failed_count": failed_count,
                    "skipped_count": len(skipped),
                    "selected_count": len(buyer_ids),
                    "template_id": template_id,
                    "skipped": skipped[:20],
                    "failures": [
                        {
                            "company_name": row.get("company_name"),
                            "send_status": row.get("send_status"),
                            "send_message": row.get("send_message"),
                        }
                        for row in created
                        if not row.get("sent")
                    ][:20],
                },
                mailbox_user=mailbox_user,
            )

        return {
            "created_count": len(created),
            "skipped_count": len(skipped),
            "sent_count": sent_count,
            "failed_count": failed_count,
            "created": created,
            "skipped": skipped,
        }

    def bulk_approve_drafts(
        self,
        db: Session,
        interaction_ids: list[int],
        *,
        approved_by: str = "sales_rep",
        send: bool = True,
        message_delay_seconds: float | None = None,
        mailbox_user=None,
    ) -> dict:
        import time

        from config import settings

        delay = (
            message_delay_seconds
            if message_delay_seconds is not None
            else settings.bulk_email_message_delay_seconds
        )

        results: list[dict] = []
        sent_count = 0
        failed_count = 0
        is_bulk_batch = send and len(interaction_ids) > 1

        if is_bulk_batch:
            from modules import email_activity

            email_activity.record_event(
                db,
                event_type="bulk_started",
                title=f"Bulk send started ({len(interaction_ids)} emails)",
                message="Sending selected emails. Per-message updates are summarized when the batch finishes.",
                details={"interaction_ids": interaction_ids},
                mailbox_user=mailbox_user,
            )

        for index, interaction_id in enumerate(interaction_ids):
            if index > 0 and send and delay > 0:
                time.sleep(delay)
            try:
                draft, send_result = self.approve_draft(
                    db,
                    interaction_id,
                    approved_by=approved_by,
                    send=send,
                    record_activity=not is_bulk_batch,
                    send_mode="bulk" if is_bulk_batch else "individual",
                    mailbox_user=mailbox_user,
                )
                sent = draft.status == InteractionStatus.sent
                if sent:
                    sent_count += 1
                elif send:
                    failed_count += 1
                results.append(
                    {
                        "interaction_id": interaction_id,
                        "status": draft.status.value,
                        "sent": sent,
                        "send_status": (send_result or {}).get("status"),
                        "send_message": (send_result or {}).get("message"),
                    }
                )
            except ValueError as exc:
                failed_count += 1
                results.append(
                    {
                        "interaction_id": interaction_id,
                        "status": "error",
                        "sent": False,
                        "send_message": str(exc),
                    }
                )

        if is_bulk_batch:
            from modules import email_activity

            if failed_count > 0 and sent_count > 0:
                event_type = "bulk_partial"
                title = f"Bulk send partial — {sent_count} sent, {failed_count} failed"
            elif failed_count > 0 and sent_count == 0:
                event_type = "send_failed"
                title = f"Bulk send failed — 0 of {len(interaction_ids)} sent"
            else:
                event_type = "bulk_completed"
                title = f"Bulk send completed — {sent_count} sent"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=title,
                message=(
                    f"{sent_count} sent, {failed_count} failed "
                    f"out of {len(interaction_ids)} selected."
                ),
                details={
                    "sent_count": sent_count,
                    "failed_count": failed_count,
                    "selected_count": len(interaction_ids),
                },
                mailbox_user=mailbox_user,
            )

        return {
            "processed": len(results),
            "sent_count": sent_count,
            "failed_count": failed_count,
            "results": results,
        }

    def interaction_to_dict(self, db: Session, interaction: Interaction) -> dict:
        contact = db.get(Contact, interaction.contact_id)
        buyer = db.get(Buyer, contact.buyer_id) if contact else None
        return {
            "id": interaction.id,
            "contact_id": interaction.contact_id,
            "channel": interaction.channel.value,
            "direction": interaction.direction.value,
            "subject": interaction.subject,
            "content": interaction.content,
            "status": interaction.status.value,
            "created_at": interaction.created_at,
            "company_name": buyer.company_name if buyer else None,
            "contact_name": contact.full_name if contact else None,
            "contact_email": contact.email if contact else None,
            "contact_phone": contact.phone if contact else None,
            "template_name": interaction.template_name,
            "wa_status": interaction.wa_status,
            "attachments": public_attachments(interaction.attachments),
        }

    def list_interactions(self, db: Session, limit: int = 100) -> list[Interaction]:
        return (
            db.query(Interaction)
            .order_by(Interaction.created_at.desc())
            .limit(limit)
            .all()
        )


_comms = CommsGenerator()


def get_comms() -> CommsGenerator:
    return _comms
