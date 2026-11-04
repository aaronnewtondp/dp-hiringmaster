#!/usr/bin/env bash
# A disposable, fully isolated HMS stack for the Playwright suite: its own Postgres (a throw-away container on tmpfs), its own backend
# process (from THIS checkout's backend/src) and its own Vite server. Several stacks can run side by side, one per index N (0..9), each from
# its own git worktree, without touching the developer's services (dp_hms_db :5432, dp_hms_backend :4000, Vite :5173, ci-eval-pg :55432).
#
#   bash scripts/test-stack.sh up      N [--no-frontend]   create / reuse the stack, print the three export lines
#   bash scripts/test-stack.sh down    N                   stop the processes, remove the container
#   bash scripts/test-stack.sh status  N                   what is running (exit 0 only when everything is healthy)
#   bash scripts/test-stack.sh env     N                   print the export lines (TEST_API_URL, TEST_FRONTEND_URL, TEST_DB_URL)
#   bash scripts/test-stack.sh preview N                   like `up`, but the frontend is a PRODUCTION BUILD served by `vite preview`
#                                                          (needed for the PWA / service-worker checks: dev mode registers no worker)
#   bash scripts/test-stack.sh restart N                   restart the BACKEND only (it does not watch files: do this after editing backend/src)
#   bash scripts/test-stack.sh reset   N                   recreate the database from schema.sql + seed.sql, then restart the backend
#
# Ports for index N:  database 55440+N   backend 4110+N   frontend 5180+N   (never 4000, 5173, 5432 or 55432: refused)
# Container: hms-pw-db-N.  State, logs and pid files: hms-tests-final/.stack/N/ (git-ignored).  `up` is idempotent: what is healthy is
# reused, what is not is restarted, and the DB is only rebuilt when it is missing or empty.
#
# Everything the backend needs is passed explicitly on an EMPTY environment (env -i): no ANTHROPIC_API_KEY, no Google credentials, no
# DATABASE_URL from the caller's shell and no backend/.env (dotenv is pointed at an empty file). A test that needs a key or Google is a
# @live test and is skipped unless TEST_LIVE=1.
#
# Written for bash 3.2 (macOS): no associative arrays, no mapfile, no ${var,,}.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TESTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd -P)"
BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"

# ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
DB_PORT_BASE=55440
API_PORT_BASE=4110
FE_PORT_BASE=5180
RESERVED_PORTS="4000 5173 5432 55432"   # the developer's own services: a stack must never bind, probe-kill or reuse these
DB_USER=hms_user
DB_PASSWORD=hms_password                # the db specs' defaults (tests/helpers/db.ts)
DB_NAME=dp_hms
DB_IMAGE=postgres:16-alpine

# Same dev values docker-compose.yml and tests/helpers/api.ts already carry in plaintext (public repo, local only).
DEV_JWT_SECRET=change_this_in_production_to_a_long_random_string
DEV_ROLE_INGEST_SECRET=22fc0ba4d5799b9fcfeb167b36820247264e87780571fa21566ce048d7b69400
DEV_CANDIDATE_INGEST_SECRET=e9ba2e63e3a1167ce31671ee98831a884efc7f7e35986e778e9fce72fea4ed3f
DEV_CRON_SECRET=local_dev_cron_secret_not_for_prod

die() { printf 'test-stack: %s\n' "$*" >&2; exit 1; }
log() { printf '[stack %s] %s\n' "${N:-?}" "$*" >&2; }

usage() {
  sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# ── Arguments ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CMD="${1:-}"
N="${2:-}"
NO_FRONTEND=0
case "$CMD" in
  up|down|status|env|preview|restart|reset) ;;
  -h|--help|help|"") usage ;;
  *) die "unknown command '$CMD' (up | down | status | env | preview | restart | reset)" ;;
esac
case "$N" in
  [0-9]) ;;
  *) die "stack index must be a single digit 0..9 (got '${N}')" ;;
esac
if [ "${3:-}" = "--no-frontend" ]; then NO_FRONTEND=1; elif [ -n "${3:-}" ]; then die "unknown option '${3}'"; fi

DB_PORT=$((DB_PORT_BASE + N))
API_PORT=$((API_PORT_BASE + N))
FE_PORT=$((FE_PORT_BASE + N))
for p in "$DB_PORT" "$API_PORT" "$FE_PORT"; do
  for r in $RESERVED_PORTS; do
    [ "$p" = "$r" ] && die "port $p is reserved for the developer's own services; refusing"
  done
done

DB_CONTAINER="hms-pw-db-$N"
STATE="$TESTS_DIR/.stack/$N"
API_URL="http://localhost:$API_PORT"
FE_URL="http://localhost:$FE_PORT"
DB_URL="postgresql://$DB_USER:$DB_PASSWORD@localhost:$DB_PORT/$DB_NAME"

print_env() {
  printf 'export TEST_API_URL=%s\n' "$API_URL"
  printf 'export TEST_FRONTEND_URL=%s\n' "$FE_URL"
  printf 'export TEST_DB_URL=%s\n' "$DB_URL"
}

# ── Process helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

read_pid() { [ -f "$1" ] && tr -d ' \n' < "$1" || true; }

proc_cwd() {
  if [ -d "/proc/$1" ]; then readlink "/proc/$1/cwd" 2>/dev/null || true; return 0; fi
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true
}

# A pid taken from a pid file is only ever signalled when it still IS the process we started: alive, leader of its own process group
# (we start every daemon under setsid) and running with the working directory of this checkout. A recycled pid fails these checks.
is_ours() {
  local pid="$1" want="$2" pgid
  pid_alive "$pid" || return 1
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [ "$pgid" = "$pid" ] || return 1
  [ "$(proc_cwd "$pid")" = "$want" ]
}

listener_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u || true; }

# Stop a daemon we started: its whole process group (tsx and vite spawn children), TERM first, KILL after ~5 s.
stop_daemon() {
  local pidfile="$1" want_cwd="$2" port="$3" what="$4" pid i lp
  pid="$(read_pid "$pidfile")"
  if [ -n "$pid" ]; then
    if is_ours "$pid" "$want_cwd"; then
      log "stopping $what (pid $pid)"
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      i=0
      while [ "$i" -lt 50 ] && pid_alive "$pid"; do sleep 0.1; i=$((i + 1)); done
      if pid_alive "$pid"; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi
    elif pid_alive "$pid"; then
      log "pid file for $what names pid $pid, which is not this stack's process any more; leaving it alone"
    fi
  fi
  rm -f "$pidfile"
  # a lost pid file: a listener on OUR port whose working directory is this checkout's is ours too
  for lp in $(listener_pids "$port"); do
    if [ "$(proc_cwd "$lp")" = "$want_cwd" ]; then
      log "stopping stray $what listener on :$port (pid $lp)"
      kill -TERM "$lp" 2>/dev/null || true
    fi
  done
}

# Start a command detached (own session: it survives the calling shell and the terminal), stdout+stderr appended to a log.
# Sets LAUNCHED_PID. perl, else python3, does the setsid; with neither the daemon still starts, but not as a group leader and `down`
# refuses to signal it (is_ours), so refuse to start at all.
SETSID_CMD=""
detect_setsid() {
  if command -v perl >/dev/null 2>&1; then SETSID_CMD=perl
  elif command -v python3 >/dev/null 2>&1; then SETSID_CMD=python3
  else die "need perl or python3 to start detached processes"
  fi
}
launch_detached() {
  local logfile="$1" cwd="$2"; shift 2
  if [ "$SETSID_CMD" = perl ]; then
    ( cd "$cwd" && exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec failed: $!"' "$@" ) </dev/null >>"$logfile" 2>&1 &
  else
    ( cd "$cwd" && exec python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" ) </dev/null >>"$logfile" 2>&1 &
  fi
  LAUNCHED_PID=$!
}

http_ok() { curl -fsS --max-time 4 -o /dev/null "$1" 2>/dev/null; }

wait_http() { # url, pid, seconds, what, log file name (under $STATE)
  local url="$1" pid="$2" secs="$3" what="$4" logf="$5" i=0
  while [ "$i" -lt "$secs" ]; do
    http_ok "$url" && return 0
    pid_alive "$pid" || { log "$what exited while starting; last log lines:"; tail -n 25 "$STATE/$logf" >&2 || true; return 1; }
    sleep 1; i=$((i + 1))
  done
  log "$what did not answer $url within ${secs}s"
  return 1
}

# ── Locking: one mutating command per stack at a time ────────────────────────────────────────────────────────────────────────────
LOCK_DIR=""
take_lock() {
  mkdir -p "$STATE"
  LOCK_DIR="$STATE/.lock"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    die "another test-stack command is running for stack $N (if none is, remove $LOCK_DIR)"
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
}

# ── node_modules: symlinked from the main checkout, never copied ─────────────────────────────────────────────────────────────────
ensure_node_modules() {
  local common main d
  common="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir 2>/dev/null)" || return 0
  main="$(cd "$REPO_ROOT" && cd "$common/.." && pwd -P)"
  [ "$main" = "$REPO_ROOT" ] && return 0
  for d in backend frontend hms-tests-final; do
    if [ ! -e "$REPO_ROOT/$d/node_modules" ] && [ -d "$main/$d/node_modules" ]; then
      ln -s "$main/$d/node_modules" "$REPO_ROOT/$d/node_modules"
      log "linked $d/node_modules -> $main/$d/node_modules (untracked; never commit it)"
    fi
  done
  [ -e "$BACKEND_DIR/node_modules/.bin/tsx" ] || die "backend/node_modules/.bin/tsx is missing (run npm ci in backend/ of the main checkout)"
}

# ── Database ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "docker is not running"
}

# psql_in reads a script on stdin; psql_q runs a query and never touches stdin.
psql_in() { docker exec -i -e PGPASSWORD="$DB_PASSWORD" -e PGOPTIONS='-c client_min_messages=warning' "$DB_CONTAINER" \
  psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_q() { docker exec -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" "$@" </dev/null; }

db_container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null || true)" = "true" ]; }

# TCP, not the socket: the image's entrypoint runs a temporary socket-only server during init, which pg_isready over the socket accepts.
db_accepts_connections() { docker exec "$DB_CONTAINER" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; }

# Healthy = running, accepting TCP connections, seeded (>= 7 roles) and the sequence workaround applied.
db_ready() {
  db_container_running && db_accepts_connections || return 1
  [ "$(psql_q -tAc "SELECT (SELECT count(*) FROM roles) >= 7 AND to_regclass('public.seq_eval_question') IS NOT NULL AND (SELECT last_value FROM seq_eval_question) >= 13" 2>/dev/null | tr -d ' \n' || true)" = "t" ]
}

db_create() {
  log "creating $DB_CONTAINER ($DB_IMAGE, data on tmpfs) on 127.0.0.1:$DB_PORT"
  docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$DB_CONTAINER" --label hms-pw-stack="$N" \
    -p "127.0.0.1:$DB_PORT:5432" \
    -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB="$DB_NAME" \
    --tmpfs /var/lib/postgresql/data:rw,size=1g \
    "$DB_IMAGE" \
    -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200 >/dev/null \
    || die "could not start $DB_CONTAINER (is port $DB_PORT free?)"

  local i=0
  until db_accepts_connections; do
    i=$((i + 1))
    [ "$i" -le 60 ] || { docker logs --tail 20 "$DB_CONTAINER" >&2 || true; die "postgres did not become ready in 60 s"; }
    sleep 1
  done

  log "applying backend/src/db/schema.sql"
  psql_in -v ON_ERROR_STOP=1 -q -f - < "$REPO_ROOT/backend/src/db/schema.sql" >/dev/null \
    || die "schema.sql failed to apply"

  log "applying backend/src/db/seed.sql"
  local err; err="$(mktemp "${TMPDIR:-/tmp}/stack-seed.XXXXXX")"
  if psql_in -v ON_ERROR_STOP=1 -q -f - < "$REPO_ROOT/backend/src/db/seed.sql" >/dev/null 2>"$err"; then
    :
  else
    # KNOWN DEFECT in seed.sql (reported, not fixed here): on an EMPTY database its closing block runs
    # setval('seq_candidate', COALESCE(MAX(...), 0)) and 0 is below the sequence minimum, so psql stops there. Everything above it has
    # already committed, and the setvals after it (seq_application, seq_interview, seq_agency, seq_assignment, seq_refcheck) are
    # no-ops on a fresh database: those sequences START at their right values. docker-compose's init (ON_ERROR_STOP) dies on exactly
    # this line. This script tolerates EXACTLY that one error; any other error in seed.sql still fails the stack.
    local n_err; n_err="$(grep -c 'ERROR:' "$err" || true)"
    if [ "$n_err" -eq 1 ] && grep -q -F 'setval: value 0 is out of bounds for sequence' "$err"; then
      log "seed.sql stopped at its known closing setval(seq_candidate, 0) error (data is committed); continuing"
    else
      cat "$err" >&2; rm -f "$err"; die "seed.sql failed with an unexpected error"
    fi
  fi
  rm -f "$err"

  # Workaround for the second known seed defect: seed.sql inserts Q001-Q013 and BEN001-BEN012 with explicit ids but never advances
  # seq_eval_question / seq_comp_benchmark (schema.sql's "START 14" / "START 13" are CREATE SEQUENCE IF NOT EXISTS, so they do nothing
  # after the earlier "START 1"), so the first insert that relies on the default id collides on the primary key. Same fix the CI branch uses.
  log "advancing seq_eval_question / seq_comp_benchmark past the seeded ids"
  psql_in -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL' || die "sequence workaround failed"
SELECT setval('seq_eval_question',  (SELECT MAX(substring(id from '[0-9]+')::int) FROM eval_questions));
SELECT setval('seq_comp_benchmark', (SELECT MAX(substring(id from '[0-9]+')::int) FROM comp_benchmarks));
SQL
  db_ready || die "the database is up but did not pass the readiness check after seeding"
  DB_RECREATED=1
}

DB_RECREATED=0
ensure_db() {
  if db_ready; then
    log "database $DB_CONTAINER is healthy; reusing it"
    return 0
  fi
  if ! db_container_running && [ -n "$(listener_pids "$DB_PORT")" ]; then
    die "port $DB_PORT is in use by something that is not $DB_CONTAINER"
  fi
  db_create
}

# ── Backend ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
backend_pid() { read_pid "$STATE/backend.pid"; }

backend_healthy() {
  local pid; pid="$(backend_pid)"
  [ -n "$pid" ] && is_ours "$pid" "$BACKEND_DIR" && http_ok "$API_URL/health"
}

stop_backend() { stop_daemon "$STATE/backend.pid" "$BACKEND_DIR" "$API_PORT" backend; }

start_backend() {
  if [ -n "$(listener_pids "$API_PORT")" ]; then
    die "port $API_PORT is already in use by a process that is not this stack's backend"
  fi
  : > "$STATE/empty.env"
  log "starting the backend from $BACKEND_DIR on :$API_PORT (log: $STATE/backend.log)"
  : > "$STATE/backend.log"
  # TZ=UTC like the docker-compose backend container and Vercel: node-pg parses a DATE column as LOCAL midnight, so on a host in IST a
  # `DATE` such as approval_date or offer_sent_date serialises as the PREVIOUS day in JSON (found when 3 api specs failed on an IST laptop).
  launch_detached "$STATE/backend.log" "$BACKEND_DIR" \
    env -i \
      PATH="$PATH" HOME="${HOME:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" TZ=UTC \
      NODE_ENV=development PORT="$API_PORT" \
      DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:$DB_PORT/$DB_NAME" \
      FRONTEND_URL="$FE_URL" SOURCING_ENABLED="${STACK_SOURCING_ENABLED:-true}" \
      JWT_SECRET="$DEV_JWT_SECRET" JWT_EXPIRES_IN=24h \
      ROLE_INGEST_SECRET="$DEV_ROLE_INGEST_SECRET" CANDIDATE_INGEST_SECRET="$DEV_CANDIDATE_INGEST_SECRET" CRON_SECRET="$DEV_CRON_SECRET" \
      DOTENV_CONFIG_PATH="$STATE/empty.env" \
      ./node_modules/.bin/tsx src/server.ts
  printf '%s\n' "$LAUNCHED_PID" > "$STATE/backend.pid"
  wait_http "$API_URL/health" "$LAUNCHED_PID" 90 backend backend.log || die "the backend did not start (see $STATE/backend.log)"
  log "backend healthy at $API_URL (pid $LAUNCHED_PID)"
}

ensure_backend() {
  if [ "$DB_RECREATED" = 0 ] && backend_healthy; then
    log "backend is healthy; reusing it"
    return 0
  fi
  stop_backend
  start_backend
}

# ── Frontend ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
frontend_pid() { read_pid "$STATE/frontend.pid"; }
frontend_mode() { cat "$STATE/frontend.mode" 2>/dev/null || true; }

frontend_healthy() { # mode
  local pid; pid="$(frontend_pid)"
  [ -n "$pid" ] && is_ours "$pid" "$FRONTEND_DIR" && [ "$(frontend_mode)" = "$1" ] && http_ok "$FE_URL/"
}

stop_frontend() { stop_daemon "$STATE/frontend.pid" "$FRONTEND_DIR" "$FE_PORT" frontend; rm -f "$STATE/frontend.mode"; }

# Vite runs on an empty environment too (only PATH/HOME/TMPDIR and this stack's VITE_API_URL), through stack-vite.mjs (see its header).
launch_vite() { # logfile, then stack-vite.mjs arguments
  local logfile="$1"; shift
  launch_detached "$logfile" "$FRONTEND_DIR" \
    env -i PATH="$PATH" HOME="${HOME:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" VITE_API_URL="$API_URL/api" \
    node "$SCRIPT_DIR/stack-vite.mjs" "$@"
}

start_frontend() { # mode: dev | preview
  local mode="$1"
  [ -e "$FRONTEND_DIR/node_modules/vite/package.json" ] || die "frontend/node_modules/vite is missing (run npm ci in frontend/ of the main checkout)"
  if [ -n "$(listener_pids "$FE_PORT")" ]; then
    die "port $FE_PORT is already in use by a process that is not this stack's frontend"
  fi
  : > "$STATE/frontend.log"
  if [ "$mode" = preview ]; then
    build_frontend
    log "starting vite preview from $FRONTEND_DIR on :$FE_PORT (log: $STATE/frontend.log)"
    launch_vite "$STATE/frontend.log" preview --root "$FRONTEND_DIR" --port "$FE_PORT" --out-dir "$STATE/dist" --cache-dir "$STATE/vite-cache"
  else
    log "starting vite (dev) from $FRONTEND_DIR on :$FE_PORT (log: $STATE/frontend.log)"
    launch_vite "$STATE/frontend.log" dev --root "$FRONTEND_DIR" --port "$FE_PORT" --cache-dir "$STATE/vite-cache"
  fi
  printf '%s\n' "$LAUNCHED_PID" > "$STATE/frontend.pid"
  printf '%s\n' "$mode" > "$STATE/frontend.mode"
  wait_http "$FE_URL/" "$LAUNCHED_PID" 90 frontend frontend.log || die "the frontend did not start (see $STATE/frontend.log)"
  log "frontend ($mode) healthy at $FE_URL (pid $LAUNCHED_PID)"
}

# A production build (the VITE_API_URL of this stack is baked in) into .stack/N/dist; rebuilt only when the sources are newer.
build_frontend() {
  local marker="$STATE/dist/index.html"
  if [ -f "$marker" ] && [ -z "$(find "$FRONTEND_DIR/src" "$FRONTEND_DIR/public" "$FRONTEND_DIR/index.html" "$FRONTEND_DIR/vite.config.ts" "$FRONTEND_DIR/package.json" -newer "$marker" -print -quit 2>/dev/null)" ] \
     && [ "$(cat "$STATE/dist/.api-url" 2>/dev/null || true)" = "$API_URL/api" ]; then
    log "the production build in $STATE/dist is up to date"
    return 0
  fi
  log "building the frontend for preview (API $API_URL/api) into $STATE/dist"
  ( cd "$FRONTEND_DIR" && env -i PATH="$PATH" HOME="${HOME:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" VITE_API_URL="$API_URL/api" \
      node "$SCRIPT_DIR/stack-vite.mjs" build --root "$FRONTEND_DIR" --out-dir "$STATE/dist" --cache-dir "$STATE/vite-cache" ) >"$STATE/frontend-build.log" 2>&1 \
    || { tail -n 30 "$STATE/frontend-build.log" >&2; die "frontend build failed (see $STATE/frontend-build.log)"; }
  printf '%s\n' "$API_URL/api" > "$STATE/dist/.api-url"
}

ensure_frontend() { # mode
  local mode="$1"
  if frontend_healthy "$mode"; then
    log "frontend ($mode) is healthy; reusing it"
    return 0
  fi
  stop_frontend
  start_frontend "$mode"
}

# ── Commands ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
cmd_up() { # mode
  need_docker
  detect_setsid
  ensure_node_modules
  take_lock
  ensure_db
  ensure_backend
  if [ "$NO_FRONTEND" = 0 ]; then ensure_frontend "$1"; fi
  log "stack $N is up (frontend mode: $([ "$NO_FRONTEND" = 1 ] && echo none || echo "$1"))"
  print_env
}

cmd_down() {
  need_docker
  mkdir -p "$STATE"
  take_lock
  stop_frontend
  stop_backend
  if docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    log "removing $DB_CONTAINER"
    docker rm -f "$DB_CONTAINER" >/dev/null
  fi
  rm -rf "$STATE/dist" "$STATE/vite-cache" "$STATE/empty.env"
  log "stack $N is down (logs kept in $STATE)"
}

cmd_restart() {
  need_docker
  detect_setsid
  ensure_node_modules
  take_lock
  db_ready || die "the database of stack $N is not ready; run: bash scripts/test-stack.sh up $N"
  stop_backend
  start_backend
}

cmd_reset() {
  need_docker
  detect_setsid
  ensure_node_modules
  take_lock
  stop_backend
  db_create
  start_backend
}

cmd_status() {
  need_docker
  local bad=0 pid
  if db_ready; then printf 'database  ok       %s  (container %s, 127.0.0.1:%s)\n' "$DB_URL" "$DB_CONTAINER" "$DB_PORT"
  elif db_container_running; then printf 'database  UNREADY  container %s is running but not healthy and seeded\n' "$DB_CONTAINER"; bad=1
  else printf 'database  DOWN     no running container %s\n' "$DB_CONTAINER"; bad=1; fi
  pid="$(backend_pid)"
  if backend_healthy; then printf 'backend   ok       %s  (pid %s)\n' "$API_URL" "$pid"
  else printf 'backend   DOWN     %s\n' "$API_URL"; bad=1; fi
  pid="$(frontend_pid)"
  if frontend_healthy "$(frontend_mode)"; then printf 'frontend  ok       %s  (%s, pid %s)\n' "$FE_URL" "$(frontend_mode)" "$pid"
  else printf 'frontend  DOWN     %s\n' "$FE_URL"; bad=1; fi
  return "$bad"
}

case "$CMD" in
  up)      cmd_up dev ;;
  preview) cmd_up preview ;;
  down)    cmd_down ;;
  status)  cmd_status ;;
  env)     print_env ;;
  restart) cmd_restart ;;
  reset)   cmd_reset ;;
esac
