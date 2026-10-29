#!/usr/bin/env bash
# Build an HMS database from nothing: backend/src/db/schema.sql, then backend/src/db/seed.sql.
# Target = the standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE). The database must exist and be empty.
#
# Strict like docker-compose's init (psql -v ON_ERROR_STOP=1), with ONE narrow exception, below.
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
err="$(mktemp)"
trap 'rm -f "$err"' EXIT
if psql -v ON_ERROR_STOP=1 -q -f "$seed" >/dev/null 2>"$err"; then
  echo "seed.sql applied cleanly"
else
  # KNOWN DEFECT, reported and not fixed here (CI may not edit backend/src): on an EMPTY database the closing block of
  # seed.sql calls setval('seq_candidate', COALESCE(MAX(...), 0)) and 0 is below the sequence minimum, so psql stops there.
  # Everything above it has already committed. docker-compose's init (ON_ERROR_STOP) dies on exactly this line, while
  # `npm run db:reset` (no ON_ERROR_STOP) prints the error and carries on. We accept ONLY that one error; any other
  # error in seed.sql still fails the job.
  known='setval: value 0 is out of bounds for sequence'
  n_errors="$(grep -c 'ERROR:' "$err" || true)"
  if [ "$n_errors" -eq 1 ] && grep -q -F "$known" "$err"; then
    echo "::warning title=Known defect in seed.sql::seed.sql stops at its closing setval block on an empty database (setval(seq, 0) is out of bounds). docker-compose up on a fresh volume fails here. Finishing the way db:reset does."
    # Finish like db:reset: the data block is one transaction that now aborts on its duplicate key, then every setval runs.
    psql -q -f "$seed" >/dev/null 2>&1 || true
  else
    echo "::error title=seed.sql failed::unexpected error while applying seed.sql"
    cat "$err" >&2
    exit 1
  fi
fi
echo "::endgroup::"
