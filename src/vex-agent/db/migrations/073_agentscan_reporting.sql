-- 073_agentscan_reporting.sql — AgentScan reporting: identity/state + outbox.
--
-- AgentScan is the public activity explorer (vex-agentscan repo). Vex reports
-- eligible `agent_activity` rows to its ingest API — pseudonymously (a random
-- per-install hash, never derived from key material), asynchronously (this
-- outbox + the `agentscan_report` sync lane), and never from the money path.
--
-- Two tables:
--
--   agentscan_reporting_state — a singleton (id = 1) owning the install's
--   pseudonymous identity (agent_hash public, ingest_token secret), consent
--   record, registration/backfill progress, and permanent-stop reasons the
--   server can impose (revoked consent, quarantine, identity conflict).
--   Identity lives HERE, in the same database as the history it describes,
--   deliberately: a DB reset yields a clean new identity instead of a
--   half-orphaned one (hash without its token → permanent 409 at register).
--
--   agentscan_outbox — one row per (agent_activity id, status snapshot) ever
--   enqueued. The UNIQUE pair is what makes the reporter's diff scan
--   idempotent: the scan inserts exactly the (row, status) pairs it has never
--   seen, which captures both new activity rows and status transitions with
--   ZERO hooks in the money-path writers. Completed rows are KEPT — deleting
--   them would let the scan re-enqueue the same pair forever.
--
-- Rows the ingest contract cannot express (kinds beyond swap/bridge, roles
-- beyond the five public ones, status `superseded_unproven`) are filtered at
-- enqueue time by the reporter's eligibility predicate, not stored here.

CREATE TABLE IF NOT EXISTS agentscan_reporting_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- 32 random bytes, lowercase hex. Public pseudonymous install identifier.
  agent_hash TEXT CHECK (agent_hash ~ '^[0-9a-f]{64}$'),
  -- 32 random bytes, base64url (no padding). Install secret; only ever leaves
  -- this machine inside the register body / Authorization header. Never logged.
  ingest_token TEXT CHECK (ingest_token ~ '^[A-Za-z0-9_-]{43}$'),
  consent_version INT NOT NULL DEFAULT 1,
  accepted_at TIMESTAMPTZ,
  -- Set on the first 200 from /v1/agents/register; cleared on a 401 from
  -- /v1/events so the lane re-registers (server-side reset recovery).
  registered_at TIMESTAMPTZ,
  register_attempt_count INT NOT NULL DEFAULT 0,
  next_register_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Stamped once, right after the one-time full-history enqueue that follows
  -- the first successful registration (the contract's backfill obligation).
  backfill_enqueued_at TIMESTAMPTZ,
  -- A non-null reason permanently disables the lane (contract: 410 and
  -- 403-quarantined are terminal; a register 409 means the identity is dead).
  stopped_reason TEXT CHECK (stopped_reason IN ('consent_revoked','quarantined','agent_conflict')),
  stopped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE agentscan_reporting_state IS
  'Singleton: AgentScan pseudonymous identity, consent, registration/backfill progress, permanent-stop reasons.';
COMMENT ON COLUMN agentscan_reporting_state.agent_hash IS
  'Public pseudonymous install id — 32 CSPRNG bytes hex, never derived from key material.';
COMMENT ON COLUMN agentscan_reporting_state.ingest_token IS
  'Install secret for ingest auth. Leak impact is limited to faking this install''s telemetry.';

CREATE TABLE IF NOT EXISTS agentscan_outbox (
  id BIGSERIAL PRIMARY KEY,
  activity_id BIGINT NOT NULL REFERENCES agent_activity(id) ON DELETE CASCADE,
  -- Status SNAPSHOT at enqueue time — the event reports this status even if
  -- the live row has since moved on (the server orders statuses itself).
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','definitively_failed')),
  -- TRUE only for rows enqueued by the one-time post-registration history scan.
  backfill BOOLEAN NOT NULL DEFAULT FALSE,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Terminal outcomes: accepted (or deduplicated) by the server / rejected by
  -- per-item validation. Exactly one is ever set; both NULL = still owed.
  sent_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  -- DB-resident retry backoff (house convention): claim-and-stamp bumps the
  -- count and pushes next_attempt_at BEFORE the send, so a crash mid-send
  -- retries after the backoff instead of hot-looping. Batches are idempotent
  -- server-side, so retrying forever is safe.
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  CONSTRAINT uniq_agentscan_outbox_pair UNIQUE (activity_id, status)
);

COMMENT ON TABLE agentscan_outbox IS
  'AgentScan send queue + permanent report-log: one row per (activity, status) pair ever enqueued; completed rows are kept so the diff scan stays idempotent.';
COMMENT ON COLUMN agentscan_outbox.last_error IS
  'Status/code words only (e.g. "429 rate_limited") — never response bodies, never the token.';

CREATE INDEX IF NOT EXISTS idx_agentscan_outbox_due
  ON agentscan_outbox (next_attempt_at)
  WHERE sent_at IS NULL AND rejected_at IS NULL;
