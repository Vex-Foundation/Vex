-- Agent Scan Phase 2 (plan §2 + REVISION 2/3/4) — bridge legs in `agent_activity`.
--
-- Khalani (primary) and Relay (fallback) bridges are recorded in the SAME
-- `agent_activity` table swaps use, exactly like a swap: label "bridge",
-- from-chain -> to-chain, token amounts, USD when the provider gives it, tx
-- hashes, pending/confirmed/definitively_failed. This is an EXPAND-ONLY
-- migration (044's own convention, 044:185-191): every 044 swap invariant is
-- byte-untouched; new columns are nullable-or-defaulted; new CHECKs are scoped
-- so they are satisfied by every existing swap row.
--
-- ── Recording model (REVISION 2 R1/R2/R3, REVISION 3 B1/B2, REVISION 4 C1/C2/C4) ─
--
-- ONE `protocol_executions` intent fans out into per-leg `agent_activity` rows,
-- keyed by `(protocol_execution_id, event_index)` (the 044 idempotency key).
-- A bridge execution's rows:
--   * `allowance_reset` / `allowance` — Vex-signed EVM approvals (Khalani's
--     approvals array literally mirrors the swap staging), locally broadcast.
--   * `bridge_deposit` — the Vex-signed origin leg, locally broadcast (full
--     Phase-1 staged-broadcast CAS discipline: plan -> sign -> persist hash/
--     nonce -> broadcast -> accept).
--   * `bridge_fill_expected` — the LOGICAL row (marker decision below). Exactly
--     ONE per execution. Created `pending` and hashless; it carries the ROUTE
--     endpoints + requested amounts + `provider_order_id` and is the single row
--     every feed/dedup/in-flight-guard keys on. On success it is CAS-confirmed
--     from provider fill evidence (its `tx_hash` becomes the destination fill
--     hash); on refund it is failed with `failure_code='bridge_refunded'`.
--   * `bridge_fill_observed` — EXTRA destination fills the provider reports
--     (multi-fill orders). Externally observed (solver-signed), never locally
--     broadcast.
--   * `bridge_refund` — origin-side refund evidence rows. Externally observed.
--
-- LOGICAL-ROW MARKER DECISION (B2 — pick one, pin it): a DEDICATED event role
-- `bridge_fill_expected`, NOT a boolean `is_logical_row`. Rationale: the marker
-- then lives inside the closed `event_role` vocabulary the kind<->role CHECK
-- already governs, the partial UNIQUE indexes key on it directly, and a stray
-- second logical row is impossible by construction (one-logical-per-execution
-- UNIQUE index) rather than by a mutable flag. Pinned in the bridge int tests
-- and the 045 verifier.
--
-- ROUTE columns (R1): every bridge row carries route-level
-- `from_chain_id/from_chain_slug/to_chain_id/to_chain_slug`. The existing
-- `chain_id/chain_slug` stays the LEG's OWN execution chain (a `bridge_fill_*`
-- leg executes on `to_chain_id`, a deposit/refund leg on `from_chain_id`), so
-- the origin is never lost per-row. Provider-native chain ids are stored as-is
-- (never normalized here — Khalani Solana 20011000000 vs Relay 792703809 differ);
-- interpret `*_chain_id` only together with the `protocol` (provider) column.
--
-- CHAIN FAMILY (C4/B1): `chain_family` is `NOT NULL DEFAULT 'eip155'`. The
-- DEFAULT is load-bearing — the untouched 044 swap-path repo functions never set
-- it, so the default backfills every existing row AND every future swap insert
-- to 'eip155' (the only family that writes swaps here: kyberswap/uniswap). The
-- bridge repo sets it explicitly per leg (source family on deposit/refund, dest
-- family on fills). CHECK IN-list ALONE would accept NULL and bypass the nonce
-- matrix (C4), so NOT NULL is enforced, not just the IN-list.
--
-- NORMALIZED ROUTE (C2 + Codex GREEN-LIGHT pin): the in-flight guard rejects a
-- second execute for the same wallet+session+route while a prior bridge is
-- non-terminal, in the DB (partial UNIQUE index), covering Khalani AND Relay
-- alike. The key MUST be family-safe and MUST EXCLUDE provider/protocol so
-- Khalani and Relay cannot race one route into two in-flight bridges. It is a
-- TEXT column the REPO computes (the DB cannot map provider-native chain ids to
-- a canonical form) and stores ONLY on the logical row. Normalization (pinned in
-- `agent-activity.ts#buildNormalizedBridgeRoute` + its unit test):
--   `${chainKey(fromFamily,fromChainId)}:${token(fromFamily,fromToken)}`
--   + `->` +
--   `${chainKey(toFamily,toChainId)}:${token(toFamily,toToken)}`
-- where chainKey('eip155', id) = `eip155:${id}` (EVM ids are provider-agnostic),
-- chainKey('solana', _) = `solana` (COLLAPSES the divergent provider-native
-- Solana ids to one canonical token so both providers collide on the same
-- Solana route); token('eip155', t) = lowercase(trim(t)), token('solana', t) =
-- trim(t) (base58 is case-sensitive, same mint across providers). No provider
-- string ever enters the key.
--
-- PROVIDER CORRELATION (B2): `provider_order_id` (Khalani orderId / Relay
-- requestId) is stored ONLY on the logical row and is UNIQUE per
-- (protocol, provider_order_id) — the join key the W4 sweep polls by and the
-- key grouping a bridge's legs. `provider_status` records the last provider-
-- native status (feed "tracking delayed" UX, R12/B6). `last_attempted_at` is the
-- sweep's fair-scheduling clock (advanced on EVERY attempt, B6);
-- `evidence_source`/`observed_at` carry externally-observed provenance (R6).
--
-- PROVENANCE INVARIANTS:
--   * a provider-observed row (`evidence_source` set) has ALL local
--     submit/broadcast fields NULL (it was solver-signed, never Vex-broadcast) —
--     enforced via `evidence_source`, exactly as R3 requires;
--   * nonce matrix (B1): Solana rows never carry a nonce; an EVM locally-signed
--     leg that has staged a tx_hash MUST record its nonce; planned rows, hashless
--     pre-sign failures, and provider-observed rows may leave nonce NULL;
--   * a confirmed bridge leg requires a `tx_hash` — already enforced for ALL
--     rows by 044's `agent_activity_confirmed_has_hash`, so no new CHECK is
--     needed and none is added (044 byte-untouched). 044's
--     `agent_activity_confirmed_swap_has_executed_legs` is scoped
--     `event_role <> 'swap'`, so bridge legs confirm WITHOUT executed legs
--     (executed_* is set only from independently verified evidence — B4/Q2 — and
--     is NULL otherwise).
--
-- Mirror: coordinator runs `node vex-app/scripts/copy-migrations.mjs`.

-- ── 1. Widen the closed vocabularies (expand-only, drop+re-add named) ──────────
-- 044 declared these as inline column CHECKs, so Postgres named them
-- deterministically `agent_activity_<column>_check`. Drop that exact auto-name
-- and re-add a widened NAMED constraint, idempotently (034/035 pattern). The 045
-- verifier asserts a bridge row actually inserts, so a missed drop (old narrow
-- check surviving) fails loudly rather than silently.

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_valid CHECK (kind IN ('swap', 'bridge'));
  END IF;
END$$;

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_event_role_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_event_role_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_event_role_valid CHECK (event_role IN (
        'allowance_reset', 'allowance', 'swap',
        'bridge_deposit', 'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund'
      ));
  END IF;
END$$;

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_failure_code_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_failure_code_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_failure_code_valid CHECK (failure_code IN (
        'route_not_found', 'slippage', 'deadline_expired',
        'insufficient_liquidity', 'allowance_or_balance',
        'chain_unsupported', 'simulation_reverted', 'mined_revert',
        'broadcast_error', 'confirmation_timeout', 'unknown',
        'bridge_failed', 'bridge_refunded'
      ));
  END IF;
END$$;

-- ── 2. New columns (all nullable, or NOT NULL with a backfilling default) ──────

ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS from_chain_id     BIGINT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS from_chain_slug   TEXT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS to_chain_id       BIGINT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS to_chain_slug     TEXT;
-- NOT NULL + DEFAULT backfills existing rows AND untouched swap inserts to
-- 'eip155' in one step (C4); the bridge repo overrides it per leg.
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS chain_family      TEXT NOT NULL DEFAULT 'eip155';
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS provider_order_id TEXT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS normalized_route  TEXT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS provider_status   TEXT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS evidence_source   TEXT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS observed_at       TIMESTAMPTZ;

-- ── 3. New CHECK invariants (idempotent; each satisfied by every 044 swap row) ─

DO $$
BEGIN
  -- chain_family closed vocabulary (NOT NULL already enforced on the column).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_chain_family_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_chain_family_valid CHECK (chain_family IN ('eip155', 'solana'));
  END IF;

  -- kind <-> event_role binding (R3). swap keeps its 044 roles; bridge gets its
  -- own. A swap can never carry a bridge role and vice-versa.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_role_binding') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_role_binding CHECK (
        (kind = 'swap'   AND event_role IN ('allowance_reset', 'allowance', 'swap'))
        OR
        (kind = 'bridge' AND event_role IN (
          'allowance_reset', 'allowance',
          'bridge_deposit', 'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund'
        ))
      );
  END IF;

  -- Bridge rows require the route endpoints (R1). Slugs follow 044's nullable
  -- chain_slug convention (populated by the repo when known); the ids are the
  -- enforced route contract.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_bridge_has_route') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_bridge_has_route CHECK (
        kind <> 'bridge' OR (from_chain_id IS NOT NULL AND to_chain_id IS NOT NULL)
      );
  END IF;

  -- Swap rows keep every bridge-only column NULL (R3). Satisfied by 044 rows,
  -- which never set any of these. chain_family is exempt (defaults 'eip155').
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_swap_no_bridge_cols') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_swap_no_bridge_cols CHECK (
        kind <> 'swap' OR (
          from_chain_id IS NULL AND from_chain_slug IS NULL
          AND to_chain_id IS NULL AND to_chain_slug IS NULL
          AND provider_order_id IS NULL AND normalized_route IS NULL
          AND provider_status IS NULL AND last_attempted_at IS NULL
          AND evidence_source IS NULL AND observed_at IS NULL
        )
      );
  END IF;

  -- Logical-row marker biconditional (B2): normalized_route is present IFF the
  -- row is the logical `bridge_fill_expected` row. No other row may carry it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_normalized_route_logical_only') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_normalized_route_logical_only CHECK (
        (event_role = 'bridge_fill_expected') = (normalized_route IS NOT NULL)
      );
  END IF;

  -- The logical row is always session-scoped (the in-flight guard keys on
  -- session_id; a NULL there would defeat it). 044 leaves session_id nullable
  -- for swaps — untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_logical_has_session') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_logical_has_session CHECK (
        event_role <> 'bridge_fill_expected' OR session_id IS NOT NULL
      );
  END IF;

  -- provider_order_id lives ONLY on the logical row (B2).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_order_id_logical_only') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_order_id_logical_only CHECK (
        provider_order_id IS NULL OR event_role = 'bridge_fill_expected'
      );
  END IF;

  -- Provider-observed rows carry NO local submit/broadcast provenance (R3):
  -- evidence_source set => the row was solver-signed / externally observed, so
  -- it can never have a from_address, nonce, submit_attempted_at, or
  -- broadcast_at. Satisfied by every 044 swap row (evidence_source NULL).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_observed_no_local_fields') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_observed_no_local_fields CHECK (
        evidence_source IS NULL
        OR (from_address IS NULL AND nonce IS NULL
            AND submit_attempted_at IS NULL AND broadcast_at IS NULL)
      );
  END IF;

  -- Nonce matrix (B1), part 1: a Solana row never carries a nonce.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_solana_no_nonce') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_solana_no_nonce CHECK (
        chain_family <> 'solana' OR nonce IS NULL
      );
  END IF;

  -- Nonce matrix (B1), part 2: an EVM locally-signed leg that has staged a
  -- tx_hash MUST record its nonce. Locally-signed = evidence_source IS NULL;
  -- a provider-observed row (evidence_source set) already has nonce NULL by the
  -- observed-no-local-fields CHECK. Satisfied by every 044 swap row —
  -- markActivityBroadcast always persists tx_hash + nonce atomically, so no swap
  -- row has a hash without a nonce.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_evm_signed_leg_has_nonce') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_evm_signed_leg_has_nonce CHECK (
        evidence_source IS NOT NULL
        OR tx_hash IS NULL
        OR chain_family <> 'eip155'
        OR nonce IS NOT NULL
      );
  END IF;
END$$;

-- ── 4. Indexes ────────────────────────────────────────────────────────────────

-- Exactly ONE logical row per execution (B2).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_activity_bridge_logical
  ON agent_activity (protocol_execution_id)
  WHERE event_role = 'bridge_fill_expected';

-- One provider order id per (provider, order id) across executions (B2) — the
-- sweep join key + leg-grouping key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_activity_provider_order
  ON agent_activity (protocol, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

-- In-flight guard (C2 + Codex pin): at most ONE non-terminal (pending) logical
-- row per (wallet, session, normalized route). Provider/protocol is DELIBERATELY
-- absent from the key so Khalani and Relay cannot race one route into two
-- in-flight bridges. The second concurrent execute hits a 23505 here; the repo
-- surfaces it as an in-flight conflict (nothing broadcast).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_activity_bridge_inflight
  ON agent_activity (wallet_address, session_id, normalized_route)
  WHERE event_role = 'bridge_fill_expected' AND status = 'pending';

-- Bridge sweep hot path (W4): pending logical rows with an order id, fair-
-- scheduled oldest-touched first (COALESCE(last_attempted_at, created_at) ASC).
CREATE INDEX IF NOT EXISTS idx_agent_activity_bridge_sweep
  ON agent_activity (COALESCE(last_attempted_at, created_at))
  WHERE event_role = 'bridge_fill_expected' AND status = 'pending' AND provider_order_id IS NOT NULL;
