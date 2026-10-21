-- WHEN TO USE: only to remove the Sourcing module from a database (e.g. Supabase) once SOURCING_ENABLED is false and redeployed and you want the 10 sourcing_* tables gone; it refuses to run while any of them holds a row. Not needed to switch the module off.
-- ROLLBACK of the Sourcing module tables (10 x sourcing_*: the original 8, plus sourcing_channel_weeks and sourcing_advice from the
-- 21 Oct 2026 workspace release). No CASCADE anywhere.
BEGIN;

-- Fail fast instead of queueing behind a long transaction on roles/users
-- (dropping a table that holds foreign keys briefly locks the tables they point at).
SET LOCAL lock_timeout = '5s';

-- Safety guard: refuse to drop if any sourcing table now holds data.
-- (Delete this DO block only if you have decided to discard that data.)
DO $guard$
DECLARE
  t text;
  n bigint;
  total bigint := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sourcing_evidence','sourcing_commitment_log','sourcing_commitments',
    'sourcing_channel_weeks','sourcing_advice',
    'sourcing_plan_channels','sourcing_exceptions','sourcing_plan_changes',
    'sourcing_plans','sourcing_settings'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN
        RAISE WARNING 'public.% holds % row(s)', t, n;
      END IF;
      total := total + n;
    END IF;
  END LOOP;
  IF total > 0 THEN
    RAISE EXCEPTION 'Rollback aborted: sourcing tables hold % row(s) in total. Export them first, or remove this guard to discard them.', total;
  END IF;
END
$guard$;

-- Children before parents (RESTRICT is the default: if anything outside this list
-- still depended on one of these tables, the statement errors instead of cascading).
DROP TABLE IF EXISTS public.sourcing_evidence;        -- FK -> sourcing_commitment_log
DROP TABLE IF EXISTS public.sourcing_commitment_log;  -- FK -> sourcing_commitments
DROP TABLE IF EXISTS public.sourcing_commitments;     -- FK -> sourcing_plan_channels
DROP TABLE IF EXISTS public.sourcing_channel_weeks;   -- FK -> sourcing_plan_channels
DROP TABLE IF EXISTS public.sourcing_advice;          -- FK -> sourcing_plans
DROP TABLE IF EXISTS public.sourcing_plan_channels;   -- FK -> sourcing_plans
DROP TABLE IF EXISTS public.sourcing_exceptions;      -- FK -> sourcing_plans
DROP TABLE IF EXISTS public.sourcing_plan_changes;    -- FK -> sourcing_plans
DROP TABLE IF EXISTS public.sourcing_plans;           -- FK -> roles, users
DROP TABLE IF EXISTS public.sourcing_settings;        -- FK -> users

-- Post-condition: nothing sourcing-related may remain, and the shared trigger
-- function must still exist. Any failure aborts the whole transaction.
DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname LIKE '%sourcing\_%') THEN
    RAISE EXCEPTION 'Rollback incomplete: a sourcing_ relation (table/index/sequence) remains';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE '%sourcing\_%' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Rollback incomplete: a sourcing_ trigger remains';
  END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'update_updated_at() is missing - it must never be dropped by this rollback';
  END IF;
END
$verify$;

COMMIT;
