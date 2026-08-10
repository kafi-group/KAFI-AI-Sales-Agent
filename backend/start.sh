#!/usr/bin/env sh
# Railway entrypoint: migrate once, then serve.
# Multiple uvicorn workers each run lifespan; running Alembic there races
# and can hang cold starts past Railway proxy timeout (browser sees CORS).
set -eu
cd "$(dirname "$0")"
python -c "from db.migrate import run_migrations; run_migrations()"
export KAFI_SKIP_LIFESPAN_MIGRATE=1
# Single worker for reliability on typical Railway memory; scale later if needed.
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
