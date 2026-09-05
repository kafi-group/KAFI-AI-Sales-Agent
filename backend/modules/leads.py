import re
import time

from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from db.models import AppUser, AppUserRole, Buyer, Contact, LeadScore, LeadScoreLabel, MarketRole
from modules.cache import MISS, cache
from modules import buyers as buyers_module
from modules.call_timing import get_call_recommendation
from modules.client_history import resolve_current_remarks
from modules.countries import list_countries
from modules.orchestrator import Orchestrator
from modules.product_categories import (
    OTHER_CATEGORY_LABEL,
    PRODUCT_CATEGORIES,
    distinct_category_labels,
    keywords_for_category,
)
from modules.research import BuyerProfile, ResearchModule
from modules.incomplete_archives import INCOMPLETE_ARCHIVES_SOURCE

_orchestrator = Orchestrator()
_research = ResearchModule()

TARGETED_POOL_SOURCES = frozenset(
    {
        "hyperstore_targeted",
        "targeted_distributor",
        "targeted_client",
        "khalid_focused_sales",
    }
)

ARCHIVES_POOL_SOURCES = frozenset({INCOMPLETE_ARCHIVES_SOURCE, "old_clients"})
TARGETED_POOL_EXCLUDE = ",".join(
    ["old_clients", INCOMPLETE_ARCHIVES_SOURCE, *sorted(TARGETED_POOL_SOURCES)]
)
# Buyers imported via Discover Leads (web search, enrichment, CSV in discover tab).
DISCOVER_LEAD_SOURCES = frozenset(
    {"discovery", "web_search", "website_links", "manual", "csv"}
)
# New search lead pool — AI/scrape only (Discover Leads tab), not uploads or manual entry.
SCRAPED_LEAD_SOURCES = frozenset({"discovery", "web_search", "website_links"})


def is_new_search_lead_source(source: str | None) -> bool:
    key = (source or "").strip().lower()
    if not key or key in ARCHIVES_POOL_SOURCES or key in TARGETED_POOL_SOURCES:
        return False
    if key in {"manual", "manual_dial", "csv"}:
        return False
    return key in SCRAPED_LEAD_SOURCES


def is_targeted_pool_source(source: str | None) -> bool:
    return (source or "").strip().lower() in TARGETED_POOL_SOURCES

_SCORE_ORDER = {"AAAA": 0, "AAA": 1, "AA": 2, "A": 3}
_SORT_FIELDS = {
    "company_name",
    "country",
    "industry",
    "source",
    "assigned_to",
    "latest_score",
    "market_role",
    "created_at",
    "scored_at",
}


def _assignee_label(user: AppUser | None) -> str:
    if not user:
        return "unassigned"
    return (user.full_name or user.username or "unassigned").strip() or "unassigned"


def suggest_company_names(
    db: Session,
    *,
    q: str,
    limit: int = 12,
    assigned_to_user_id: int | None = None,
) -> list[dict]:
    """Typeahead from the master buyers table — helps avoid duplicate company names."""
    from sqlalchemy import case

    query = (q or "").strip()
    if len(query) < 1:
        return []
    limit = max(1, min(int(limit or 12), 25))
    # Escape LIKE wildcards in user input.
    safe = (
        query.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )
    pattern = f"%{safe}%"
    starts = f"{safe}%"
    q_builder = (
        db.query(Buyer)
        .filter(Buyer.company_name.isnot(None))
        .filter(Buyer.company_name != "")
        .filter(Buyer.company_name.ilike(pattern, escape="\\"))
    )
    if assigned_to_user_id is not None:
        q_builder = q_builder.filter(Buyer.assigned_to_user_id == assigned_to_user_id)
    rows = (
        q_builder.order_by(
            # Prefer names that start with the typed text, then alphabetical.
            case((Buyer.company_name.ilike(starts, escape="\\"), 0), else_=1),
            sa_func.lower(Buyer.company_name).asc(),
            Buyer.id.asc(),
        )
        .limit(limit)
        .all()
    )
    return [
        {
            "id": b.id,
            "company_name": b.company_name,
            "country": b.country,
        }
        for b in rows
    ]


def resolve_assignee_user(db: Session, user_id: int | None) -> AppUser | None:
    if user_id is None:
        return None
    user = db.get(AppUser, user_id)
    if not user or not user.is_active:
        raise ValueError("Assignee not found or inactive")
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    if role != AppUserRole.user.value:
        raise ValueError("Leads can only be assigned to sales users")
    return user


def apply_buyer_assignee(
    db: Session,
    buyer: Buyer,
    user_id: int | None,
    *,
    assigned_by_user_id: int | None = None,
) -> None:
    """Set assigned_to_user_id and sync display label.

    assigned_by_user_id: admin who sent the lead (required for \"Leads Sent To\").
    Leave None for self-imports / sales-owned rows so they stay off that admin nav.
    """
    if user_id is None:
        buyer.assigned_to_user_id = None
        buyer.assigned_to = "unassigned"
        buyer.assigned_by_user_id = None
        return
    user = resolve_assignee_user(db, user_id)
    assert user is not None
    buyer.assigned_to_user_id = user.id
    buyer.assigned_to = _assignee_label(user)
    buyer.assigned_by_user_id = assigned_by_user_id


def user_can_access_buyer(db: Session, *, user: AppUser, buyer_id: int) -> bool:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    if role == AppUserRole.admin.value:
        return True
    buyer = buyers_module.get_buyer(db, buyer_id)
    if not buyer:
        return False
    # All active sales users can view and work leads across the shared team tables.
    return True


def clear_assignments_for_user(db: Session, user_id: int) -> None:
    buyers = db.query(Buyer).filter(Buyer.assigned_to_user_id == user_id).all()
    for buyer in buyers:
        buyer.assigned_to_user_id = None
        buyer.assigned_to = "unassigned"
        buyer.assigned_by_user_id = None


def unassign_spreadsheet_imports(db: Session) -> dict[str, int]:
    """Move auto-imported spreadsheet leads back to the shared pool.

    Older builds auto-assigned CSV / Old clients imports to the importing sales
    user, which wrongly filled "Leads Sent To {username}". Only an admin
    assignment should live there — this clears assignee on import sources.
    """
    import time

    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    id_rows = (
        db.query(Buyer.id)
        .filter(
            sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(
                ["csv", "old_clients"]
            ),
            Buyer.assigned_to_user_id.isnot(None),
        )
        .all()
    )
    ids = [int(row[0]) for row in id_rows]
    updated = 0
    # Tiny chunks — Supabase statement_timeout + lock waits kill bigger UPDATEs.
    CHUNK = 25
    for start in range(0, len(ids), CHUNK):
        chunk = ids[start : start + CHUNK]
        for attempt in range(4):
            try:
                db.execute(text("SET LOCAL statement_timeout = '60s'"))
                updated += (
                    db.query(Buyer)
                    .filter(Buyer.id.in_(chunk))
                    .update(
                        {
                            Buyer.assigned_to_user_id: None,
                            Buyer.assigned_to: "unassigned",
                        },
                        synchronize_session=False,
                    )
                    or 0
                )
                db.commit()
                break
            except OperationalError:
                db.rollback()
                if attempt >= 3:
                    raise
                time.sleep(1.5 * (attempt + 1))

    if updated:
        invalidate_lead_table_filters_cache()
        invalidate_section_counts_cache()
    return {"unassigned_count": int(updated)}


def research_buyer(db: Session, buyer_id: int, *, force_refresh: bool = False) -> BuyerProfile:
    return _research.research_buyer(db, buyer_id, force_refresh=force_refresh)


def list_buyers_with_scores(
    db: Session,
    *,
    page: int = 1,
    page_size: int = 20,
    exclude_source: str | None = "old_clients",
) -> dict[str, object]:
    """Return buyers enriched with latest AAA/AA/A company grade (paginated).

    Discover Leads excludes old_clients by default — those belong only in the
    Old clients table, not in new-discovery surfaces.
    """
    page = max(1, page)
    page_size = min(max(1, page_size), 100)

    buyer_query = db.query(Buyer)
    excluded = {
        part.strip().lower()
        for part in (exclude_source or "").split(",")
        if part.strip()
    }
    if excluded:
        buyer_query = buyer_query.filter(
            ~sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(excluded)
        )

    total = buyer_query.with_entities(sa_func.count(Buyer.id)).scalar() or 0
    total_pages = max(1, (total + page_size - 1) // page_size) if total else 1
    if page > total_pages:
        page = total_pages

    buyers = (
        buyer_query.order_by(Buyer.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    score_map: dict[int, LeadScore] = {}
    if buyers:
        buyer_ids = [b.id for b in buyers]
        latest_sub = (
            db.query(
                LeadScore.buyer_id,
                sa_func.max(LeadScore.scored_at).label("max_scored_at"),
            )
            .filter(LeadScore.buyer_id.in_(buyer_ids))
            .group_by(LeadScore.buyer_id)
            .subquery()
        )
        score_rows = (
            db.query(LeadScore)
            .join(
                latest_sub,
                (LeadScore.buyer_id == latest_sub.c.buyer_id)
                & (LeadScore.scored_at == latest_sub.c.max_scored_at),
            )
            .all()
        )
        score_map = {s.buyer_id: s for s in score_rows}

    results: list[dict] = []
    for buyer in buyers:
        score = score_map.get(buyer.id)
        results.append(
            {
                "id": buyer.id,
                "company_name": buyer.company_name,
                "website_url": buyer.website_url,
                "country": buyer.country,
                "industry": buyer.industry,
                "source": buyer.source,
                "market_role": buyer.market_role.value if buyer.market_role else "unknown",
                "market_role_reasoning": buyer.market_role_reasoning,
                "market_role_confidence": (
                    float(buyer.market_role_confidence)
                    if buyer.market_role_confidence is not None
                    else None
                ),
                "producer_tier": buyer.producer_tier.value if buyer.producer_tier else None,
                "producer_conversion_pct": (
                    float(buyer.producer_conversion_pct)
                    if buyer.producer_conversion_pct is not None
                    else None
                ),
                "producer_tier_reasoning": buyer.producer_tier_reasoning,
                "created_at": buyer.created_at,
                "latest_score": score.score.value if score else None,
                "score_reasoning": score.reasoning if score else None,
            }
        )

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "rows": results,
    }


def get_saved_buyer_profile(db: Session, buyer_id: int) -> BuyerProfile | None:
    return _research.get_saved_profile(db, buyer_id)


def profile_to_read_dict(profile: BuyerProfile) -> dict:
    return {
        "buyer_id": profile.buyer_id,
        "company_name": profile.company_name,
        "website_url": profile.website_url,
        "country": profile.country,
        "industry": profile.industry,
        "website_summary": profile.website_summary,
        "social_summary": profile.social_summary,
        "relationship_context": profile.relationship_context,
        "signals": profile.signals,
        "matched_categories": profile.matched_categories,
        "matched_products": profile.matched_products,
        "product_fit_score": profile.product_fit_score,
        "market_role": profile.market_role,
        "market_role_reasoning": profile.market_role_reasoning,
        "market_role_confidence": profile.market_role_confidence,
        "producer_tier": profile.producer_tier,
        "producer_conversion_pct": profile.producer_conversion_pct,
        "producer_tier_reasoning": profile.producer_tier_reasoning,
        "researched_at": profile.researched_at,
    }


def score_buyer(db: Session, buyer_id: int) -> LeadScore:
    profile = _research.research_buyer(db, buyer_id)
    return _orchestrator.scoring.score(db, profile)


def onboard_buyer(db: Session, buyer_id: int) -> dict:
    return _orchestrator.handle_new_buyer(db, buyer_id)


def get_latest_score(db: Session, buyer_id: int) -> LeadScore | None:
    return (
        db.query(LeadScore)
        .filter(LeadScore.buyer_id == buyer_id)
        .order_by(LeadScore.scored_at.desc())
        .first()
    )


def list_quotation_eligible_leads(db: Session) -> list[dict]:
    """AAA/AA graded companies with a real contact email (required for outreach)."""
    from db.models import LeadScoreLabel, MarketRole, ProducerTier
    from modules import buyers as buyers_module

    eligible: list[dict] = []
    for buyer in buyers_module.list_buyers(db):
        if buyer.market_role == MarketRole.producer:
            if buyer.producer_tier != ProducerTier.weak:
                continue
            if buyer.producer_conversion_pct is None or float(buyer.producer_conversion_pct) < 40:
                continue
        score = get_latest_score(db, buyer.id)
        if not score or score.score not in (LeadScoreLabel.AAAA, LeadScoreLabel.AAA, LeadScoreLabel.AA):
            continue

        contact = buyers_module.primary_contact_with_email(db, buyer.id)
        if not contact:
            continue

        eligible.append(
            {
                "id": buyer.id,
                "company_name": buyer.company_name,
                "country": buyer.country,
                "industry": buyer.industry,
                "website_url": buyer.website_url,
                "source": buyer.source,
                "created_at": buyer.created_at,
                "latest_score": score.score.value,
                "score_reasoning": score.reasoning,
                "contact_email": contact.email,
                "contact_name": contact.full_name,
            }
        )
    return eligible


def _unique_sorted_labels(values: list[str | None]) -> list[str]:
    """Case-insensitive unique labels, preferring the first-seen casing."""
    seen: dict[str, str] = {}
    for raw in values:
        if not raw:
            continue
        label = raw.strip()
        if not label or label == "-":
            continue
        key = label.lower()
        if key not in seen:
            seen[key] = label
    return sorted(seen.values(), key=str.lower)


# Filter-option queries (distinct industries/products/cities/etc.) are the
# same for every request against a given source for a while — computing them
# fresh on every filter-panel load is wasted DB work. Cache briefly and
# invalidate on writes that could change the option set (import/delete).
_FILTERS_CACHE_TTL_SECONDS = 45.0
_filters_cache: dict[str, tuple[float, dict[str, list[str]]]] = {}


def invalidate_lead_table_filters_cache() -> None:
    _filters_cache.clear()


def get_lead_table_filters(
    db: Session, *, source: str | None = None
) -> dict[str, list[str]]:
    cache_key = (source or "").strip().lower()
    cached = _filters_cache.get(cache_key)
    now = time.monotonic()
    if cached and (now - cached[0]) < _FILTERS_CACHE_TTL_SECONDS:
        return cached[1]

    result = _compute_lead_table_filters(db, source=source)
    _filters_cache[cache_key] = (now, result)
    return result


def _compute_lead_table_filters(
    db: Session, *, source: str | None = None
) -> dict[str, list[str]]:
    """Distinct filter values via SQL — do not load every buyer row."""
    from sqlalchemy import distinct

    def _distinct_labels(column, *, scoped: bool) -> list[str]:
        query = db.query(distinct(column)).filter(column.isnot(None), column != "")
        if scoped and source:
            source_key = source.strip().lower()
            query = query.filter(sa_func.lower(Buyer.source) == source_key)
        values = [row[0] for row in query.all()]
        return _unique_sorted_labels(values)

    def _company_grading_labels(*, scoped: bool) -> list[str]:
        query = db.query(distinct(Buyer.company_grading)).filter(
            Buyer.company_grading.isnot(None), Buyer.company_grading != ""
        )
        if scoped and source:
            source_key = source.strip().lower()
            query = query.filter(sa_func.lower(Buyer.source) == source_key)
        values = [row[0] for row in query.all()]
        standard_tiers = ["AAAA", "AAA", "AA", "A"]
        tier_set = {t.lower() for t in standard_tiers}
        other_labels = []
        for val in values:
            if val and val.strip() and val.strip().lower() not in tier_set:
                other_labels.append(val.strip())
        return standard_tiers + _unique_sorted_labels(other_labels)

    def _product_category_labels() -> list[str]:
        query = db.query(distinct(Buyer.product_interest)).filter(
            Buyer.product_interest.isnot(None), Buyer.product_interest != ""
        )
        if source:
            source_key = source.strip().lower()
            query = query.filter(sa_func.lower(Buyer.source) == source_key)
        raw_values = [row[0] for row in query.all()]
        return distinct_category_labels(raw_values)

    return {
        "countries": [country["name"] for country in list_countries()],
        "industries": _distinct_labels(Buyer.industry, scoped=True),
        "sources": _distinct_labels(Buyer.source, scoped=False),
        "scores": ["AAAA", "AAA", "AA", "A", "Unscored"],
        "market_roles": ["consumer", "producer", "hybrid", "unknown"],
        "company_gradings": _company_grading_labels(scoped=True),
        "products": _product_category_labels(),
        "cities": _distinct_labels(Buyer.city, scoped=True),
    }


def _regex_or_pattern(keywords: list[str]) -> str:
    """Postgres regex matching any keyword at a word start (\\m ~ \\b at start)."""
    return r"\m(" + "|".join(re.escape(keyword) for keyword in keywords) + ")"


def _apply_product_category_filter(buyer_query, product_interest: str):
    """Match one or multiple canonical product categories against product_interest."""
    from sqlalchemy import and_ as sa_and, or_

    items = [p.strip() for p in product_interest.split(",") if p.strip()]
    if not items:
        return buyer_query

    conditions = []
    for label in items:
        keywords = keywords_for_category(label)
        if keywords:
            conditions.append(Buyer.product_interest.op("~*")(_regex_or_pattern(keywords)))
        elif label.lower() == OTHER_CATEGORY_LABEL.lower():
            all_keywords = [kw for kws in PRODUCT_CATEGORIES.values() for kw in kws]
            conditions.append(
                sa_and(
                    sa_func.coalesce(Buyer.product_interest, "") != "",
                    ~Buyer.product_interest.op("~*")(_regex_or_pattern(all_keywords)),
                )
            )
        else:
            conditions.append(
                sa_func.lower(sa_func.coalesce(Buyer.product_interest, "")) == label.lower()
            )

    if conditions:
        return buyer_query.filter(or_(*conditions))
    return buyer_query


def _apply_lead_table_scope(
    buyer_query,
    *,
    source: str | None,
    exclude_source: str | None,
    assigned_to_user_id: int | None,
    unassigned_only: bool,
    pool_for_user_id: int | None = None,
    admin_sent_only: bool = False,
    master_type: str | None = None,
):
    from sqlalchemy import or_

    if master_type:
        if master_type.strip().lower() == "fmcg":
            buyer_query = buyer_query.filter(
                or_(
                    sa_func.lower(Buyer.master_type) == "fmcg",
                    Buyer.master_type.is_(None),
                    Buyer.master_type == "",
                )
            )
        else:
            buyer_query = buyer_query.filter(
                sa_func.lower(Buyer.master_type) == master_type.strip().lower()
            )

    if assigned_to_user_id is not None:
        buyer_query = buyer_query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)
        if admin_sent_only:
            # Admin "Leads Sent To {user}" — exclude that user's self-imports.
            buyer_query = buyer_query.filter(Buyer.assigned_by_user_id.isnot(None))
    elif pool_for_user_id is not None:
        # Legacy: shared unassigned pool + leads assigned to this user.
        buyer_query = buyer_query.filter(
            or_(
                Buyer.assigned_to_user_id.is_(None),
                Buyer.assigned_to_user_id == pool_for_user_id,
            )
        )
    elif unassigned_only:
        buyer_query = buyer_query.filter(Buyer.assigned_to_user_id.is_(None))

    if source:
        buyer_query = buyer_query.filter(
            sa_func.lower(Buyer.source) == source.strip().lower()
        )

    if exclude_source:
        excluded = {
            part.strip().lower()
            for part in exclude_source.split(",")
            if part.strip()
        }
        if excluded:
            buyer_query = buyer_query.filter(
                ~sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(excluded)
            )
    return buyer_query


def _apply_intake_method_scope(buyer_query, *, intake_method: str | None):
    from sqlalchemy import or_

    if not intake_method:
        return buyer_query
    normalized = intake_method.strip().lower()
    if normalized == "upload":
        return buyer_query.filter(
            or_(
                sa_func.lower(sa_func.coalesce(Buyer.intake_method, "")) == "upload",
                Buyer.intake_method.is_(None),
                Buyer.intake_method == "",
            )
        )
    if normalized == "discover":
        return buyer_query.filter(
            sa_func.lower(sa_func.coalesce(Buyer.intake_method, "")) == "discover"
        )
    return buyer_query


def _apply_new_search_lead_scope(buyer_query):
    allowed = [source.lower() for source in SCRAPED_LEAD_SOURCES]
    return buyer_query.filter(
        sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(allowed)
    )


def _apply_call_outcome_scope(
    db: Session,
    buyer_query,
    *,
    call_outcome: str | None,
    include_placed_outcomes: bool,
    in_interested_clients: bool = False,
):
    if in_interested_clients:
        return buyer_query.filter(Buyer.interested_clients_list_at.isnot(None)), set()

    if call_outcome:
        from modules.calls import buyer_ids_with_latest_call_outcome

        scoped_buyer_ids = {
            row[0] for row in buyer_query.with_entities(Buyer.id).all()
        }
        if not scoped_buyer_ids:
            return buyer_query.filter(Buyer.id == -1), set()

        matched_buyer_ids = buyer_ids_with_latest_call_outcome(
            db, call_outcome, buyer_ids=scoped_buyer_ids
        )
        if not matched_buyer_ids:
            return buyer_query.filter(Buyer.id == -1), set()
        return buyer_query.filter(Buyer.id.in_(matched_buyer_ids)), matched_buyer_ids

    if not include_placed_outcomes:
        from modules.calls import buyer_ids_with_placed_call_outcome

        scoped_buyer_ids = {
            row[0] for row in buyer_query.with_entities(Buyer.id).all()
        }
        if not scoped_buyer_ids:
            return buyer_query.filter(Buyer.id == -1), set()

        placed_buyer_ids = buyer_ids_with_placed_call_outcome(
            db, buyer_ids=scoped_buyer_ids
        )
        listed = {
            row[0]
            for row in db.query(Buyer.id)
            .filter(
                Buyer.id.in_(scoped_buyer_ids),
                Buyer.interested_clients_list_at.isnot(None),
            )
            .all()
        }
        exclude_ids = placed_buyer_ids | listed
        if exclude_ids:
            buyer_query = buyer_query.filter(~Buyer.id.in_(exclude_ids))
            scoped_buyer_ids -= exclude_ids
        return buyer_query, scoped_buyer_ids

    return buyer_query, set()


def _hydrate_lead_table_rows(
    db: Session, buyers: list[Buyer]
) -> list[dict[str, object]]:
    buyer_ids = [buyer.id for buyer in buyers]
    if not buyer_ids:
        return []

    score_by_buyer: dict[int, LeadScore] = {}
    ranked_score_ids = (
        db.query(
            LeadScore.id,
            sa_func.row_number()
            .over(partition_by=LeadScore.buyer_id, order_by=LeadScore.scored_at.desc())
            .label("rn"),
        )
        .filter(LeadScore.buyer_id.in_(buyer_ids))
        .subquery()
    )
    latest_score_rows = (
        db.query(LeadScore)
        .join(ranked_score_ids, LeadScore.id == ranked_score_ids.c.id)
        .filter(ranked_score_ids.c.rn == 1)
        .all()
    )
    for record in latest_score_rows:
        score_by_buyer[record.buyer_id] = record

    contact_by_buyer: dict[int, Contact] = {}
    all_contacts = (
        db.query(Contact)
        .filter(Contact.buyer_id.in_(buyer_ids))
        .order_by(Contact.buyer_id.asc(), Contact.id.asc())
        .all()
    )
    for contact in all_contacts:
        if contact.buyer_id not in contact_by_buyer:
            contact_by_buyer[contact.buyer_id] = contact
        if contact.email and contact_by_buyer[contact.buyer_id].email is None:
            contact_by_buyer[contact.buyer_id] = contact

    from modules.calls import latest_call_notes_by_buyer

    call_notes_by_buyer = latest_call_notes_by_buyer(db, buyer_ids=set(buyer_ids))

    rows: list[dict[str, object]] = []
    for buyer in buyers:
        latest = score_by_buyer.get(buyer.id)
        latest_score = latest.score.value if latest else None
        contact = contact_by_buyer.get(buyer.id)
        call_timing = get_call_recommendation(buyer.country)
        rows.append(
            {
                "id": buyer.id,
                "company_name": buyer.company_name,
                "country": buyer.country,
                "call_recommended": call_timing["call_recommended"],
                "call_local_time": call_timing["call_local_time"],
                "call_timezone": call_timing["call_timezone"],
                "call_reason": call_timing["call_reason"],
                "industry": buyer.industry,
                "website_url": buyer.website_url,
                "linkedin_company_url": buyer.linkedin_company_url,
                "facebook_company_url": buyer.facebook_company_url,
                "instagram_company_url": buyer.instagram_company_url,
                "source": buyer.source,
                "legacy_serial_no": buyer.legacy_serial_no,
                "company_grading": buyer.company_grading,
                "product_interest": buyer.product_interest,
                "city": buyer.city,
                "address": buyer.address,
                "remarks": resolve_current_remarks(buyer) or buyer.remarks,
                "remarks_03": buyer.remarks_03,
                "remarks_04": buyer.remarks_04,
                "remarks_history": buyer.remarks_history or [],
                "call_remarks": call_notes_by_buyer.get(buyer.id),
                "assigned_to": buyer.assigned_to or "unassigned",
                "assigned_to_user_id": buyer.assigned_to_user_id,
                "follow_up_at": buyer.follow_up_at,
                "created_at": buyer.created_at,
                "latest_score": latest_score,
                "score_reasoning": latest.reasoning if latest else None,
                "scored_at": latest.scored_at if latest else None,
                "contact_id": contact.id if contact else None,
                "contact_name": contact.full_name if contact else None,
                "contact_email": contact.email if contact else None,
                "contact_phone": contact.phone if contact else None,
                "contact_designation": contact.designation if contact else None,
                "contact_secondary_mobile": contact.secondary_mobile if contact else None,
                "contact_primary_phone": contact.primary_phone if contact else None,
                "contact_secondary_phone": contact.secondary_phone if contact else None,
                "contact_secondary_email": contact.secondary_email if contact else None,
                "market_role": buyer.market_role.value if buyer.market_role else "unknown",
                "market_role_reasoning": buyer.market_role_reasoning,
                "producer_tier": buyer.producer_tier.value if buyer.producer_tier else None,
                "producer_conversion_pct": (
                    float(buyer.producer_conversion_pct)
                    if buyer.producer_conversion_pct is not None
                    else None
                ),
                "producer_tier_reasoning": buyer.producer_tier_reasoning,
            }
        )
    return rows


def _is_blank_token(token: str | None) -> bool:
    if not token:
        return True
    t = token.strip().lower()
    return t in {"(blanks)", "(blank)", "__blank__", "blanks", "blank", ""}


def _apply_column_field_filter(db: Session, buyer_query, field: str, values_str: str | None):
    if not values_str:
        return buyer_query
    from sqlalchemy import or_

    items = [v.strip() for v in values_str.split(",") if v.strip()]
    if not items:
        return buyer_query

    has_blank = any(_is_blank_token(it) for it in items)
    non_blank_items = [it.lower() for it in items if not _is_blank_token(it)]

    if field in {"excel_file_grading", "company_grading"}:
        conds = []
        if has_blank:
            conds.append(or_(Buyer.company_grading.is_(None), Buyer.company_grading == "", Buyer.company_grading == "—", Buyer.company_grading == "-"))
        if non_blank_items:
            conds.append(sa_func.lower(sa_func.coalesce(Buyer.company_grading, "")).in_(non_blank_items))
        if conds:
            buyer_query = buyer_query.filter(or_(*conds))

    elif field in {"business_type", "industry"}:
        conds = []
        if has_blank:
            conds.append(or_(Buyer.industry.is_(None), Buyer.industry == "", Buyer.industry == "—", Buyer.industry == "-"))
        if non_blank_items:
            conds.append(sa_func.lower(sa_func.coalesce(Buyer.industry, "")).in_(non_blank_items))
        if conds:
            buyer_query = buyer_query.filter(or_(*conds))

    elif field == "city":
        conds = []
        if has_blank:
            conds.append(or_(Buyer.city.is_(None), Buyer.city == "", Buyer.city == "—", Buyer.city == "-"))
        if non_blank_items:
            conds.append(sa_func.lower(sa_func.coalesce(Buyer.city, "")).in_(non_blank_items))
        if conds:
            buyer_query = buyer_query.filter(or_(*conds))

    elif field == "website":
        conds = []
        if has_blank:
            conds.append(or_(Buyer.website_url.is_(None), Buyer.website_url == "", Buyer.website_url == "—", Buyer.website_url == "-"))
        if non_blank_items:
            conds.append(sa_func.lower(sa_func.coalesce(Buyer.website_url, "")).in_(non_blank_items))
        if conds:
            buyer_query = buyer_query.filter(or_(*conds))

    elif field == "address":
        conds = []
        if has_blank:
            conds.append(or_(Buyer.address.is_(None), Buyer.address == "", Buyer.address == "—", Buyer.address == "-"))
        if non_blank_items:
            conds.append(sa_func.lower(sa_func.coalesce(Buyer.address, "")).in_(non_blank_items))
        if conds:
            buyer_query = buyer_query.filter(or_(*conds))

    elif field == "remarks":
        conds = []
        if has_blank:
            conds.append(or_(Buyer.remarks.is_(None), Buyer.remarks == "", Buyer.remarks == "—", Buyer.remarks == "-"))
        if non_blank_items:
            conds.append(sa_func.lower(sa_func.coalesce(Buyer.remarks, "")).in_(non_blank_items))
        if conds:
            buyer_query = buyer_query.filter(or_(*conds))

    elif field in {"designation", "contact_person", "primary_mobile", "secondary_mobile", "phone", "secondary_phone", "email", "secondary_email"}:
        col_map = {
            "designation": Contact.designation,
            "contact_person": Contact.full_name,
            "primary_mobile": Contact.phone,
            "secondary_mobile": Contact.secondary_mobile,
            "phone": Contact.primary_phone,
            "secondary_phone": Contact.secondary_phone,
            "email": Contact.email,
            "secondary_email": Contact.secondary_email,
        }
        contact_col = col_map[field]
        conds = []
        if has_blank:
            conds.append(or_(contact_col.is_(None), contact_col == "", contact_col == "—", contact_col == "-"))
        if non_blank_items:
            conds.append(sa_func.lower(sa_func.coalesce(contact_col, "")).in_(non_blank_items))

        if conds:
            contact_subq = db.query(Contact.buyer_id).filter(or_(*conds)).distinct().subquery()
            if has_blank:
                no_contact_subq = db.query(Contact.buyer_id).distinct().subquery()
                buyer_query = buyer_query.filter(
                    or_(
                        ~Buyer.id.in_(db.query(no_contact_subq.c.buyer_id)),
                        Buyer.id.in_(db.query(contact_subq.c.buyer_id)),
                    )
                )
            else:
                buyer_query = buyer_query.filter(Buyer.id.in_(db.query(contact_subq.c.buyer_id)))

    return buyer_query


def _filtered_lead_table_rows(
    db: Session,
    *,
    score: str | None = None,
    country: str | None = None,
    industry: str | None = None,
    company_grading: str | None = None,
    product_interest: str | None = None,
    city: str | None = None,
    call_recommended: str | None = None,
    source: str | None = None,
    exclude_source: str | None = None,
    call_outcome: str | None = None,
    in_interested_clients: bool = False,
    market_role: str | None = None,
    q: str | None = None,
    sort_by: str = "created_at",
    sort_dir: str = "desc",
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
    pool_for_user_id: int | None = None,
    include_placed_outcomes: bool = False,
    admin_sent_only: bool = False,
    intake_method: str | None = None,
    new_search_lead_only: bool = False,
    page: int | None = None,
    page_size: int | None = None,
    ids_only: bool = False,
    master_type: str | None = None,
    designation: str | None = None,
    contact_person: str | None = None,
    primary_mobile: str | None = None,
    secondary_mobile: str | None = None,
    phone: str | None = None,
    secondary_phone: str | None = None,
    email: str | None = None,
    secondary_email: str | None = None,
    website: str | None = None,
    address: str | None = None,
    remarks: str | None = None,
) -> tuple[list[dict[str, object]], int, int]:
    """Filter leads for the table.

    Returns (rows_or_id_dicts, section_total, filtered_count).
    When page/page_size are set, only that page is hydrated (unless ids_only).
    """
    from sqlalchemy import or_

    buyer_query = _apply_lead_table_scope(
        db.query(Buyer),
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
        pool_for_user_id=pool_for_user_id,
        admin_sent_only=admin_sent_only,
        master_type=master_type,
    )
    buyer_query = _apply_intake_method_scope(buyer_query, intake_method=intake_method)
    if new_search_lead_only:
        buyer_query = _apply_new_search_lead_scope(buyer_query)
    buyer_query, _ = _apply_call_outcome_scope(
        db,
        buyer_query,
        call_outcome=call_outcome,
        include_placed_outcomes=include_placed_outcomes,
        in_interested_clients=in_interested_clients,
    )
    section_total = buyer_query.with_entities(sa_func.count(Buyer.id)).scalar() or 0
    if section_total == 0:
        return [], 0, 0

    # Push column filters to SQL
    buyer_query = _apply_column_field_filter(db, buyer_query, "company_grading", company_grading)
    buyer_query = _apply_column_field_filter(db, buyer_query, "industry", industry)
    buyer_query = _apply_column_field_filter(db, buyer_query, "city", city)
    buyer_query = _apply_column_field_filter(db, buyer_query, "designation", designation)
    buyer_query = _apply_column_field_filter(db, buyer_query, "contact_person", contact_person)
    buyer_query = _apply_column_field_filter(db, buyer_query, "primary_mobile", primary_mobile)
    buyer_query = _apply_column_field_filter(db, buyer_query, "secondary_mobile", secondary_mobile)
    buyer_query = _apply_column_field_filter(db, buyer_query, "phone", phone)
    buyer_query = _apply_column_field_filter(db, buyer_query, "secondary_phone", secondary_phone)
    buyer_query = _apply_column_field_filter(db, buyer_query, "email", email)
    buyer_query = _apply_column_field_filter(db, buyer_query, "secondary_email", secondary_email)
    buyer_query = _apply_column_field_filter(db, buyer_query, "website", website)
    buyer_query = _apply_column_field_filter(db, buyer_query, "address", address)
    buyer_query = _apply_column_field_filter(db, buyer_query, "remarks", remarks)
    if market_role:
        try:
            role_value = MarketRole(market_role)
        except ValueError:
            role_value = None
        if role_value is not None:
            buyer_query = buyer_query.filter(Buyer.market_role == role_value)

    if country:
        from modules.countries import country_search_terms

        country_items = [c.strip() for c in country.split(",") if c.strip()]
        all_terms = []
        for c_item in country_items:
            all_terms.extend([term for term in country_search_terms(c_item) if term])
        if all_terms:
            buyer_query = buyer_query.filter(
                or_(
                    *[
                        sa_func.lower(sa_func.coalesce(Buyer.country, "")).like(f"%{term}%")
                        for term in all_terms
                    ]
                )
            )

    query_text = (q or "").strip().lower()
    if query_text:
        pattern = f"%{query_text}%"
        contact_match = (
            db.query(Contact.buyer_id)
            .filter(
                or_(
                    sa_func.lower(sa_func.coalesce(Contact.full_name, "")).like(pattern),
                    sa_func.lower(sa_func.coalesce(Contact.email, "")).like(pattern),
                    sa_func.lower(sa_func.coalesce(Contact.phone, "")).like(pattern),
                    sa_func.lower(sa_func.coalesce(Contact.designation, "")).like(pattern),
                    sa_func.lower(sa_func.coalesce(Contact.secondary_mobile, "")).like(pattern),
                    sa_func.lower(sa_func.coalesce(Contact.primary_phone, "")).like(pattern),
                    sa_func.lower(sa_func.coalesce(Contact.secondary_phone, "")).like(pattern),
                    sa_func.lower(sa_func.coalesce(Contact.secondary_email, "")).like(pattern),
                )
            )
            .distinct()
            .subquery()
        )
        buyer_query = buyer_query.filter(
            or_(
                sa_func.lower(sa_func.coalesce(Buyer.company_name, "")).like(pattern),
                sa_func.lower(sa_func.coalesce(Buyer.country, "")).like(pattern),
                sa_func.lower(sa_func.coalesce(Buyer.industry, "")).like(pattern),
                sa_func.lower(sa_func.coalesce(Buyer.company_grading, "")).like(pattern),
                sa_func.lower(sa_func.coalesce(Buyer.product_interest, "")).like(pattern),
                sa_func.lower(sa_func.coalesce(Buyer.city, "")).like(pattern),
                sa_func.lower(sa_func.coalesce(Buyer.address, "")).like(pattern),
                sa_func.lower(sa_func.coalesce(Buyer.remarks, "")).like(pattern),
                sa_func.lower(sa_func.coalesce(Buyer.assigned_to, "")).like(pattern),
                Buyer.id.in_(db.query(contact_match.c.buyer_id)),
            )
        )

    if score:
        grade = score.strip().upper()
        legacy = {"HOT": "AAA", "WARM": "AA", "COLD": "A"}
        grade = legacy.get(grade, grade)
        ranked_score_ids = (
            db.query(
                LeadScore.buyer_id.label("buyer_id"),
                LeadScore.score.label("score"),
                sa_func.row_number()
                .over(partition_by=LeadScore.buyer_id, order_by=LeadScore.scored_at.desc())
                .label("rn"),
            )
            .subquery()
        )
        latest_scores = (
            db.query(ranked_score_ids.c.buyer_id, ranked_score_ids.c.score)
            .filter(ranked_score_ids.c.rn == 1)
            .subquery()
        )
        if grade == "UNSCORED":
            buyer_query = buyer_query.outerjoin(
                latest_scores, Buyer.id == latest_scores.c.buyer_id
            ).filter(
                latest_scores.c.buyer_id.is_(None),
            )
        else:
            try:
                score_label = LeadScoreLabel(grade)
            except ValueError:
                score_label = None
            if score_label is not None:
                # AI grade filter uses lead_scores only (never spreadsheet company_grading)
                buyer_query = buyer_query.outerjoin(
                    latest_scores, Buyer.id == latest_scores.c.buyer_id
                ).filter(latest_scores.c.score == score_label)

    sort_field = sort_by if sort_by in _SORT_FIELDS else "created_at"
    reverse = sort_dir.lower() != "asc"

    # Fast SQL path: push ORDER BY + LIMIT/OFFSET to Postgres when the sort is a
    # plain Buyer column and call_recommended filtering is not needed.  This avoids
    # fetching every matching row into Python just to sort and slice it.
    _SQL_SORT_COLS = {
        "created_at": Buyer.created_at,
        "company_name": Buyer.company_name,
        "country": Buyer.country,
    }
    use_sql_sort = (
        not call_recommended
        and not ids_only
        and sort_field in _SQL_SORT_COLS
        and page is not None
        and page_size is not None
    )

    if use_sql_sort:
        page = max(1, page)  # type: ignore[arg-type]
        page_size = min(max(1, page_size), 50000)  # type: ignore[arg-type]
        col = _SQL_SORT_COLS[sort_field]
        order_expr = col.desc() if reverse else col.asc()
        # filtered_count via count query (cheap — no row transfer)
        filtered_count = buyer_query.with_entities(sa_func.count(Buyer.id)).scalar() or 0
        if filtered_count == 0:
            return [], section_total, 0
        start = (page - 1) * page_size
        page_id_rows = (
            buyer_query.order_by(order_expr, Buyer.id)
            .offset(start)
            .limit(page_size)
            .with_entities(Buyer.id)
            .all()
        )
        page_ids = [int(row[0]) for row in page_id_rows]
        if not page_ids:
            return [], section_total, filtered_count
        buyers = db.query(Buyer).filter(Buyer.id.in_(page_ids)).all()
        by_id = {buyer.id: buyer for buyer in buyers}
        ordered_buyers = [by_id[bid] for bid in page_ids if bid in by_id]
        return _hydrate_lead_table_rows(db, ordered_buyers), section_total, filtered_count

    # Python sort path — used for exotic sorts, call_recommended filter, and ids_only.
    light_rows = buyer_query.with_entities(
        Buyer.id, Buyer.country, Buyer.company_name, Buyer.created_at, Buyer.market_role
    ).all()

    if call_recommended:
        want = call_recommended.strip().lower()
        filtered_light = []
        for buyer_id, country_val, company_name, created_at, role in light_rows:
            timing = get_call_recommendation(country_val)
            recommended = timing["call_recommended"]
            keep = False
            if want in {"yes", "true", "recommended"}:
                keep = recommended is True
            elif want in {"no", "false", "not_now", "not-now"}:
                keep = recommended is False
            elif want in {"unknown", "none"}:
                keep = recommended is None
            if keep:
                filtered_light.append(
                    (buyer_id, country_val, company_name, created_at, role)
                )
        light_rows = filtered_light

    if sort_field == "company_name":
        light_rows.sort(
            key=lambda row: ((row[2] or "").lower(), row[0]), reverse=reverse
        )
    elif sort_field == "country":
        light_rows.sort(
            key=lambda row: ((row[1] or "").lower(), row[0]), reverse=reverse
        )
    elif sort_field == "market_role":
        light_rows.sort(
            key=lambda row: (
                (row[4].value if row[4] is not None else "unknown"),
                row[0],
            ),
            reverse=reverse,
        )
    elif sort_field == "latest_score":
        # Only score the filtered set (still cheaper than full hydration).
        score_ids = [row[0] for row in light_rows]
        score_by_id: dict[int, str | None] = {bid: None for bid in score_ids}
        if score_ids:
            ranked = (
                db.query(
                    LeadScore.buyer_id,
                    LeadScore.score,
                    sa_func.row_number()
                    .over(
                        partition_by=LeadScore.buyer_id,
                        order_by=LeadScore.scored_at.desc(),
                    )
                    .label("rn"),
                )
                .filter(LeadScore.buyer_id.in_(score_ids))
                .subquery()
            )
            for buyer_id, score_val, _rn in (
                db.query(ranked.c.buyer_id, ranked.c.score, ranked.c.rn)
                .filter(ranked.c.rn == 1)
                .all()
            ):
                score_by_id[int(buyer_id)] = (
                    score_val.value if hasattr(score_val, "value") else str(score_val)
                )
        light_rows.sort(
            key=lambda row: (
                0 if score_by_id.get(row[0]) else 1,
                _SCORE_ORDER.get(score_by_id.get(row[0]) or "", 99),
                row[0],
            ),
            reverse=reverse,
        )
    else:
        light_rows.sort(
            key=lambda row: (row[3] is None, row[3] or 0, row[0]), reverse=reverse
        )

    filtered_ids = [int(row[0]) for row in light_rows]
    filtered_count = len(filtered_ids)

    if ids_only:
        return [{"id": buyer_id} for buyer_id in filtered_ids], section_total, filtered_count

    page_ids = filtered_ids
    if page is not None and page_size is not None:
        page = max(1, page)
        page_size = min(max(1, page_size), 50000)
        start = (page - 1) * page_size
        page_ids = filtered_ids[start : start + page_size]

    if not page_ids:
        return [], section_total, filtered_count

    buyers = db.query(Buyer).filter(Buyer.id.in_(page_ids)).all()
    by_id = {buyer.id: buyer for buyer in buyers}
    ordered_buyers = [by_id[buyer_id] for buyer_id in page_ids if buyer_id in by_id]
    return _hydrate_lead_table_rows(db, ordered_buyers), section_total, filtered_count


def _extract_row_field_value(r: dict | object, field: str) -> str:
    get = (lambda k: r.get(k)) if isinstance(r, dict) else (lambda k: getattr(r, k, None))
    val = None
    if field == "id":
        val = get("legacy_serial_no") or get("id")
    elif field == "company_name":
        val = get("company_name")
    elif field in {"business_type", "industry"}:
        val = get("industry") or get("business_type")
    elif field in {"excel_file_grading", "company_grading"}:
        val = get("company_grading") or get("excel_file_grading")
    elif field == "designation":
        val = get("contact_designation") or get("designation")
    elif field == "contact_person":
        val = get("contact_name") or get("contact_person")
    elif field == "primary_mobile":
        val = get("contact_phone") or get("primary_mobile")
    elif field == "secondary_mobile":
        val = get("contact_secondary_mobile") or get("secondary_mobile")
    elif field == "phone":
        val = get("contact_primary_phone") or get("phone")
    elif field == "secondary_phone":
        val = get("contact_secondary_phone") or get("secondary_phone")
    elif field == "email":
        val = get("contact_email") or get("email")
    elif field == "secondary_email":
        val = get("contact_secondary_email") or get("secondary_email")
    elif field == "country":
        val = get("country")
    elif field == "product":
        val = get("product_interest") or get("product")
    elif field == "website":
        val = get("website_url") or get("website")
    elif field == "city":
        val = get("city")
    elif field in {"ai_grading", "latest_score"}:
        val = get("latest_score") or get("ai_grading")
    elif field == "address":
        val = get("address")
    elif field == "calling_time":
        val = get("calling_time")
    elif field == "remarks":
        val = get("remarks")
    elif field == "assigned_to_user_id":
        val = get("assigned_to")
    elif field == "market_role":
        val = get("market_role")
    else:
        val = get(field)

    if val is None:
        return ""
    s = str(val).strip()
    if s in {"—", "-"}:
        return ""
    return s


def get_lead_table_column_values(
    db: Session,
    *,
    field: str,
    score: str | None = None,
    country: str | None = None,
    industry: str | None = None,
    company_grading: str | None = None,
    product_interest: str | None = None,
    city: str | None = None,
    call_recommended: str | None = None,
    source: str | None = None,
    exclude_source: str | None = None,
    call_outcome: str | None = None,
    in_interested_clients: bool = False,
    market_role: str | None = None,
    q: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
    pool_for_user_id: int | None = None,
    include_placed_outcomes: bool = False,
    admin_sent_only: bool = False,
    intake_method: str | None = None,
    new_search_lead_only: bool = False,
    master_type: str | None = None,
    designation: str | None = None,
    contact_person: str | None = None,
    primary_mobile: str | None = None,
    secondary_mobile: str | None = None,
    phone: str | None = None,
    secondary_phone: str | None = None,
    email: str | None = None,
    secondary_email: str | None = None,
    website: str | None = None,
    address: str | None = None,
    remarks: str | None = None,
) -> dict[str, object]:
    id_rows, _section_total, filtered_count = _filtered_lead_table_rows(
        db,
        score=score,
        country=country,
        industry=industry,
        company_grading=company_grading,
        product_interest=product_interest,
        city=city,
        call_recommended=call_recommended,
        source=source,
        exclude_source=exclude_source,
        call_outcome=call_outcome,
        in_interested_clients=in_interested_clients,
        market_role=market_role,
        q=q,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
        pool_for_user_id=pool_for_user_id,
        include_placed_outcomes=include_placed_outcomes,
        admin_sent_only=admin_sent_only,
        intake_method=intake_method,
        new_search_lead_only=new_search_lead_only,
        master_type=master_type,
        designation=designation,
        contact_person=contact_person,
        primary_mobile=primary_mobile,
        secondary_mobile=secondary_mobile,
        phone=phone,
        secondary_phone=secondary_phone,
        email=email,
        secondary_email=secondary_email,
        website=website,
        address=address,
        remarks=remarks,
        ids_only=True,
    )

    if filtered_count == 0 or not id_rows:
        return {
            "field": field,
            "total_matching": 0,
            "blank_count": 0,
            "unique_values": [],
        }

    matching_buyer_ids = [int(r["id"]) for r in id_rows if isinstance(r, dict) and "id" in r]

    counts: dict[str, int] = {}
    blank_count = 0

    buyer_col_map = {
        "excel_file_grading": Buyer.company_grading,
        "company_grading": Buyer.company_grading,
        "business_type": Buyer.industry,
        "industry": Buyer.industry,
        "city": Buyer.city,
        "website": Buyer.website_url,
        "address": Buyer.address,
        "remarks": Buyer.remarks,
    }
    contact_col_map = {
        "designation": Contact.designation,
        "contact_person": Contact.full_name,
        "primary_mobile": Contact.phone,
        "secondary_mobile": Contact.secondary_mobile,
        "phone": Contact.primary_phone,
        "secondary_phone": Contact.secondary_phone,
        "email": Contact.email,
        "secondary_email": Contact.secondary_email,
    }

    if field in buyer_col_map:
        col = buyer_col_map[field]
        grouped = (
            db.query(col, sa_func.count(Buyer.id))
            .filter(Buyer.id.in_(matching_buyer_ids))
            .group_by(col)
            .all()
        )
        for raw_val, cnt in grouped:
            v = (raw_val or "").strip()
            if not v or v in {"—", "-"}:
                blank_count += cnt
            else:
                counts[v] = counts.get(v, 0) + cnt
    elif field in contact_col_map:
        ccol = contact_col_map[field]
        grouped = (
            db.query(ccol, sa_func.count(Contact.id))
            .filter(Contact.buyer_id.in_(matching_buyer_ids))
            .group_by(ccol)
            .all()
        )
        has_val_buyers = set(
            b_id
            for (b_id,) in db.query(Contact.buyer_id)
            .filter(
                Contact.buyer_id.in_(matching_buyer_ids),
                ccol.isnot(None),
                ccol != "",
                ccol != "—",
                ccol != "-",
            )
            .all()
        )
        blank_count = len(matching_buyer_ids) - len(has_val_buyers)
        for raw_val, cnt in grouped:
            v = (raw_val or "").strip()
            if v and v not in {"—", "-"}:
                counts[v] = counts.get(v, 0) + cnt

    if field in {"excel_file_grading", "company_grading"}:
        standard_tiers = ["AAAA", "AAA", "AA", "A"]
        for tier in standard_tiers:
            if tier not in counts:
                counts[tier] = 0
        standard_order = {"AAAA": 0, "AAA": 1, "AA": 2, "A": 3}
        standard_items = [
            (k, v) for k, v in counts.items() if k in standard_order
        ]
        standard_items.sort(key=lambda x: standard_order.get(x[0], 99))
        other_items = [
            (k, v) for k, v in counts.items() if k not in standard_order
        ]
        other_items.sort(key=lambda x: x[1], reverse=True)
        sorted_vals = standard_items + other_items
    else:
        sorted_vals = sorted(counts.items(), key=lambda x: x[1], reverse=True)
    return {
        "field": field,
        "total_matching": filtered_count,
        "blank_count": blank_count,
        "unique_values": [{"value": k, "count": v} for k, v in sorted_vals],
    }


def list_leads_table_ids(
    db: Session,
    *,
    score: str | None = None,
    country: str | None = None,
    industry: str | None = None,
    company_grading: str | None = None,
    product_interest: str | None = None,
    city: str | None = None,
    call_recommended: str | None = None,
    source: str | None = None,
    exclude_source: str | None = None,
    call_outcome: str | None = None,
    in_interested_clients: bool = False,
    market_role: str | None = None,
    q: str | None = None,
    sort_by: str = "created_at",
    sort_dir: str = "desc",
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
    pool_for_user_id: int | None = None,
    include_placed_outcomes: bool = False,
    admin_sent_only: bool = False,
    intake_method: str | None = None,
    new_search_lead_only: bool = False,
    master_type: str | None = None,
    designation: str | None = None,
    contact_person: str | None = None,
    primary_mobile: str | None = None,
    secondary_mobile: str | None = None,
    phone: str | None = None,
    secondary_phone: str | None = None,
    email: str | None = None,
    secondary_email: str | None = None,
    website: str | None = None,
    address: str | None = None,
    remarks: str | None = None,
) -> dict[str, object]:
    rows, _section_total, filtered_count = _filtered_lead_table_rows(
        db,
        score=score,
        country=country,
        industry=industry,
        company_grading=company_grading,
        product_interest=product_interest,
        city=city,
        call_recommended=call_recommended,
        source=source,
        exclude_source=exclude_source,
        call_outcome=call_outcome,
        in_interested_clients=in_interested_clients,
        market_role=market_role,
        q=q,
        sort_by=sort_by,
        sort_dir=sort_dir,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
        pool_for_user_id=pool_for_user_id,
        include_placed_outcomes=include_placed_outcomes,
        admin_sent_only=admin_sent_only,
        intake_method=intake_method,
        new_search_lead_only=new_search_lead_only,
        ids_only=True,
        master_type=master_type,
        designation=designation,
        contact_person=contact_person,
        primary_mobile=primary_mobile,
        secondary_mobile=secondary_mobile,
        phone=phone,
        secondary_phone=secondary_phone,
        email=email,
        secondary_email=secondary_email,
        website=website,
        address=address,
        remarks=remarks,
    )
    return {
        "filtered_count": filtered_count,
        "ids": [int(row["id"]) for row in rows],
    }


def list_leads_table(
    db: Session,
    *,
    score: str | None = None,
    country: str | None = None,
    industry: str | None = None,
    company_grading: str | None = None,
    product_interest: str | None = None,
    city: str | None = None,
    call_recommended: str | None = None,
    source: str | None = None,
    exclude_source: str | None = None,
    call_outcome: str | None = None,
    in_interested_clients: bool = False,
    market_role: str | None = None,
    q: str | None = None,
    sort_by: str = "created_at",
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 20,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
    pool_for_user_id: int | None = None,
    include_placed_outcomes: bool = False,
    admin_sent_only: bool = False,
    intake_method: str | None = None,
    new_search_lead_only: bool = False,
    master_type: str | None = None,
    designation: str | None = None,
    contact_person: str | None = None,
    primary_mobile: str | None = None,
    secondary_mobile: str | None = None,
    phone: str | None = None,
    secondary_phone: str | None = None,
    email: str | None = None,
    secondary_email: str | None = None,
    website: str | None = None,
    address: str | None = None,
    remarks: str | None = None,
) -> dict[str, object]:
    page = max(1, page)
    page_size = min(max(1, page_size), 50000)

    rows, section_total, filtered_count = _filtered_lead_table_rows(
        db,
        score=score,
        country=country,
        industry=industry,
        company_grading=company_grading,
        product_interest=product_interest,
        city=city,
        call_recommended=call_recommended,
        source=source,
        exclude_source=exclude_source,
        call_outcome=call_outcome,
        in_interested_clients=in_interested_clients,
        market_role=market_role,
        q=q,
        sort_by=sort_by,
        sort_dir=sort_dir,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
        pool_for_user_id=pool_for_user_id,
        include_placed_outcomes=include_placed_outcomes,
        admin_sent_only=admin_sent_only,
        intake_method=intake_method,
        new_search_lead_only=new_search_lead_only,
        page=page,
        page_size=page_size,
        master_type=master_type,
        designation=designation,
        contact_person=contact_person,
        primary_mobile=primary_mobile,
        secondary_mobile=secondary_mobile,
        phone=phone,
        secondary_phone=secondary_phone,
        email=email,
        secondary_email=secondary_email,
        website=website,
        address=address,
        remarks=remarks,
    )

    total_pages = max(1, (filtered_count + page_size - 1) // page_size) if filtered_count else 1
    if page > total_pages:
        page = total_pages

    return {
        "total": section_total,
        "filtered_count": filtered_count,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "rows": rows,
    }


_SECTION_COUNTS_TTL = 20.0
_SECTION_COUNTS_PREFIX = "section_counts:"


def count_my_assigned_leads(db: Session, user_id: int) -> int:
    """Leads assigned to a sales user (admin-sent + self-imports)."""
    from sqlalchemy import func as sa_func

    return (
        db.query(sa_func.count(Buyer.id)).filter(Buyer.assigned_to_user_id == user_id).scalar()
    ) or 0


def invalidate_section_counts_cache() -> None:
    """Call after any write that changes lead counts or call outcomes."""
    cache.clear_prefix(_SECTION_COUNTS_PREFIX)


def count_leads_table_sections(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
    pool_for_user_id: int | None = None,
    master_type: str = "fmcg",
) -> dict[str, object]:
    cache_key = f"{_SECTION_COUNTS_PREFIX}{assigned_to_user_id}:{pool_for_user_id}:{master_type}"
    cached = cache.get(cache_key)
    if cached is not MISS:
        return cached  # type: ignore[return-value]

    result = _compute_section_counts(
        db,
        assigned_to_user_id=assigned_to_user_id,
        pool_for_user_id=pool_for_user_id,
        master_type=master_type,
    )
    cache.set(cache_key, result, ttl=_SECTION_COUNTS_TTL)
    return result


def _compute_section_counts(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
    pool_for_user_id: int | None = None,
    master_type: str = "fmcg",
) -> dict[str, object]:
    from modules.calls import latest_call_outcomes_by_buyer

    buyer_query = db.query(
        Buyer.id, Buyer.source, Buyer.assigned_to_user_id, Buyer.assigned_by_user_id
    )
    if master_type:
        from sqlalchemy import or_
        if master_type.strip().lower() == "fmcg":
            buyer_query = buyer_query.filter(
                or_(
                    sa_func.lower(Buyer.master_type) == "fmcg",
                    Buyer.master_type.is_(None),
                    Buyer.master_type == "",
                )
            )
        else:
            buyer_query = buyer_query.filter(
                sa_func.lower(Buyer.master_type) == master_type.strip().lower()
            )
    if pool_for_user_id is not None:
        from sqlalchemy import or_

        # Legacy shared-pool mode (kept for callers); prefer exact assignee.
        buyer_query = buyer_query.filter(
            or_(
                Buyer.assigned_to_user_id.is_(None),
                Buyer.assigned_to_user_id == pool_for_user_id,
            )
        )
    elif assigned_to_user_id is not None:
        buyer_query = buyer_query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)

    incomplete_archives_ids: set[int] = set()
    old_client_ids: set[int] = set()
    other_ids: set[int] = set()
    unassigned_old_ids: set[int] = set()
    unassigned_other_ids: set[int] = set()
    new_search_lead_ids: set[int] = set()
    by_assignee: dict[str, int] = {}
    from collections import defaultdict
    pool_counts = defaultdict(int)

    for buyer_id, source, assignee_id, assigned_by_id in buyer_query.all():
        source_key = (source or "").strip().lower()
        pool_counts[source_key] += 1
        is_incomplete = source_key == INCOMPLETE_ARCHIVES_SOURCE
        is_old = source_key == "old_clients"
        if is_incomplete:
            incomplete_archives_ids.add(buyer_id)
        elif is_old:
            old_client_ids.add(buyer_id)
        else:
            other_ids.add(buyer_id)

        if assignee_id is None:
            if is_old:
                unassigned_old_ids.add(buyer_id)
            else:
                unassigned_other_ids.add(buyer_id)
            if is_new_search_lead_source(source):
                new_search_lead_ids.add(buyer_id)
        elif pool_for_user_id is None and assigned_by_id is not None:
            # Admin "Leads Sent To" badges — only admin-sent leads, not self-imports.
            key = str(assignee_id)
            by_assignee[key] = by_assignee.get(key, 0) + 1

    all_ids = old_client_ids | other_ids
    outcomes = latest_call_outcomes_by_buyer(db, buyer_ids=all_ids)

    interested_ids = {bid for bid, v in outcomes.items() if v == "interested"}
    follow_up_ids = {bid for bid, v in outcomes.items() if v == "follow_up"}
    not_interested_ids = {bid for bid, v in outcomes.items() if v == "not_interested"}
    not_received_ids = {bid for bid, v in outcomes.items() if v == "not_received_call"}
    placed_ids = interested_ids | follow_up_ids | not_interested_ids | not_received_ids

    listed_interested_ids: set[int] = set()
    if all_ids:
        listed_interested_ids = {
            row[0]
            for row in db.query(Buyer.id)
            .filter(
                Buyer.id.in_(all_ids),
                Buyer.interested_clients_list_at.isnot(None),
            )
            .all()
        }
    placed_ids |= listed_interested_ids

    if pool_for_user_id is not None:
        # Sales user scope already filtered to unassigned + own assignments.
        all_count = len(other_ids - placed_ids)
        old_count = len(old_client_ids - placed_ids)
    elif assigned_to_user_id is None:
        # Admin: New search lead = unassigned AI/scraped only; Old clients = all rows.
        all_count = len(new_search_lead_ids - placed_ids)
        old_count = len(old_client_ids)
    else:
        all_count = len(other_ids - placed_ids)
        old_count = len(old_client_ids - placed_ids)

    counts_result = {
        "all": all_count,
        "old_clients": old_count,
        "interested_clients": len(follow_up_ids),
        "sales_interested_clients": len(listed_interested_ids),
        "not_interested_clients": len(not_interested_ids),
        "not_received_call_clients": len(not_received_ids),
        # Admin master table: every lead (assigned + unassigned, all sources).
        "master": len(all_ids) if pool_for_user_id is None and assigned_to_user_id is None else 0,
        "by_assignee": by_assignee if pool_for_user_id is None else {},
        "hyperstore_targeted": pool_counts.get("hyperstore_targeted", 0),
        "targeted_distributor": pool_counts.get("targeted_distributor", 0),
        "targeted_client": pool_counts.get("targeted_client", 0),
        "khalid_focused_sales": pool_counts.get("khalid_focused_sales", 0),
        "incomplete_archives": len(incomplete_archives_ids),
        "testing": pool_counts.get("testing", 0),
    }
    # Dynamically inject any custom module counts
    for src_key, cnt in pool_counts.items():
        if src_key and src_key not in counts_result:
            counts_result[src_key] = cnt
    return counts_result


def get_lead_table_row(db: Session, buyer_id: int) -> dict[str, object] | None:
    buyer = buyers_module.get_buyer(db, buyer_id)
    if not buyer:
        return None

    latest = get_latest_score(db, buyer_id)
    contacts = buyers_module.list_contacts_for_buyer(db, buyer_id)
    contact = next((c for c in contacts if c.email), contacts[0] if contacts else None)
    call_timing = get_call_recommendation(buyer.country)
    from modules.calls import latest_call_notes_by_buyer

    call_notes = latest_call_notes_by_buyer(db, buyer_ids={buyer_id}).get(buyer_id)

    return {
        "id": buyer.id,
        "company_name": buyer.company_name,
        "country": buyer.country,
        "call_recommended": call_timing["call_recommended"],
        "call_local_time": call_timing["call_local_time"],
        "call_timezone": call_timing["call_timezone"],
        "call_reason": call_timing["call_reason"],
        "industry": buyer.industry,
        "website_url": buyer.website_url,
        "linkedin_company_url": buyer.linkedin_company_url,
        "facebook_company_url": buyer.facebook_company_url,
        "instagram_company_url": buyer.instagram_company_url,
        "source": buyer.source,
        "legacy_serial_no": buyer.legacy_serial_no,
        "company_grading": buyer.company_grading,
        "product_interest": buyer.product_interest,
        "city": buyer.city,
        "address": buyer.address,
        "remarks": resolve_current_remarks(buyer) or buyer.remarks,
        "remarks_history": buyer.remarks_history or [],
        "call_remarks": call_notes,
        "assigned_to": buyer.assigned_to or "unassigned",
        "assigned_to_user_id": buyer.assigned_to_user_id,
        "follow_up_at": buyer.follow_up_at,
        "created_at": buyer.created_at,
        "latest_score": latest.score.value if latest else None,
        "score_reasoning": latest.reasoning if latest else None,
        "scored_at": latest.scored_at if latest else None,
        "contact_id": contact.id if contact else None,
        "contact_name": contact.full_name if contact else None,
        "contact_email": contact.email if contact else None,
        "contact_phone": contact.phone if contact else None,
        "contact_designation": contact.designation if contact else None,
        "contact_secondary_mobile": contact.secondary_mobile if contact else None,
        "contact_primary_phone": contact.primary_phone if contact else None,
        "contact_secondary_phone": contact.secondary_phone if contact else None,
        "contact_secondary_email": contact.secondary_email if contact else None,
        "market_role": buyer.market_role.value if buyer.market_role else "unknown",
        "market_role_reasoning": buyer.market_role_reasoning,
        "producer_tier": buyer.producer_tier.value if buyer.producer_tier else None,
        "producer_conversion_pct": (
            float(buyer.producer_conversion_pct)
            if buyer.producer_conversion_pct is not None
            else None
        ),
        "producer_tier_reasoning": buyer.producer_tier_reasoning,
    }


def update_lead_table_row(
    db: Session,
    buyer_id: int,
    data: dict,
    *,
    remarks_by: str | None = None,
    by_user_id: int | None = None,
) -> dict[str, object] | None:
    from modules.audit import log_action

    buyer = buyers_module.get_buyer(db, buyer_id)
    if not buyer:
        return None

    if "assigned_to_user_id" in data:
        previous_assignee_id = buyer.assigned_to_user_id
        new_assignee_id = data.get("assigned_to_user_id")
        apply_buyer_assignee(
            db,
            buyer,
            new_assignee_id,
            assigned_by_user_id=by_user_id if new_assignee_id is not None else None,
        )
        if (
            new_assignee_id is not None
            and previous_assignee_id != new_assignee_id
            and by_user_id is not None
        ):
            from modules import ai_mode as ai_mode_module

            ai_mode_module.record_lead_transfer(
                db,
                buyer_ids=[buyer_id],
                to_user_id=int(new_assignee_id),
                to_label=buyer.assigned_to or _assignee_label(
                    resolve_assignee_user(db, int(new_assignee_id))
                ),
                by_user_id=by_user_id,
                commit=False,
            )
        db.commit()
        db.refresh(buyer)
        data = {k: v for k, v in data.items() if k not in {"assigned_to_user_id", "assigned_to"}}

    buyer_fields = {
        key: data[key]
        for key in (
            "company_name",
            "country",
            "industry",
            "website_url",
            "linkedin_company_url",
            "facebook_company_url",
            "instagram_company_url",
            "legacy_serial_no",
            "company_grading",
            "product_interest",
            "city",
            "address",
            "remarks",
            "remarks_03",
            "remarks_04",
        )
        if key in data
    }
    if buyer_fields:
        if not buyers_module.update_buyer(
            db, buyer_id, buyer_fields, remarks_by=remarks_by
        ):
            return None

    contact_keys = (
        "contact_name",
        "contact_email",
        "contact_phone",
        "contact_designation",
        "contact_secondary_mobile",
        "contact_primary_phone",
        "contact_secondary_phone",
        "contact_secondary_email",
    )
    contact_fields_present = any(key in data for key in contact_keys)
    if contact_fields_present:
        buyers_module.upsert_primary_contact(
            db,
            buyer_id,
            contact_id=data.get("contact_id"),
            full_name=data.get("contact_name"),
            email=data.get("contact_email"),
            phone=data.get("contact_phone"),
            designation=data.get("contact_designation"),
            secondary_mobile=data.get("contact_secondary_mobile"),
            primary_phone=data.get("contact_primary_phone"),
            secondary_phone=data.get("contact_secondary_phone"),
            secondary_email=data.get("contact_secondary_email"),
        )

    log_action(
        db,
        entity_type="buyer",
        entity_id=buyer_id,
        action="table_row_updated",
        details={k: data[k] for k in data if k != "assigned_to"},
    )
    return get_lead_table_row(db, buyer_id)


def _section_buyers_query(
    db: Session,
    *,
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
):
    """Buyer query scoped by source / assignee at the SQL level."""
    query = db.query(Buyer)
    if source:
        query = query.filter(sa_func.lower(Buyer.source) == source.strip().lower())
    excluded = {
        part.strip().lower()
        for part in (exclude_source or "").split(",")
        if part.strip()
    }
    if excluded:
        query = query.filter(
            ~sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(excluded)
        )
    if assigned_to_user_id is not None:
        query = query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)
    elif unassigned_only:
        query = query.filter(Buyer.assigned_to_user_id.is_(None))
    return query


def remove_leads_overlapping_old_clients(db: Session) -> dict[str, object]:
    """Delete Leads-table / Discover rows that match an Old client by name or domain.

    Old clients are never deleted. Only non-old_clients buyers that collide with
    an old client (normalized company name or website domain) are removed.
    """
    from modules.audit import log_action
    from modules.lead_discovery import _domain, _normalize_name

    old_clients = _section_buyers_query(db, source="old_clients").all()
    if not old_clients:
        return {
            "removed_count": 0,
            "kept_count": 0,
            "groups": [],
            "old_clients_count": 0,
        }

    old_names: set[str] = set()
    old_domains: set[str] = set()
    for buyer in old_clients:
        name_key = _normalize_name(buyer.company_name)
        if name_key:
            old_names.add(name_key)
        domain = _domain(buyer.website_url)
        if domain:
            old_domains.add(domain)

    leads = _section_buyers_query(db, exclude_source="old_clients").all()
    remove_ids: list[int] = []
    groups: list[dict[str, object]] = []

    for buyer in leads:
        name_key = _normalize_name(buyer.company_name)
        domain = _domain(buyer.website_url)
        matched_by: list[str] = []
        if name_key and name_key in old_names:
            matched_by.append("company_name")
        if domain and domain in old_domains:
            matched_by.append("website_domain")
        if not matched_by:
            continue
        remove_ids.append(buyer.id)
        groups.append(
            {
                "company_name": buyer.company_name,
                "kept_id": 0,
                "removed_ids": [buyer.id],
                "removed_names": [buyer.company_name],
                "match": ",".join(matched_by),
            }
        )

    removed_count = 0
    import time

    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    CHUNK = 40
    for start in range(0, len(remove_ids), CHUNK):
        chunk = remove_ids[start : start + CHUNK]
        for attempt in range(4):
            try:
                db.execute(text("SET LOCAL statement_timeout = '60s'"))
                removed_count += buyers_module.delete_buyers_bulk(db, chunk, commit=True)
                break
            except OperationalError:
                db.rollback()
                if attempt >= 3:
                    raise
                time.sleep(1.5 * (attempt + 1))

    if removed_count:
        invalidate_lead_table_filters_cache()
        invalidate_section_counts_cache()

    log_action(
        db,
        entity_type="buyer",
        entity_id=0,
        action="removed_old_client_overlaps",
        details={
            "removed_count": removed_count,
            "groups": len(groups),
            "old_clients_count": len(old_clients),
        },
    )

    return {
        "removed_count": removed_count,
        "kept_count": len(leads) - removed_count,
        "groups": [
            {
                "company_name": g["company_name"],
                "kept_id": 0,
                "removed_ids": g["removed_ids"],
                "removed_names": g["removed_names"],
            }
            for g in groups
        ],
        "old_clients_count": len(old_clients),
    }


def _contact_country_dedupe_key(contact_name: str | None, country: str | None) -> str | None:
    """Normalize contact + country for duplicate clustering."""
    import re

    name = re.sub(r"[^a-z]", "", (contact_name or "").strip().lower())
    if len(name) < 3:
        return None
    country_key = re.sub(r"[^a-z]", "", (country or "").strip().lower())
    if not country_key:
        return None
    return f"{name}|{country_key}"


def dedupe_leads_table(
    db: Session,
    *,
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, object]:
    """Remove duplicate leads within a section, keeping the richest record in each cluster."""
    from collections import defaultdict

    from modules.audit import log_action
    from modules.lead_discovery import _domain, _normalize_name

    buyers = _section_buyers_query(
        db,
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
    ).all()
    if len(buyers) < 2:
        return {"removed_count": 0, "kept_count": len(buyers), "groups": []}

    parent = {buyer.id: buyer.id for buyer in buyers}

    def find_root(buyer_id: int) -> int:
        while parent[buyer_id] != buyer_id:
            parent[buyer_id] = parent[parent[buyer_id]]
            buyer_id = parent[buyer_id]
        return buyer_id

    def union(a_id: int, b_id: int) -> None:
        root_a = find_root(a_id)
        root_b = find_root(b_id)
        if root_a != root_b:
            parent[root_b] = root_a

    by_name: dict[str, list[int]] = defaultdict(list)
    by_domain: dict[str, list[int]] = defaultdict(list)
    for buyer in buyers:
        name_key = _normalize_name(buyer.company_name)
        if name_key:
            by_name[name_key].append(buyer.id)
        domain = _domain(buyer.website_url)
        if domain:
            by_domain[domain].append(buyer.id)

    for ids in by_name.values():
        for other_id in ids[1:]:
            union(ids[0], other_id)
    for ids in by_domain.values():
        for other_id in ids[1:]:
            union(ids[0], other_id)

    # Same contact person + country → likely duplicate companies (e.g. ENZE / ENZE Canada Ltd).
    buyer_country = {buyer.id: buyer.country for buyer in buyers}
    by_contact_country: dict[str, list[int]] = defaultdict(list)
    if buyers:
        buyer_id_set = [buyer.id for buyer in buyers]
        for contact in db.query(Contact).filter(Contact.buyer_id.in_(buyer_id_set)).all():
            key = _contact_country_dedupe_key(contact.full_name, buyer_country.get(contact.buyer_id))
            if key:
                by_contact_country[key].append(contact.buyer_id)
    for ids in by_contact_country.values():
        unique_ids = list(dict.fromkeys(ids))
        if len(unique_ids) < 2:
            continue
        for other_id in unique_ids[1:]:
            union(unique_ids[0], other_id)

    clusters: dict[int, list[Buyer]] = defaultdict(list)
    for buyer in buyers:
        clusters[find_root(buyer.id)].append(buyer)

    # Score each buyer once up front — calling buyer_data_score inside the
    # keep/remove loop used to re-query contacts for every duplicate row.
    score_by_id = {
        buyer.id: buyers_module.buyer_data_score(db, buyer) for buyer in buyers
    }

    from modules.incomplete_archives import (
        has_salvage_data,
        merge_duplicate_into_keeper,
        primary_contact,
        relocate_buyer_to_incomplete_archives,
    )

    remove_ids: list[int] = []
    relocated_ids: list[int] = []
    groups: list[dict[str, object]] = []

    for cluster in clusters.values():
        if len(cluster) < 2:
            continue

        keeper = max(
            cluster,
            key=lambda buyer: (
                score_by_id.get(buyer.id, 0),
                buyer.created_at.timestamp() if buyer.created_at else 0,
            ),
        )
        removed = [buyer for buyer in cluster if buyer.id != keeper.id]
        for loser in removed:
            merge_duplicate_into_keeper(db, keeper, loser)
            loser_contact = primary_contact(db, loser.id)
            if relocate_buyer_to_incomplete_archives(
                db, loser.id, reason="dedupe_duplicate", commit=False
            ):
                relocated_ids.append(loser.id)
            elif has_salvage_data(loser, loser_contact):
                loser.source = INCOMPLETE_ARCHIVES_SOURCE
                relocated_ids.append(loser.id)
            else:
                remove_ids.append(loser.id)
        groups.append(
            {
                "company_name": keeper.company_name,
                "kept_id": keeper.id,
                "removed_ids": [buyer.id for buyer in removed],
                "removed_names": [buyer.company_name for buyer in removed],
            }
        )

    removed_count = 0
    if remove_ids:
        import time

        from sqlalchemy import text
        from sqlalchemy.exc import OperationalError

        CHUNK = 40
        for start in range(0, len(remove_ids), CHUNK):
            chunk = remove_ids[start : start + CHUNK]
            for attempt in range(4):
                try:
                    db.execute(text("SET LOCAL statement_timeout = '60s'"))
                    removed_count += buyers_module.delete_buyers_bulk(db, chunk, commit=True)
                    break
                except OperationalError:
                    db.rollback()
                    if attempt >= 3:
                        raise
                    time.sleep(1.5 * (attempt + 1))
    else:
        db.commit()

    if removed_count or relocated_ids:
        invalidate_lead_table_filters_cache()
        invalidate_section_counts_cache()

    log_action(
        db,
        entity_type="buyer",
        entity_id=0,
        action="table_deduped",
        details={
            "removed_count": removed_count,
            "relocated_to_incomplete": len(relocated_ids),
            "groups": len(groups),
            "source": source,
            "exclude_source": exclude_source,
        },
    )

    return {
        "removed_count": removed_count,
        "relocated_count": len(relocated_ids),
        "kept_count": len(buyers) - removed_count,
        "groups": groups,
    }


_SPARSE_IMPORT_SOURCES = frozenset({"csv", "old_clients"})


def cleanup_sparse_csv_leads(
    db: Session,
    *,
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, object]:
    """Move sparse CSV/old-client imports to Incomplete Data from Archives (no deletes)."""
    from modules.audit import log_action
    from modules.incomplete_archives import (
        has_salvage_data,
        is_incomplete_archives_source,
        merge_duplicate_into_keeper,
        primary_contact,
        relocate_buyer_to_incomplete_archives,
        should_route_to_incomplete_archives,
    )

    relocated: list[dict[str, object]] = []
    excluded = {
        part.strip().lower()
        for part in (exclude_source or "").split(",")
        if part.strip()
    }
    if source or excluded or assigned_to_user_id is not None or unassigned_only:
        candidates = _section_buyers_query(
            db,
            source=source,
            exclude_source=exclude_source,
            assigned_to_user_id=assigned_to_user_id,
            unassigned_only=unassigned_only,
        ).all()
        if not source and not excluded:
            candidates = [
                buyer
                for buyer in candidates
                if (buyer.source or "").lower() in _SPARSE_IMPORT_SOURCES
            ]
    else:
        candidates = [
            buyer
            for buyer in buyers_module.list_buyers(db)
            if (buyer.source or "").lower() in _SPARSE_IMPORT_SOURCES
        ]

    for buyer in candidates:
        if is_incomplete_archives_source(buyer.source):
            continue
        contact = primary_contact(db, buyer.id)
        if not should_route_to_incomplete_archives(buyer, contact):
            continue
        if relocate_buyer_to_incomplete_archives(
            db, buyer.id, reason="sparse_import", commit=False
        ):
            relocated.append({"id": buyer.id, "company_name": buyer.company_name})

    db.commit()

    log_action(
        db,
        entity_type="buyer",
        entity_id=0,
        action="sparse_csv_relocated_incomplete",
        details={
            "relocated_count": len(relocated),
            "source": source,
            "exclude_source": exclude_source,
        },
    )

    return {
        "removed_count": 0,
        "relocated_count": len(relocated),
        "relocated": relocated,
        "removed": [],
    }


def delete_lead_table_row(db: Session, buyer_id: int, *, commit: bool = True) -> bool:
    from modules.audit import log_action

    buyer = buyers_module.get_buyer(db, buyer_id)
    if not buyer:
        return False

    company_name = buyer.company_name
    if not buyers_module.delete_buyer(db, buyer_id, commit=commit):
        return False

    if commit:
        invalidate_lead_table_filters_cache()
        invalidate_section_counts_cache()
        log_action(
            db,
            entity_type="buyer",
            entity_id=buyer_id,
            action="deleted",
            details={"company_name": company_name},
        )
    return True


def delete_lead_table_rows(db: Session, buyer_ids: list[int]) -> dict[str, object]:
    """Delete many leads in a single DB transaction (one commit, one audit entry).

    The per-row delete endpoint round-trips to the DB ~10x per row; looping
    it from the client for bulk selections was the main cause of slow bulk
    deletes. This does all the work server-side in one request.
    """
    from modules.audit import log_action

    deleted_ids: list[int] = []
    deleted_names: list[str] = []
    seen: set[int] = set()

    for buyer_id in buyer_ids:
        if buyer_id in seen:
            continue
        seen.add(buyer_id)
        buyer = buyers_module.get_buyer(db, buyer_id)
        if not buyer:
            continue
        company_name = buyer.company_name
        if buyers_module.delete_buyer(db, buyer_id, commit=False):
            deleted_ids.append(buyer_id)
            deleted_names.append(company_name)

    db.commit()

    if deleted_ids:
        invalidate_lead_table_filters_cache()
        invalidate_section_counts_cache()
        log_action(
            db,
            entity_type="buyer",
            entity_id=0,
            action="bulk_deleted",
            details={
                "count": len(deleted_ids),
                "buyer_ids": deleted_ids,
                "company_names": deleted_names[:50],
            },
        )

    return {
        "deleted_count": len(deleted_ids),
        "deleted_ids": deleted_ids,
    }


def bulk_assign_lead_table_rows(
    db: Session,
    buyer_ids: list[int],
    *,
    assigned_to_user_id: int | None,
    by_user_id: int | None = None,
) -> dict[str, object]:
    """Assign many leads to one sales user (or unassign) in a single transaction."""
    from modules.audit import log_action

    assignee = resolve_assignee_user(db, assigned_to_user_id)
    label = _assignee_label(assignee)

    assigned_ids: list[int] = []
    company_names: list[str] = []
    seen: set[int] = set()

    for buyer_id in buyer_ids:
        if buyer_id in seen:
            continue
        seen.add(buyer_id)
        buyer = buyers_module.get_buyer(db, buyer_id)
        if not buyer:
            continue
        apply_buyer_assignee(
            db,
            buyer,
            assigned_to_user_id,
            assigned_by_user_id=by_user_id if assigned_to_user_id is not None else None,
        )
        assigned_ids.append(buyer_id)
        company_names.append(buyer.company_name)

    transfer_event = None
    if assigned_ids and assigned_to_user_id is not None:
        from modules import ai_mode as ai_mode_module

        transfer_event = ai_mode_module.record_lead_transfer(
            db,
            buyer_ids=assigned_ids,
            to_user_id=assigned_to_user_id,
            to_label=label,
            by_user_id=by_user_id,
            commit=False,
        )

    db.commit()

    if assigned_ids:
        log_action(
            db,
            entity_type="buyer",
            entity_id=0,
            action="bulk_assigned",
            details={
                "count": len(assigned_ids),
                "buyer_ids": assigned_ids,
                "company_names": company_names[:50],
                "assigned_to_user_id": assigned_to_user_id,
                "assigned_to": label,
                "by_user_id": by_user_id,
                "transfer_message": (transfer_event or {}).get("message"),
            },
        )

    return {
        "assigned_count": len(assigned_ids),
        "assigned_ids": assigned_ids,
        "assigned_to_user_id": assigned_to_user_id,
        "assigned_to": label,
        "transfer_message": (transfer_event or {}).get("message"),
    }


def set_target_pool(
    db: Session,
    *,
    lead_ids: list[int],
    source: str,
    intake_method: str = "discover",
) -> dict[str, object]:
    """Move leads into a targeted pool (Hyperstore / Distributor / Client)."""
    from modules.audit import log_action

    pool = source.strip().lower()
    if pool not in TARGETED_POOL_SOURCES:
        raise ValueError(f"Invalid targeted pool source: {source}")
    method = intake_method.strip().lower()
    if method not in {"upload", "discover"}:
        raise ValueError("intake_method must be upload or discover")

    updated_ids: list[int] = []
    for lead_id in lead_ids:
        buyer = buyers_module.get_buyer(db, lead_id)
        if not buyer:
            continue
        buyer.source = pool
        buyer.intake_method = method
        updated_ids.append(lead_id)

    if updated_ids:
        invalidate_section_counts_cache()
        db.commit()
        log_action(
            db,
            entity_type="buyer",
            entity_id=0,
            action="set_target_pool",
            details={
                "source": pool,
                "intake_method": method,
                "lead_ids": updated_ids,
            },
        )

    return {"updated_count": len(updated_ids), "updated_ids": updated_ids}


_POOL_MATCH_KEYWORDS: dict[str, tuple[str, ...]] = {
    "hyperstore_targeted": (
        "hypermarket",
        "hypermarkets",
        "hyper market",
        "hyper mart",
        "hypermart",
        "hyper store",
        "hyperstore",
        "multinational mart",
        "multi national mart",
        "multi-national mart",
        "supermarket",
        "super market",
        "super store",
        "superstore",
        "retail chain",
        "grocery chain",
        "grocery store",
        "10+ branches",
        "10 branches",
        "multiple branches",
        "multi branch",
        "carrefour",
        "lulu",
        "walmart",
        "tesco",
        "aldi",
    ),
    "targeted_distributor": (
        "distributor",
        "distributors",
        "distribution",
        "distributing",
        "wholesale",
        "wholesaler",
        "wholesaling",
        "stockist",
        "dealer",
        "import export",
        "importer",
        "importing",
        "exporter",
        "exporting",
        "trading company",
        "trading co",
        "general trading",
        "logistics",
        "supply chain",
    ),
    # Targeted Client is manual-only — no keyword auto-match.
    "targeted_client": (),
}


def _buyer_match_blob(buyer: Buyer) -> str:
    role = buyer.market_role.value if buyer.market_role else ""
    parts = [
        buyer.company_name or "",
        buyer.industry or "",
        buyer.product_interest or "",
        buyer.remarks or "",
        buyer.city or "",
        buyer.country or "",
        role,
    ]
    return " ".join(p.strip() for p in parts if p).lower()


def _score_pool_match(blob: str, pool: str) -> int:
    keywords = _POOL_MATCH_KEYWORDS.get(pool, ())
    return sum(1 for kw in keywords if kw in blob)


def populate_target_pool_intelligent(
    db: Session,
    *,
    pool: str,
    from_source: str,
    limit: int = 50,
    min_score: int = 1,
) -> dict[str, object]:
    """Move best-matching leads from Old clients or New search into a targeted pool."""
    from sqlalchemy import or_

    from modules.audit import log_action

    pool_key = pool.strip().lower()
    if pool_key not in TARGETED_POOL_SOURCES:
        raise ValueError(f"Invalid targeted pool source: {pool}")
    if pool_key == "targeted_client":
        raise ValueError(
            "Targeted Client is manual only — select rows and use Add to Targeted Client."
        )
    origin = from_source.strip().lower()
    if origin not in {"old_clients", "discover", "discover_leads"}:
        raise ValueError("from_source must be old_clients, discover, or discover_leads")

    intake_method = "upload" if origin == "old_clients" else "discover"
    limit = max(1, min(int(limit or 50), 200))

    q = db.query(Buyer).filter(
        ~sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(
            sorted(TARGETED_POOL_SOURCES)
        )
    )
    if pool_key in TARGETED_POOL_SOURCES:
        q = q.filter(sa_func.lower(sa_func.coalesce(Buyer.source, "")) != pool_key)

    if origin == "old_clients":
        q = q.filter(sa_func.lower(sa_func.coalesce(Buyer.source, "")) == "old_clients")
    elif origin == "discover_leads":
        q = q.filter(
            sa_func.lower(sa_func.coalesce(Buyer.source, "")) != "old_clients",
        ).filter(
            or_(
                sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(
                    list(DISCOVER_LEAD_SOURCES)
                ),
                Buyer.source.is_(None),
                sa_func.lower(sa_func.coalesce(Buyer.source, "")) == "",
            )
        )
    else:
        q = q.filter(
            or_(
                Buyer.source.is_(None),
                ~sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(
                    ["old_clients", *sorted(TARGETED_POOL_SOURCES)]
                ),
            )
        )

    candidates = q.order_by(Buyer.updated_at.desc()).limit(800).all()
    scored: list[tuple[Buyer, int]] = []
    for buyer in candidates:
        score = _score_pool_match(_buyer_match_blob(buyer), pool_key)
        if score >= min_score:
            scored.append((buyer, score))
    scored.sort(key=lambda item: (-item[1], item[0].id))

    lead_ids = [buyer.id for buyer, _ in scored[:limit]]
    if not lead_ids:
        return {
            "updated_count": 0,
            "updated_ids": [],
            "scanned": len(candidates),
            "from_source": origin,
            "pool": pool_key,
        }

    result = set_target_pool(
        db,
        lead_ids=lead_ids,
        source=pool_key,
        intake_method=intake_method,
    )
    log_action(
        db,
        entity_type="buyer",
        entity_id=0,
        action="populate_target_pool",
        details={
            "pool": pool_key,
            "from_source": origin,
            "scanned": len(candidates),
            "matched": len(lead_ids),
        },
    )
    return {
        **result,
        "scanned": len(candidates),
        "from_source": origin,
        "pool": pool_key,
    }


def classify_target_pools_from_old_clients(
    db: Session,
) -> dict[str, object]:
    """Move Old clients into Hyperstore / Distributor pools by keyword match."""
    old_buyers = (
        db.query(Buyer)
        .filter(Buyer.source == "old_clients")
        .all()
    )
    hyper_ids: list[int] = []
    dist_ids: list[int] = []

    for buyer in old_buyers:
        parts = [
            buyer.company_name or "",
            buyer.industry or "",
            buyer.remarks or "",
            buyer.address or "",
        ]
        blob = " ".join(parts).lower()
        hyper_score = _score_pool_match(blob, "hyperstore_targeted")
        dist_score = _score_pool_match(blob, "targeted_distributor")

        if hyper_score > 0 and hyper_score >= dist_score:
            hyper_ids.append(buyer.id)
        elif dist_score > 0:
            dist_ids.append(buyer.id)

    hyper_result = (
        set_target_pool(db, lead_ids=hyper_ids, source="hyperstore_targeted", intake_method="upload")
        if hyper_ids
        else {"updated_count": 0, "updated_ids": []}
    )
    dist_result = (
        set_target_pool(db, lead_ids=dist_ids, source="targeted_distributor", intake_method="upload")
        if dist_ids
        else {"updated_count": 0, "updated_ids": []}
    )

    if hyper_ids or dist_ids:
        from modules.audit import log_action

        log_action(
            db,
            entity_type="buyer",
            entity_id=0,
            action="classify_target_pools",
            details={
                "scanned": len(old_buyers),
                "hyperstore_moved": hyper_result.get("updated_count", 0),
                "distributor_moved": dist_result.get("updated_count", 0),
            },
        )

    return {
        "scanned": len(old_buyers),
        "hyperstore_targeted": hyper_result,
        "targeted_distributor": dist_result,
    }


def remove_from_target_pool(
    db: Session,
    *,
    lead_ids: list[int],
) -> dict[str, object]:
    """Move leads out of a targeted pool and return to old_clients or new search leads."""
    from modules.audit import log_action

    restored_ids: list[int] = []
    for lead_id in lead_ids:
        buyer = buyers_module.get_buyer(db, lead_id)
        if not buyer:
            continue
        norm = (buyer.source or "").strip().lower()
        if norm not in TARGETED_POOL_SOURCES:
            continue
        if (buyer.intake_method or "").strip().lower() == "upload":
            buyer.source = "old_clients"
        else:
            buyer.source = "discovery"
        buyer.intake_method = None
        restored_ids.append(lead_id)

    if restored_ids:
        invalidate_section_counts_cache()
        db.commit()
        log_action(
            db,
            entity_type="buyer",
            entity_id=0,
            action="remove_from_target_pool",
            details={"lead_ids": restored_ids},
        )

    return {"updated_count": len(restored_ids), "updated_ids": restored_ids}


def move_leads_to_module(
    db: Session,
    *,
    lead_ids: list[int],
    target_module: str,
    by_user_id: int | None = None,
) -> dict[str, object]:
    """Move a list of leads into any section/module (Khalid Focused, Call outcomes, Targeted Pools, Archives)."""
    from datetime import datetime
    from sqlalchemy import or_, func as sa_func
    from db.models import AppUser
    from modules.audit import log_action

    module = target_module.strip().lower()
    updated_ids: list[int] = []
    target_label = module.replace("_", " ").title()

    if module == "khalid_focused_sales":
        khalid_user = (
            db.query(AppUser)
            .filter(
                or_(
                    sa_func.lower(AppUser.username).like("%khalid%"),
                    sa_func.lower(AppUser.full_name).like("%khalid%"),
                )
            )
            .first()
        )
        khalid_id = khalid_user.id if khalid_user else 1
        khalid_name = khalid_user.username if khalid_user else "Mr. Khalid"
        for lead_id in lead_ids:
            buyer = buyers_module.get_buyer(db, lead_id)
            if buyer:
                buyer.source = "khalid_focused_sales"
                buyer.assigned_to_user_id = khalid_id
                buyer.assigned_to = khalid_name
                buyer.assigned_at = datetime.utcnow()
                if not buyer.master_type:
                    buyer.master_type = "fmcg"
                if not buyer.intake_method:
                    buyer.intake_method = "upload"
                updated_ids.append(lead_id)
        target_label = "Khalid Focused Sales"

    elif module in {
        "hyperstore_targeted",
        "targeted_distributor",
        "targeted_client",
        "incomplete_archives",
        "old_clients",
    }:
        for lead_id in lead_ids:
            buyer = buyers_module.get_buyer(db, lead_id)
            if buyer:
                buyer.source = module
                if not buyer.master_type:
                    buyer.master_type = "fmcg"
                if not buyer.intake_method:
                    buyer.intake_method = "upload"
                updated_ids.append(lead_id)
        labels = {
            "hyperstore_targeted": "Hyperstore Target",
            "targeted_distributor": "Targeted Distributors",
            "targeted_client": "Targeted Client",
            "incomplete_archives": "Incomplete Data from Archives",
            "old_clients": "Old clients",
        }
        target_label = labels.get(module, target_label)

    elif module == "interested_clients":
        from modules.calls import set_call_outcome

        for lead_id in lead_ids:
            buyer = buyers_module.get_buyer(db, lead_id)
            if buyer:
                buyer.interested_clients_list_at = datetime.utcnow()
                if not buyer.master_type:
                    buyer.master_type = "fmcg"
                set_call_outcome(db, buyer_id=lead_id, outcome="interested", by_user_id=by_user_id)
                updated_ids.append(lead_id)
        target_label = "Interested Clients"

    elif module == "follow_up_clients":
        from modules.calls import set_call_outcome

        for lead_id in lead_ids:
            buyer = buyers_module.get_buyer(db, lead_id)
            if buyer:
                if not buyer.master_type:
                    buyer.master_type = "fmcg"
                set_call_outcome(db, buyer_id=lead_id, outcome="callback", by_user_id=by_user_id)
                updated_ids.append(lead_id)
        target_label = "Follow up clients"

    elif module == "not_interested_clients":
        from modules.calls import set_call_outcome

        for lead_id in lead_ids:
            buyer = buyers_module.get_buyer(db, lead_id)
            if buyer:
                buyer.interested_clients_list_at = None
                if not buyer.master_type:
                    buyer.master_type = "fmcg"
                set_call_outcome(db, buyer_id=lead_id, outcome="not_interested", by_user_id=by_user_id)
                updated_ids.append(lead_id)
        target_label = "Not interested"

    elif module == "not_received_call_clients":
        from modules.calls import set_call_outcome

        for lead_id in lead_ids:
            buyer = buyers_module.get_buyer(db, lead_id)
            if buyer:
                if not buyer.master_type:
                    buyer.master_type = "fmcg"
                set_call_outcome(db, buyer_id=lead_id, outcome="no_response", by_user_id=by_user_id)
                updated_ids.append(lead_id)
        target_label = "Did not receive call"

    elif module == "master":
        for lead_id in lead_ids:
            buyer = buyers_module.get_buyer(db, lead_id)
            if buyer:
                if not buyer.source or buyer.source == "master":
                    buyer.source = "old_clients"
                if not buyer.master_type:
                    buyer.master_type = "fmcg"
                if not buyer.intake_method:
                    buyer.intake_method = "upload"
                updated_ids.append(lead_id)
        target_label = "Master Table (FMCG)"

    else:
        # Dynamic custom module (e.g. testing or user-created custom list)
        from db.models import CustomLeadModule

        for lead_id in lead_ids:
            buyer = buyers_module.get_buyer(db, lead_id)
            if buyer:
                buyer.source = module
                buyer.intake_method = "upload"
                if not buyer.master_type:
                    buyer.master_type = "fmcg"
                updated_ids.append(lead_id)
        cm = db.query(CustomLeadModule).filter(CustomLeadModule.key == module).first()
        if cm:
            target_label = cm.name

    if updated_ids:
        invalidate_section_counts_cache()
        db.commit()
        log_action(
            db,
            entity_type="buyer",
            entity_id=0,
            action="move_leads_to_module",
            details={
                "target_module": module,
                "target_label": target_label,
                "lead_ids": updated_ids,
            },
        )

    return {
        "updated_count": len(updated_ids),
        "target_module": module,
        "target_label": target_label,
    }
