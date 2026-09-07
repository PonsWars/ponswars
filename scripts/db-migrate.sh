#!/usr/bin/env bash
#
# Applies every migration to the local development database, in order.
#
# Each file is already wrapped in BEGIN/COMMIT, and psql runs with
# ON_ERROR_STOP so a failure aborts rather than leaving a half-built schema.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="${PONSWARS_PG_CONTAINER:-ponswars-postgres}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Postgres container '$CONTAINER' is not running." >&2
  echo "Start it with: docker compose -f infra/containers/docker-compose.yml up -d" >&2
  exit 1
fi

for file in database/migrations/*.sql; do
  printf '==> %s\n' "$file"
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U ponswars -d ponswars < "$file"
done

echo
echo "All migrations applied."
