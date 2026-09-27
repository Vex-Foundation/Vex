-- RUNTIME TIMINGS: where each turn's wall-clock time actually goes.
--
-- WHY THIS EXISTS. `usage_log` records one row per SUCCESSFUL inference request
-- that returned usage. It cannot answer the questions that decide what to fix
-- next: how long the model spent reasoning before its first useful token, how
-- much of a turn was tool dispatch versus inference, and how often an attempt
-- failed, was retried on a sibling endpoint, fell back to buffered mode, or was
-- cancelled. Failed and aborted attempts never reach `usage_log` at all, so the
-- slowest turns are exactly the ones it cannot see.
--
-- TELEMETRY, NOT STATE. Nothing in the runtime reads these tables to make a
-- decision. Rows are written fire-and-forget off the turn's critical path; a
-- failed INSERT is logged and dropped. That is why:
--   * `mission_run_id` carries NO foreign key — telemetry must never block, or
--     be blocked by, deleting a mission run.
--   * the CHECK constraints cover only the closed outcome enums the runtime
--     owns; open provider vocabularies (finish reasons, error classes, fallback
--     reasons) stay unconstrained so a new value degrades to a row, not a
--     rejected INSERT.
--   * `session_id` cascades on session delete, so a removed session leaves no
--     orphaned timing rows behind.
--
-- SANITISED ONLY. Every column is a number, an enum, an ID, a tool NAME, a
-- model/provider name, or an error CLASS (error name, HTTP status, provider
-- error type). Never prompt text, message content, tool arguments or results,
-- addresses, amounts, raw error messages, or secrets.
--
-- All `*_ms` columns are integer milliseconds measured on a monotonic clock;
-- `started_at` is the only wall-clock value and exists to place a row in time.

-- ── inference_attempts ──────────────────────────────────────────────────────
-- One row per call to the inference layer from a turn iteration, whatever its
-- outcome. Capacity retries on sibling endpoints happen INSIDE one attempt and
-- are summarised by `capacity_retries` / `capacity_retry_classes` rather than
-- as separate rows, because the turn experienced them as one wait.
--
--   turn_run_id           one `runTurnLoop` invocation; joins to
--                         `turn_run_timings` and `tool_dispatch_timings`.
--   outcome               'timeout' is kept apart from 'aborted' and 'error':
--                         a deadline breach (`AbortSignal.timeout`, the SDK's
--                         request timeout, an upstream 408/524) says the
--                         provider hung, 'aborted' says the user pressed Stop.
--                         Folding either into 'error' would hide the one
--                         failure mode a latency budget can actually fix.
--   endpoint_tag          the OpenRouter endpoint the session was on when the
--                         attempt settled — after any failover switch made
--                         during it. NULL means no pin ("Auto" routing).
--                         `serving_provider` alone cannot answer this: it is
--                         only known when a response arrived.
--   stream_id             `executeTurn`'s streamId, to correlate with UI deltas.
--   requested_effort      the reasoning effort actually sent; NULL means the
--                         provider default was used.
--   fallback_reason       why streaming degraded to a buffered request
--                         (no_stream_method | not_async_iterable | setup_threw |
--                         threw_before_first_chunk).
--   first_chunk_ms        request start to the first chunk of ANY type.
--   first_semantic_ms     request start to the first content OR tool-call chunk;
--                         the moment the user can see progress.
--   reasoning_only_ms     first reasoning chunk to first semantic chunk (or to
--                         the end when no semantic chunk arrived).
--   content_empty         NULL when unknown (the attempt errored before any
--                         response), which is not the same claim as FALSE.
--   tool_call_count       accumulated tool calls, malformed ones included, so
--                         `tool_call_count - valid_tool_call_count` counts them.
CREATE TABLE IF NOT EXISTS inference_attempts (
  id                        BIGSERIAL PRIMARY KEY,
  session_id                TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mission_run_id            TEXT,
  turn_run_id               TEXT NOT NULL,
  iteration                 INTEGER NOT NULL,
  stream_id                 TEXT,
  started_at                TIMESTAMPTZ NOT NULL,
  outcome                   TEXT NOT NULL CHECK (outcome IN ('completed','aborted','timeout','error')),
  error_class               TEXT,
  model                     TEXT,
  endpoint_tag              TEXT,
  serving_provider          TEXT,
  requested_effort          TEXT,
  buffered_fallback         BOOLEAN NOT NULL DEFAULT FALSE,
  fallback_reason           TEXT,
  capacity_retries          INTEGER NOT NULL DEFAULT 0,
  capacity_retry_classes    TEXT[],
  pre_inference_ms          INTEGER,
  prompt_stack_ms           INTEGER,
  first_chunk_ms            INTEGER,
  first_reasoning_ms        INTEGER,
  first_semantic_ms         INTEGER,
  reasoning_only_ms         INTEGER,
  max_inter_chunk_gap_ms    INTEGER,
  total_ms                  INTEGER NOT NULL,
  chunk_count               INTEGER NOT NULL DEFAULT 0,
  finish_reason             TEXT,
  content_empty             BOOLEAN,
  tool_call_count           INTEGER,
  valid_tool_call_count     INTEGER,
  prompt_tokens             INTEGER,
  completion_tokens         INTEGER,
  reasoning_tokens          INTEGER,
  cached_tokens             INTEGER,
  generation_id             TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inference_attempts_created ON inference_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inference_attempts_session ON inference_attempts (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inference_attempts_turn_run ON inference_attempts (turn_run_id);

-- ── tool_dispatch_timings ───────────────────────────────────────────────────
-- One row per tool dispatch inside a turn iteration. Separates tool latency
-- from inference latency, which a turn's total alone cannot. `outcome` is
-- 'success' / 'failure' from the tool result's own flag, and 'error' when the
-- dispatch threw. `action_kind` is copied from the result when the tool
-- reports one.
CREATE TABLE IF NOT EXISTS tool_dispatch_timings (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_run_id     TEXT NOT NULL,
  iteration       INTEGER NOT NULL,
  tool_call_id    TEXT,
  tool_name       TEXT NOT NULL,
  action_kind     TEXT,
  started_at      TIMESTAMPTZ NOT NULL,
  duration_ms     INTEGER NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('success','failure','error')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_dispatch_timings_created ON tool_dispatch_timings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_dispatch_timings_turn_run ON tool_dispatch_timings (turn_run_id);

-- ── turn_run_timings ────────────────────────────────────────────────────────
-- One row per `runTurnLoop` invocation: the envelope the other two tables sit
-- inside. Keyed by `turn_run_id` because the runtime mints exactly one per
-- invocation. `outcome` is 'returned' (with the loop's `stop_reason`) or
-- 'error' (with a sanitised `error_class`); `session_kind` lets the report
-- split interactive chat from mission turns.
--
--   queue_wait_ms   the entry point starting to handle the turn (the chat,
--                   setup, wake or mission-run handler) to the moment
--                   `runTurnLoop` starts: lease claim, provider/config load,
--                   hydrate and the setup the loop itself never sees. NULL
--                   when the caller did not supply an entry timestamp.
CREATE TABLE IF NOT EXISTS turn_run_timings (
  turn_run_id     TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mission_run_id  TEXT,
  session_kind    TEXT,
  started_at      TIMESTAMPTZ NOT NULL,
  total_ms        INTEGER NOT NULL,
  iterations      INTEGER NOT NULL,
  tool_calls      INTEGER NOT NULL,
  queue_wait_ms   INTEGER,
  outcome         TEXT NOT NULL CHECK (outcome IN ('returned','error')),
  stop_reason     TEXT,
  error_class     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_turn_run_timings_created ON turn_run_timings (created_at DESC);
