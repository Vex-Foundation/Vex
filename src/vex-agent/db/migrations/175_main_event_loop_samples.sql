-- MAIN EVENT LOOP SAMPLES: how often, and how long, the Electron main process
-- stops answering (Kairos Phase 7, K-5).
--
-- WHY THIS EXISTS. The agent engine, the IPC handlers and every wallet and
-- signing call share the Electron main process's one event loop. A synchronous
-- stretch there (a sync KDF, a large JSON parse, a burst of DB handshakes)
-- freezes every click and every window at once, and nothing measured it.
-- `kairos-runtime:report` reads these rows to show the delay distribution and
-- the count of stalls a user would feel.
--
-- TELEMETRY, NOT STATE. Nothing in the runtime reads this table to decide
-- anything. One row per sampling window (about one a minute while the app
-- runs), written fire-and-forget with at most one write in flight; a failed
-- INSERT is logged and dropped.
--
-- SANITISED ONLY. Numbers only: no session, path, message or error text.
--
--   window_ms           wall-clock length of the window the row summarises.
--   sample_count        delay samples the histogram took in the window.
--   p50_ms / p99_ms     event loop delay percentiles over the window, ms.
--   max_ms              the largest single delay in the window, ms.
--   stall_count         timer ticks that ran at least `stall_threshold_ms`
--                       late: one per perceptible freeze.
--   stall_threshold_ms  the threshold in force when the row was written, so a
--                       later change of the constant cannot reinterpret rows.
--   longest_stall_ms    the latest tick in the window, ms (0 when none).
--
-- IDEMPOTENT: CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS main_event_loop_samples (
  id                 BIGSERIAL PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_ms          INTEGER NOT NULL CHECK (window_ms >= 0),
  sample_count       INTEGER NOT NULL CHECK (sample_count >= 0),
  p50_ms             REAL NOT NULL CHECK (p50_ms >= 0),
  p99_ms             REAL NOT NULL CHECK (p99_ms >= 0),
  max_ms             REAL NOT NULL CHECK (max_ms >= 0),
  stall_count        INTEGER NOT NULL CHECK (stall_count >= 0),
  stall_threshold_ms INTEGER NOT NULL CHECK (stall_threshold_ms > 0),
  longest_stall_ms   REAL NOT NULL CHECK (longest_stall_ms >= 0)
);

CREATE INDEX IF NOT EXISTS main_event_loop_samples_created_at_idx
  ON main_event_loop_samples (created_at);
