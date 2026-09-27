-- TURN RUN TIMINGS: name the pre-loop gap for what it measures.
--
-- WHY THIS EXISTS. Migration 171 called `turn_run_timings.queue_wait_ms` the
-- gap from the entry point starting to handle a turn (the chat, setup, wake or
-- mission-run handler) to `runTurnLoop` starting. Nothing in that span waits in
-- a queue: it is the entry point's own work before the loop — provider/config
-- load, the lease claim and hydrating the session. Reading it as queue wait
-- would send a slow turn's investigation to the wrong place, so the column is
-- renamed to `pre_loop_setup_ms`. The values are unchanged: same clock, same
-- endpoints, NULL still means the caller supplied no entry timestamp.
--
-- 171 is already applied on existing databases and is not edited; this file
-- renames in place so existing rows keep their values.
--
-- IDEMPOTENT. The rename runs only while the old column exists and the new one
-- does not, so a re-run is a no-op.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'turn_run_timings'
        AND column_name = 'queue_wait_ms')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'turn_run_timings'
        AND column_name = 'pre_loop_setup_ms') THEN
    ALTER TABLE turn_run_timings RENAME COLUMN queue_wait_ms TO pre_loop_setup_ms;
  END IF;
END $$;
