#!/usr/bin/env bash
# Build an HMS database from nothing: backend/src/db/schema.sql, then backend/src/db/seed.sql.
# Target = the standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE). The database must exist and be empty.
#
# Strict like docker-compose's init (psql -v ON_ERROR_STOP=1): any error in either file fails the job.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
schema="$repo/backend/src/db/schema.sql"
seed="$repo/backend/src/db/seed.sql"

# schema.sql is full of "already exists, skipping" notices by design; keep the log readable.
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

echo "::group::Apply schema.sql"
psql -v ON_ERROR_STOP=1 -q -f "$schema"
echo "::endgroup::"

echo "::group::Apply seed.sql"
psql -v ON_ERROR_STOP=1 -q -f "$seed" >/dev/null
echo "::endgroup::"
