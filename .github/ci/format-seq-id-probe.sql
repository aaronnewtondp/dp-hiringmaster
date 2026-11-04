-- Behavioural probe of format_seq_id(). The LPAD truncation bug (CLAUDE.md, "ID scheme") only shows once a
-- sequence crosses its pad width, which a freshly seeded database never does, so exercise it on throwaway
-- TEMP sequences. Raises (and, with ON_ERROR_STOP, fails the job) on the first wrong answer.
DO $$
DECLARE
  got TEXT;
BEGIN
  CREATE TEMP SEQUENCE ci_probe_narrow START 7;
  got := format_seq_id('ci_probe_narrow', 'R', 4);
  IF got <> 'R0007' THEN RAISE EXCEPTION 'format_seq_id(7, R, 4) returned %, expected R0007', got; END IF;

  CREATE TEMP SEQUENCE ci_probe_edge START 9999;
  got := format_seq_id('ci_probe_edge', 'C', 4);
  IF got <> 'C9999' THEN RAISE EXCEPTION 'format_seq_id(9999, C, 4) returned %, expected C9999', got; END IF;
  -- the value that used to truncate to C1000 and collide with the real C1000
  got := format_seq_id('ci_probe_edge', 'C', 4);
  IF got <> 'C10000' THEN RAISE EXCEPTION 'format_seq_id(10000, C, 4) returned %, expected C10000 (LPAD truncation is back)', got; END IF;

  CREATE TEMP SEQUENCE ci_probe_three START 999;
  got := format_seq_id('ci_probe_three', 'AGN', 3);
  IF got <> 'AGN999' THEN RAISE EXCEPTION 'format_seq_id(999, AGN, 3) returned %, expected AGN999', got; END IF;
  got := format_seq_id('ci_probe_three', 'AGN', 3);
  IF got <> 'AGN1000' THEN RAISE EXCEPTION 'format_seq_id(1000, AGN, 3) returned %, expected AGN1000', got; END IF;

  -- nextval() must be called exactly once per id (a double call would skip a number and burn the sequence)
  CREATE TEMP SEQUENCE ci_probe_once START 1;
  PERFORM format_seq_id('ci_probe_once', 'X', 3);
  IF (SELECT last_value FROM ci_probe_once) <> 1 THEN
    RAISE EXCEPTION 'format_seq_id advanced the sequence more than once per id';
  END IF;
END
$$;
