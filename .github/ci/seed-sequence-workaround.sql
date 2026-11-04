-- CI-SIDE WORKAROUND for a reported schema/seed defect. Delete this file, and the step that runs it in
-- .github/workflows/integration.yml, when the defect is fixed (the matching lines in known-db-defects.txt go too).
--
-- seed.sql inserts Q001-Q013 and BEN001-BEN012 with explicit ids but never advances seq_eval_question / seq_comp_benchmark
-- (both are created with START 1, and the "START 14" / "START 13" re-declarations at schema.sql lines 564-565 are
-- CREATE SEQUENCE IF NOT EXISTS, so they do nothing). On a database rebuilt from the two files, the first INSERT that relies on
-- the default id fails with a duplicate key on eval_questions_pkey / comp_benchmarks_pkey. The Playwright suite hits this in
-- tests/api/08-misc.spec.ts ("HR can add a new question"); a long-lived developer database has long since moved past it.
--
-- Advance each sequence to the largest id its table already holds. Harmless once the defect is fixed.
SELECT setval('seq_eval_question',   (SELECT MAX(substring(id from '[0-9]+')::int) FROM eval_questions));
SELECT setval('seq_comp_benchmark',  (SELECT MAX(substring(id from '[0-9]+')::int) FROM comp_benchmarks));
