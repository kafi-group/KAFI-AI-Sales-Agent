"""Apply pending Alembic migrations. Safe to run on every startup — no-op if already up to date."""

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, text

from db.session import engine

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_MIGRATIONS_DIR = _BACKEND_DIR / "db" / "migrations"
_VERSIONS_DIR = _MIGRATIONS_DIR / "versions"


def _alembic_config() -> Config:
    """Use absolute paths so migrations work regardless of process cwd (e.g. Railway)."""
    cfg = Config(str(_BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(_MIGRATIONS_DIR))
    return cfg


def _revision_known(script: ScriptDirectory, revision_id: str) -> bool:
    try:
        script.get_revision(revision_id)
        return True
    except Exception:
        return False


def _reconcile_unknown_db_revisions(alembic_cfg: Config, script: ScriptDirectory) -> None:
    """If the DB was migrated on a newer deploy, reset to this build's head."""
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT version_num FROM alembic_version")).fetchall()

    unknown = [db_rev for (db_rev,) in rows if not _revision_known(script, db_rev)]
    if not unknown:
        return

    script_head = script.get_current_head()
    print(
        "Database alembic revision(s) not present in this deployment: "
        f"{', '.join(unknown)}. Resetting alembic_version to {script_head!r}.",
        flush=True,
    )
    # command.stamp() fails when the DB points at a revision missing from this codebase.
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM alembic_version"))
        conn.execute(
            text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
            {"v": script_head},
        )


def _stamp_head_if_interested_columns_already_applied(
    alembic_cfg: Config, script: ScriptDirectory
) -> None:
    """Avoid re-running 014 when the schema was applied on a prior deploy."""
    head = script.get_current_head()
    if head != "014_interested_follow_up":
        return

    inspector = inspect(engine)
    if "buyers" not in inspector.get_table_names():
        return

    existing = {column["name"] for column in inspector.get_columns("buyers")}
    if not {"interested_at", "interested_follow_up_ack_at"}.issubset(existing):
        return

    with engine.connect() as conn:
        current = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()

    if current == head:
        return

    print(
        "Interested-follow-up columns already exist; stamping alembic to "
        f"{head!r} without re-applying migration.",
        flush=True,
    )
    command.stamp(alembic_cfg, head)


def _ensure_buyer_social_columns() -> None:
    """Idempotent guard when alembic_version is ahead of the live schema."""
    inspector = inspect(engine)
    if "buyers" not in inspector.get_table_names():
        return

    existing = {column["name"] for column in inspector.get_columns("buyers")}
    statements: list[str] = []
    if "facebook_company_url" not in existing:
        statements.append(
            "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS facebook_company_url VARCHAR(512)"
        )
    if "instagram_company_url" not in existing:
        statements.append(
            "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS instagram_company_url VARCHAR(512)"
        )

    if not statements:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
    print("Applied missing buyer social URL columns.")


def _ensure_horeka_table() -> None:
    """Ensure horeka_line_items table exists."""
    from db.models import Base
    inspector = inspect(engine)
    if "horeka_line_items" not in inspector.get_table_names():
        Base.metadata.tables["horeka_line_items"].create(engine, checkfirst=True)
        print("Created horeka_line_items table.", flush=True)


def _ensure_custom_lead_modules_table() -> None:
    """Ensure custom_lead_modules table exists and seed initial default modules."""
    from db.models import Base, CustomLeadModule
    from db.session import SessionLocal

    inspector = inspect(engine)
    if "custom_lead_modules" not in inspector.get_table_names():
        Base.metadata.tables["custom_lead_modules"].create(engine, checkfirst=True)
        print("Created custom_lead_modules table.", flush=True)

    # Seed initial modules if empty
    db = SessionLocal()
    try:
        count = db.query(CustomLeadModule).count()
        if count == 0:
            defaults = [
                CustomLeadModule(
                    key="testing",
                    name="Testing",
                    description="Kafi Commodities staff numbers & emails for daily morning bulk testing",
                    icon="🧪",
                    color="#10b981",
                    is_builtin=False,
                    is_enabled=True,
                    order_index=1,
                ),
                CustomLeadModule(
                    key="khalid_focused_sales",
                    name="Khalid Focused Sales",
                    description="Leads specially selected for Mr. Khalid's focused sales outreach",
                    icon="⭐",
                    color="#f59e0b",
                    is_builtin=True,
                    is_enabled=True,
                    order_index=2,
                ),
                CustomLeadModule(
                    key="interested_clients",
                    name="Follow up clients",
                    description="Clients moved here after a call is labeled Follow up",
                    icon="🕒",
                    color="#3b82f6",
                    is_builtin=True,
                    is_enabled=True,
                    order_index=3,
                ),
                CustomLeadModule(
                    key="sales_interested_clients",
                    name="Interested Clients",
                    description="Clients confirmed interested in Kafi products",
                    icon="❤️",
                    color="#ef4444",
                    is_builtin=True,
                    is_enabled=True,
                    order_index=4,
                ),
                CustomLeadModule(
                    key="not_interested_clients",
                    name="Not interested",
                    description="Clients marked not interested",
                    icon="🚫",
                    color="#6b7280",
                    is_builtin=True,
                    is_enabled=True,
                    order_index=5,
                ),
                CustomLeadModule(
                    key="not_received_call_clients",
                    name="Did not receive call",
                    description="Clients who did not answer the phone",
                    icon="📞",
                    color="#8b5cf6",
                    is_builtin=True,
                    is_enabled=True,
                    order_index=6,
                ),
                CustomLeadModule(
                    key="hyperstore_targeted",
                    name="Hyperstore Target",
                    description="Hypermarkets and multi-branch retail chains",
                    icon="🛒",
                    color="#10b981",
                    is_builtin=True,
                    is_enabled=True,
                    order_index=7,
                ),
                CustomLeadModule(
                    key="targeted_distributor",
                    name="Targeted Distributors",
                    description="Distributors and wholesale importers",
                    icon="🏢",
                    color="#6366f1",
                    is_builtin=True,
                    is_enabled=True,
                    order_index=8,
                ),
                CustomLeadModule(
                    key="targeted_client",
                    name="Targeted Client",
                    description="Hand-picked priority target clients",
                    icon="🎯",
                    color="#ec4899",
                    is_builtin=True,
                    is_enabled=True,
                    order_index=9,
                ),
                CustomLeadModule(
                    key="incomplete_archives",
                    name="Incomplete Data from Archives",
                    description="Partial rows from archives needing research",
                    icon="📦",
                    color="#d97706",
                    is_builtin=True,
                    is_enabled=True,
                    order_index=10,
                ),
            ]
            db.add_all(defaults)
            db.commit()
            print("Seeded default custom lead modules.", flush=True)
    except Exception as exc:
        print(f"Error seeding custom lead modules: {exc}", flush=True)
        db.rollback()
    finally:
        db.close()


def _ensure_target_workspace_tables() -> None:
    """Ensure Target and Workspace module tables exist and seed initial defaults."""
    from db.models import Base
    from db.session import SessionLocal
    from modules import target_workspace as tw_module

    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()

    for tbl_name in ["day_country_targets", "workspace_lead_lifecycles", "drip_campaign_leads", "workspace_review_options"]:
        if tbl_name not in existing_tables and tbl_name in Base.metadata.tables:
            Base.metadata.tables[tbl_name].create(engine, checkfirst=True)
            print(f"Created {tbl_name} table.", flush=True)

    db = SessionLocal()
    try:
        tw_module.seed_default_review_options(db)
        tw_module.seed_default_day_targets(db)
    except Exception as exc:
        print(f"Target workspace table init note: {exc}", flush=True)
        db.rollback()
    finally:
        db.close()


def _ensure_ai_training_selected_column() -> None:
    """Idempotent: add interactions.ai_training_selected if Alembic lagged behind deploy."""
    inspector = inspect(engine)
    if "interactions" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("interactions")}
    if "ai_training_selected" in existing:
        return
    with engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE interactions "
                "ADD COLUMN IF NOT EXISTS ai_training_selected BOOLEAN NOT NULL DEFAULT FALSE"
            )
        )
    print("Applied missing interactions.ai_training_selected column.", flush=True)


def run_migrations() -> None:
    alembic_cfg = _alembic_config()
    script = ScriptDirectory.from_config(alembic_cfg)
    migration_files = sorted(p.name for p in _VERSIONS_DIR.glob("*.py") if p.name != "__init__.py")
    print(
        f"Alembic script head: {script.get_current_head()} "
        f"({len(migration_files)} migration files in {_VERSIONS_DIR})",
        flush=True,
    )
    _reconcile_unknown_db_revisions(alembic_cfg, script)
    _stamp_head_if_interested_columns_already_applied(alembic_cfg, script)
    command.upgrade(alembic_cfg, "head")
    _ensure_buyer_social_columns()
    _ensure_ai_training_selected_column()
    _ensure_horeka_table()
    _ensure_custom_lead_modules_table()
    _ensure_target_workspace_tables()

