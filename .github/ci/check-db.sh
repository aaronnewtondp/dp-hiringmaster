#!/usr/bin/env bash
# Guards for a database that apply-db.sh has just built. Same PG* variables as apply-db.sh.
#   1. format_seq_id exists and behaves (no LPAD truncation, one nextval per id)
#   2. db-guards.sql: every prefixed-id sequence is ahead of its table, none shared, no lpad+nextval defaults
#   3. an informational (never failing) probe of whether schema.sql / seed.sql can be applied a second time
# Findings listed in known-db-defects.txt are warnings; anything else fails.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

echo "::group::format_seq_id exists and behaves"
exists="$(psql -At -c "SELECT to_regprocedure('format_seq_id(regclass,text,integer)') IS NOT NULL")"
if [ "$exists" != "t" ]; then
  echo "::error title=format_seq_id missing::function format_seq_id(regclass, text, integer) does not exist (schema.sql defines it; every prefixed id depends on it)"
  exit 1
fi
if ! probe_out="$(psql -v ON_ERROR_STOP=1 -q -f "$here/format-seq-id-probe.sql" 2>&1)"; then
  echo "::error title=format_seq_id regression::$(printf '%s' "$probe_out" | grep -m1 'ERROR:' | sed 's/^.*ERROR:[[:space:]]*//')"
  printf '%s\n' "$probe_out" >&2
  exit 1
fi
echo "format_seq_id behaves"
echo "::endgroup::"

echo "::group::Sequence and id-default guards"
findings="$(mktemp)"
trap 'rm -f "$findings"' EXIT
psql -v ON_ERROR_STOP=1 -At -F '|' -f "$here/db-guards.sql" > "$findings"

known_clean="$(mktemp)"
matched_known="$(mktemp)"
trap 'rm -f "$findings" "$known_clean" "$matched_known"' EXIT
# Comments and blank lines out, once, into a file: a single grep per lookup (a "grep | grep -q" pipeline is racy under pipefail).
sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$here/known-db-defects.txt" > "$known_clean"
failures=0
warnings=0

while IFS='|' read -r kind subject detail; do
  [ -n "$kind" ] || continue
  if grep -q -x -F "$kind $subject" "$known_clean"; then
    warnings=$((warnings + 1))
    echo "$kind $subject" >> "$matched_known"
    echo "::warning title=Known database defect ($kind)::$detail  [listed in .github/ci/known-db-defects.txt]"
  else
    failures=$((failures + 1))
    echo "::error title=Database guard ($kind)::$detail"
  fi
done < "$findings"

# A known defect that no longer shows up has been fixed: say so, so the list shrinks.
while read -r kind subject; do
  [ -n "$kind" ] || continue
  if ! grep -q -x -F "$kind $subject" "$matched_known"; then
    echo "::notice title=Known defect is gone::'$kind $subject' no longer fails. Delete its line from .github/ci/known-db-defects.txt."
  fi
done < "$known_clean"
echo "findings: $failures new, $warnings known"
echo "::endgroup::"

# ---- informational: can the two files be applied a SECOND time? (neither can today; nothing here fails the job) ----
{
  echo "### Re-apply probe (informational)"
  echo
  echo "| File | Second apply |"
  echo "|---|---|"
} >> "$summary"
probe() { # $1 label, $2 file
  local out rc=0
  out="$(psql -v ON_ERROR_STOP=1 -q -f "$2" 2>&1 >/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "| $1 | clean (idempotent) |" >> "$summary"
  else
    echo "| $1 | fails: $(printf '%s' "$out" | grep -m1 'ERROR:' | sed 's/|/\\|/g') |" >> "$summary"
  fi
}
probe "backend/src/db/schema.sql" "$repo/backend/src/db/schema.sql"
probe "backend/src/db/seed.sql" "$repo/backend/src/db/seed.sql"

if [ "$failures" -gt 0 ]; then
  echo "::error::$failures new database guard finding(s)"
  exit 1
fi
