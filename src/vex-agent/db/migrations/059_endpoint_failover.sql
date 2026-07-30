-- NUMBERING: 059 is FINAL. The runner applies only `version > MAX(schema_version)`,
-- so a higher number shipped first would permanently skip this one on every database
-- it reached. 058 was taken by the compaction wave at ITS build time; this package took
-- the next free number at ITS build time. Do not renumber.
--
-- Endpoint failover (owner decisions 1-4, 2026-07-29).
--
-- WHY THESE TWO CHANGES SHIP TOGETHER. They answer the same question from the two
-- ends: `session_endpoint_switches` records that the runtime MOVED a session to a
-- different endpoint, and `usage_log.serving_provider` records which endpoint actually
-- SERVED each request. Either alone leaves the incident that motivated this package
-- ("a pinned endpoint 429'd and we cannot tell what ran where") only half-answerable.
--
-- ── session_endpoint_switches ────────────────────────────────────────────────
-- A session that hits repeated CAPACITY failures on its pinned endpoint switches once,
-- to the sibling endpoint of the same model with the highest uptime, and stays there
-- for the rest of the session (owner decision 2). The in-memory routing state dies with
-- the process; this table is the DURABLE record a future provider UI reads, and the
-- audit trail for "why did this session's cost profile change mid-run?".
--
-- `reason_class` is a BOUNDED code from a closed set the runtime owns
-- (`inference/openrouter/endpoint-failover/capacity-failure.ts` — CapacityFailureClass),
-- never provider text and never a UI string. It is NOT CHECK-constrained: the set is
-- ours to extend, and a failed INSERT here happens on the failure path of a turn that
-- is already degraded, which is the worst possible moment to add a second failure.
-- Kept honest by the classifier's own type instead.
--
-- `previous_endpoint` is NULLABLE: a session running in "Auto" mode (no
-- OPENROUTER_ENDPOINT_TAG pin) has no previous endpoint to name, and recording an empty
-- string there would be a lie dressed as data.
--
-- No unique constraint on `session_id`, but note what that does and does NOT mean.
-- This row is the AUTHORITY for stickiness, not a log of it: the runtime keeps its
-- routing decision in memory only as a cache, and on a miss (restart, LRU eviction) it
-- READS THIS ROW BACK and keeps the same endpoint. So a session switches at most once,
-- and a second row is not expected. The unique index is still omitted deliberately —
-- an operator replay, or a database written by an older build, may hold more than one
-- row, and a constraint would turn that into a failed INSERT on the failure path of an
-- already-degraded turn. The reader (`getLatestEndpointSwitch`) is unambiguous instead:
-- newest row wins, ordered by `created_at DESC, id DESC`, which is what the index below
-- serves.
--
-- ── usage_log.serving_provider ───────────────────────────────────────────────
-- `usage_log.provider` has always stored the literal 'openrouter' — the aggregator, not
-- the upstream that ran the model — so "which request went to which provider" was
-- unanswerable and the 2026-07-29 incident was correspondingly hard to diagnose. The
-- routing metadata we ALREADY request (`xOpenRouterMetadata: enabled`) carries it and
-- the runtime threw it away.
--
-- The value is the router's provider NAME (e.g. 'DeepInfra', 'Baidu') off the `selected`
-- entry of `endpoints.available`, NOT the routable `tag`: the installed SDK's
-- `EndpointInfo` is `{model, provider, selected}` and carries no tag. Bounded and
-- validated at the inference boundary (`openrouter/provider-signals.ts`,
-- `boundedProviderName`) before it reaches this column.
--
-- NULLABLE with no default and NO backfill: rows written before this migration, by the
-- background one-shot path (which deliberately does not request routing metadata), or
-- by a response that carried none, are honestly "unknown" rather than falsely
-- attributed. Historical routing is not recoverable.
--
-- Expand-only, forward-only, idempotent. Old code that never reads these is unaffected;
-- `logUsage` is awaited WITHOUT a try/catch on the turn path, so the column must exist
-- before the code that writes it ships. Mirrored byte-identically into
-- vex-app/resources/migrations/ by scripts/copy-migrations.mjs.

CREATE TABLE IF NOT EXISTS session_endpoint_switches (
  id                BIGSERIAL PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,
  previous_endpoint TEXT NULL,
  new_endpoint      TEXT NOT NULL,
  reason_class      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_endpoint_switches_session
  ON session_endpoint_switches(session_id, created_at DESC);

COMMENT ON TABLE session_endpoint_switches IS
  'Durable record of endpoint failover: a session moved off its pinned OpenRouter endpoint after repeated capacity failures. AUTHORITATIVE, not a log: the runtime reads the newest row back on a cache miss (restart or eviction) and keeps that endpoint, so a session switches at most once and a second row is not expected.';

COMMENT ON COLUMN session_endpoint_switches.reason_class IS
  'Bounded capacity-failure code owned by the runtime (CapacityFailureClass in inference/openrouter/endpoint-failover/capacity-failure.ts). Never provider text, never UI copy.';

ALTER TABLE usage_log ADD COLUMN IF NOT EXISTS serving_provider TEXT NULL;

COMMENT ON COLUMN usage_log.serving_provider IS
  'Upstream provider NAME that actually served this request, from OpenRouter routing metadata (endpoints.available[].selected.provider). NOT the routable endpoint tag — the SDK EndpointInfo carries none. NULL when the response reported no routing metadata.';
