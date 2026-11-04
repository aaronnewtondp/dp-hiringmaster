-- Schema guards for the HMS database. Run AFTER schema.sql + seed.sql (see .github/ci/check-db.sh).
--
-- Every row this file returns is one finding, as  kind|subject|detail  (psql -At -F '|').
-- check-db.sh fails the job on any finding that is not listed in known-db-defects.txt.
--
-- Why these checks exist (all from CLAUDE.md, "ID scheme"):
--   * A prefixed id (R0001, C0001, A0001 ...) comes from  format_seq_id(<sequence>, <prefix>, <width>).
--     If a sequence's NEXT value is not above the largest id already stored, the next INSERT collides
--     on the primary key. This happened for real (seed.sql reset four sequences to 1).
--   * Two tables must never share one sequence (duplicate-key crashes in production before).
--   * LPAD(nextval(..), N, '0') silently truncates once the number is N digits wide; format_seq_id
--     replaced it everywhere. A column default that goes back to lpad+nextval is a regression.

WITH defaults AS (
  SELECT c.relname AS tbl,
         a.attname AS col,
         pg_get_expr(d.adbin, d.adrelid) AS expr
  FROM pg_attrdef d
  JOIN pg_class c      ON c.oid = d.adrelid
  JOIN pg_namespace n  ON n.oid = c.relnamespace
  JOIN pg_attribute a  ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE n.nspname = 'public'
),
prefixed AS (
  SELECT d.tbl,
         d.col,
         m.arr[1]      AS seq,
         m.arr[2]      AS prefix,
         m.arr[3]::int AS width
  FROM defaults d,
       LATERAL regexp_match(d.expr, 'format_seq_id\(''([A-Za-z0-9_]+)''::regclass, ''([A-Za-z]+)''::text, ([0-9]+)\)') AS m(arr)
  WHERE m.arr IS NOT NULL
),
measured AS (
  SELECT p.*,
         -- largest numeric part among ids that look like <prefix><digits>; 0 for an empty table.
         -- query_to_xml is the way to run a query whose table/column names are data, in plain SQL.
         COALESCE((xpath('/row/m/text()',
                    query_to_xml(format('SELECT COALESCE(MAX(substring(%I FROM %L)::bigint), 0) AS m FROM %I',
                                        p.col, '^' || p.prefix || '([0-9]+)$', p.tbl),
                                 false, true, '')))[1]::text::bigint, 0) AS max_id,
         -- value the sequence will hand out next (last_value is NULL until the first nextval)
         COALESCE(s.last_value + s.increment_by, s.start_value) AS next_val
  FROM prefixed p
  LEFT JOIN pg_sequences s ON s.schemaname = 'public' AND s.sequencename = p.seq
)
SELECT 'seq-behind-ids', seq,
       format('%s.%s already holds ids up to number %s (prefix %s) but %s would hand out %s next', tbl, col, max_id, prefix, seq, next_val)
FROM measured
WHERE next_val IS NULL OR next_val <= max_id
UNION ALL
SELECT 'seq-shared', seq,
       format('%s tables draw ids from %s: %s', count(*), seq, string_agg(tbl || '.' || col, ', ' ORDER BY tbl))
FROM prefixed
GROUP BY seq
HAVING count(*) > 1
UNION ALL
SELECT 'lpad-nextval-default', tbl || '.' || col, expr
FROM defaults
WHERE expr ~* 'lpad' AND expr ~* 'nextval'
UNION ALL
-- Every table the schema is documented to key by a prefixed id must still do so.
SELECT 'prefixed-id-missing', t.tbl, t.tbl || '.id no longer defaults to format_seq_id(...)'
FROM (VALUES ('roles'), ('candidates'), ('applications'), ('interview_rounds'), ('agencies'),
             ('assignment_repo'), ('comp_benchmarks'), ('eval_questions'), ('ref_checks')) AS t(tbl)
WHERE NOT EXISTS (SELECT 1 FROM prefixed p WHERE p.tbl = t.tbl AND p.col = 'id')
ORDER BY 1, 2;
