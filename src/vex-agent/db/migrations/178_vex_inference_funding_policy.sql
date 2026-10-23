-- VEX INFERENCE FUNDING POLICY: the low-balance alert, the auto top-up
-- standing rule (backend plan 4.4, owner decision D12) and every deposit the
-- app makes under an authority other than the funding form.
--
-- OWNER. The Electron main process (`vex-app/src/main/vex-cloud/`), through
-- `src/vex-agent/db/repos/vex-inference-funding.ts`. No agent tool, no model
-- output and no renderer request writes these rows directly: a rule row is
-- written only after the user approved its card in the funding page, and an
-- execution row only by the main-process execution owner.
--
-- vex_inference_settings (one row, id = 1)
--   alert_percent        the user's low-balance alert, a whole percent of the
--                        reference amount, 1 to 90. Absent row = default 20.
--
-- vex_inference_balance_watch (one row per Vex Inference account)
--   reference_wei        the balance high-water mark (available plus
--                        provisional, wei) since the last credited deposit.
--   last_balance_wei     the balance at the last observation.
--   below_alert          the crossing latch: true once a notice was emitted
--                        for the current dip, cleared when the balance is back
--                        at or above the threshold. ONE notice per crossing.
--   last_credited_deposit_id  the newest credited deposit seen; a different
--                        one resets the reference to the balance after it.
--
-- vex_inference_auto_top_up_rules
--   Durable status is what the USER decided: active, paused (the user
--   paused it), revoked, expired. The plan's `suspended` state for vault
--   locked, app quitting, cap reached, deposit address mismatch and balance
--   read failing is DERIVED at read time from live conditions and never
--   stored, so a lock or a quit can never leave a rule stuck. `draft` and
--   `approved` are the form proposal and the card decision, both held by the
--   proposal owner before a row exists. `version` increments on every edit;
--   an edit or a pause names the version it was reviewed against.
--   account_id binds the rule to the Vex Inference account it was approved
--   under: a different signed-in account suspends it.
--
-- vex_inference_deposit_executions
--   One row per deposit attempt made under a rule (the poller, or the agent
--   deposit tool covered by a rule) or under an agent approval. Written
--   `asked` BEFORE anything is signed and moved to exactly one decided status
--   with its outcome and hash. Cap accounting counts every row that is not
--   `refused` (nothing signed): an `unknown` or still `asked` / `submitted`
--   row counts, so an in-flight or ambiguous deposit can never be repeated
--   past a cap. A `reverted` row counts too: it was signed and paid gas.
--   Amounts are raw wei (VEX, 18 decimals) as NUMERIC(78,0), never floats.
--
-- IDEMPOTENT: CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS vex_inference_settings (
  id             SMALLINT PRIMARY KEY CHECK (id = 1),
  alert_percent  INTEGER NOT NULL CHECK (alert_percent BETWEEN 1 AND 90),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vex_inference_balance_watch (
  account_id                TEXT PRIMARY KEY CHECK (account_id ~ '^[0-9a-f-]{36}$'),
  reference_wei             NUMERIC(78, 0) NOT NULL CHECK (reference_wei >= 0),
  last_balance_wei          NUMERIC(78, 0) NOT NULL CHECK (last_balance_wei >= 0),
  below_alert               BOOLEAN NOT NULL DEFAULT false,
  last_credited_deposit_id  TEXT NULL CHECK (last_credited_deposit_id IS NULL OR length(last_credited_deposit_id) BETWEEN 1 AND 128),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vex_inference_auto_top_up_rules (
  rule_id          TEXT PRIMARY KEY CHECK (rule_id ~ '^vxrule-[0-9a-f-]{36}$'),
  account_id       TEXT NOT NULL CHECK (account_id ~ '^[0-9a-f-]{36}$'),
  source_wallet    TEXT NOT NULL CHECK (source_wallet ~ '^0x[0-9a-f]{40}$'),
  amount_wei       NUMERIC(78, 0) NOT NULL CHECK (amount_wei > 0),
  max_per_day      INTEGER NOT NULL CHECK (max_per_day BETWEEN 1 AND 24),
  monthly_cap_wei  NUMERIC(78, 0) NOT NULL CHECK (monthly_cap_wei >= amount_wei),
  trigger_kind     TEXT NOT NULL CHECK (trigger_kind IN ('below_alert_percent')),
  expires_at       TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked', 'expired')),
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  approved_at      TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > approved_at),
  CHECK (expires_at <= approved_at + INTERVAL '90 days')
);

-- At most ONE live (active or paused) rule per account: a second create is a
-- refusal by the owner, and this index makes a race a constraint error, not
-- two rules spending in parallel.
CREATE UNIQUE INDEX IF NOT EXISTS vex_inference_auto_top_up_rules_one_live
  ON vex_inference_auto_top_up_rules (account_id)
  WHERE status IN ('active', 'paused');

CREATE TABLE IF NOT EXISTS vex_inference_deposit_executions (
  execution_id     TEXT PRIMARY KEY CHECK (execution_id ~ '^vxexec-[0-9a-f-]{36}$'),
  rule_id          TEXT NULL REFERENCES vex_inference_auto_top_up_rules (rule_id),
  authority        TEXT NOT NULL CHECK (authority IN ('auto_top_up_poller', 'auto_top_up_agent', 'agent_card', 'agent_full_permission')),
  session_id       TEXT NULL CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 128),
  source_wallet    TEXT NOT NULL CHECK (source_wallet ~ '^0x[0-9a-f]{40}$'),
  deposit_address  TEXT NOT NULL CHECK (deposit_address ~ '^0x[0-9a-f]{40}$'),
  amount_wei       NUMERIC(78, 0) NOT NULL CHECK (amount_wei > 0),
  status           TEXT NOT NULL CHECK (status IN ('asked', 'submitted', 'confirmed', 'reverted', 'unknown', 'refused')),
  refusal_kind     TEXT NULL CHECK (refusal_kind IS NULL OR refusal_kind ~ '^[a-z0-9_]{1,64}$'),
  tx_hash          TEXT NULL CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  asked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ NULL,
  CHECK ((rule_id IS NULL) = (authority IN ('agent_card', 'agent_full_permission'))),
  CHECK ((status IN ('asked', 'submitted')) = (decided_at IS NULL)),
  CHECK (status <> 'refused' OR tx_hash IS NULL)
);

-- At most ONE undecided execution per rule: the single-flight is durable, so
-- two pollers, or the poller and the agent tool, cannot both be in flight.
CREATE UNIQUE INDEX IF NOT EXISTS vex_inference_deposit_executions_one_in_flight
  ON vex_inference_deposit_executions (rule_id)
  WHERE rule_id IS NOT NULL AND status IN ('asked', 'submitted');

CREATE INDEX IF NOT EXISTS vex_inference_deposit_executions_rule_asked_idx
  ON vex_inference_deposit_executions (rule_id, asked_at);
