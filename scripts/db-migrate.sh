#!/usr/bin/env bash
#
# Applies every migration to the local development database.
#
# The same runner a deployment uses (`apps/server/src/migrate.ts`), so a
# developer's database and a deployed one are built by the same thing. There
# used to be two ways to apply a migration here — this script piping files into
# `psql`, and the deployment's job — and the two disagreed: files applied by the
# first were invisible to the ledger the second keeps, so pointing the runner at
# a database migrated by hand tried to create every type again.
set -euo pipefail

cd "$(dirname "$0")/.."

# The development compose file's credentials (infra/containers/docker-compose.yml).
# A development address, not a production one: a deployment sets DATABASE_URL.
: "${DATABASE_URL:=postgres://ponswars:ponswars_dev_only@localhost:5432/ponswars}"
export DATABASE_URL

if [ ! -f apps/server/dist/migrate.js ]; then
  echo "==> building the migration runner"
  pnpm exec tsc -b apps/server/tsconfig.build.json
fi

node apps/server/dist/migrate.js database/migrations
