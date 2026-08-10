#!/usr/bin/env sh
# Railway entrypoint: migrate once, then serve.
# Multiple uvicorn workers each run lifespan; running Alembic there races
# and can hang cold starts past Railway proxy timeout (browser sees CORS).
set -eu
cd "$(dirname "$0")"
attempt=1
while [ "$attempt" -le 5 ]; do
  if python -c "from db.migrate import run_migrations; run_migrations()"; then
    break
  fi
  if [ "$attempt" -eq 5 ]; then
    echo "Migrations failed after 5 attempts" >&2
    exit 1
  fi
  echo "Migration attempt $attempt failed; retrying in 15s..." >&2
  sleep 15
  attempt=$((attempt + 1))
done
export KAFI_SKIP_LIFESPAN_MIGRATE=1
# Single worker for reliability on typical Railway memory; scale later if needed.
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
