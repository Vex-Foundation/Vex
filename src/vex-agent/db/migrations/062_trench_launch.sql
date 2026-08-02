-- 062: the Trench Express LAUNCH phase — activity vocabulary + the three
-- launch tables, in ONE atomic migration.
--
-- ── NUMBERING: 062 is deliberate, and 060 would be a permanent no-op ────────
--
-- `059_endpoint_failover.sql` is the last SEQUENTIAL file, but `061` already
-- shipped on main, and `061`'s own header records why: an uncommitted `060`
-- existed on a developer branch, so a real database may carry schema_version 60
-- or 61 already. `db/migrate.ts` applies only migrations whose version is
-- GREATER than `MAX(schema_version)` — a file numbered 060 would be
-- PERMANENTLY SKIPPED on every database that has run 061, silently, with no
-- error. 062 is the first number that is forward-only for every history.
-- Verified 2026-08-02: no sibling file or branch claims 062.
--
-- ── WHAT A LAUNCH IS, AND WHY IT IS NOT A SWAP ─────────────────────────────
--
-- A Trench Express launch is ONE payable `create` transaction on the Robinhood
-- Chain (4663) Diamond. It mints a token, and — when the launcher asked for a
-- prebuy — it ALSO buys some of that token, in the SAME transaction: the
-- receipt carries `TokenCreated` and (prebuy > 0) `Bought` together.
--
-- So the prebuy is a LEG OF THE LAUNCH, not a second event. It is recorded in
-- the ordinary first-leg columns of the single `launch` row — native ETH in,
-- the new token out — and NEVER as a second `swap` row sharing the same tx
-- hash. Migration 051's header documents the cost of the opposite instinct:
-- folding a new kind into an existing one asserts a route, a price and a
-- counterparty the action never had, and every tx_hash-keyed consumer (the
-- feed's own `txHash=` anchor included) would then see a duplicate.
-- The regression that pins this: a create-with-prebuy produces EXACTLY ONE
-- `launch` activity row for its tx hash.
--
-- A later, separate `trench.trade_execute` on the launched token is its own
-- `swap`, as it already is today.
--
-- ── WHY THERE IS NO CONFIRMED-LEGS CHECK FOR `launch` ──────────────────────
--
-- Deliberate, and the single most important thing to understand before editing
-- this file. Migration `061` DROPPED `agent_activity_confirmed_swap_has_
-- executed_legs`, `agent_activity_confirmed_wrap_has_executed_legs` and
-- `agent_activity_yield_confirmed_legs` because the status-only repair sweep
-- makes `confirmed` + NULL `executed_*` a LEGITIMATE, reachable state: the
-- sweep proves a tx settled without decoding what it moved, and writing the
-- quoted amounts into `executed_*` would record a quote as a settlement.
--
-- Adding `agent_activity_launch_confirmed_legs` here would forbid exactly the
-- rows that sweep must write, and push the finalizer toward inventing a value
-- to satisfy the database. Strictness therefore lives in the REPO layer, as it
-- now does for `swap`/`wrap`/`yield_*`: `confirmActivityEvent`
-- (`db/repos/agent-activity/swap-lifecycle.ts`) gains a `token_launch` guard,
-- while `confirmActivityEventStatusOnly` — the sweep-owned finalizer that
-- writes no amount column at all — keeps bypassing it by construction.
--
-- ── CONSTRAINTS VERIFIED AS ALREADY-CORRECT FOR A `launch` ROW ─────────────
--
--   * `agent_activity_kind_family_binding` (049) — scoped
--     `kind NOT IN ('lend','prediction')`, so `launch` is NOT pinned to the
--     Solana synthetic chain. Correct: Trench is EVM-only (4663).
--   * `agent_activity_evm_signed_leg_has_nonce` (045) — a staged launch row
--     MUST carry a nonce. The writer therefore uses `markActivityBroadcast`,
--     never the Solana variant. Intended.
--   * `agent_activity_non_bridge_no_bridge_cols` (049) — a launch row leaves
--     all ten bridge columns NULL; the generic writer never sets them.
--   * `agent_activity_second_leg_roles_only` (053) — allowlists `yield_py` /
--     `yield_lp` only, so `token_launch` is BARRED from the Option-C second-leg
--     family. That is the right answer, not an oversight: a create-with-prebuy
--     is one-in (native) one-out (the new token) and needs no second leg.
--   * `agent_activity_logical_has_session` / `agent_activity_order_id_logical_
--     only` / `agent_activity_normalized_route_logical_only` (045) — all scoped
--     to `bridge_fill_expected`; a launch row is unaffected.
--   * `agent_activity_confirmed_has_hash` / `agent_activity_failed_has_code` /
--     `agent_activity_pending_has_no_terminal_fields` (044, KEPT by 061) —
--     apply to `launch` unchanged and are wanted.
--
-- No new `failure_code`: `simulation_reverted`, `mined_revert`,
-- `broadcast_error`, `allowance_or_balance` and `unknown` already cover every
-- launch failure. A refused image or a breached spend ceiling never reaches the
-- chain at all and is `failure_reason` text under an existing code.
--
-- EXPAND-ONLY. New vocabulary members, new tables, no backfill, no column
-- dropped. Rollback is clean only while no `launch` row exists; once one does,
-- restoring the narrow predicates requires deleting those rows first. Stated so
-- nobody discovers it during an incident.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final.

-- ── 1. `launch` joins the kind vocabulary ───────────────────────────────────

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_valid
      CHECK (kind IN ('swap', 'bridge', 'lend', 'prediction', 'wrap', 'yield', 'launch'));
  END IF;
END$$;

-- ── 2. `token_launch` joins the role vocabulary ─────────────────────────────
--
-- ONE role, not two. A launch has no allowance step (the creation fee and the
-- prebuy are both paid in NATIVE ETH as `msg.value`, and native value needs no
-- ERC-20 approval), and no separate prebuy role (see the header: the prebuy is
-- a leg of the same transaction). A future Trench action that DOES need an
-- approval would reuse `allowance` / `allowance_reset` exactly as Pendle does
-- in 053, rather than forking a Trench-specific role — hence they are admitted
-- to the `launch` arm of the binding below even though nothing writes them yet.

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_event_role_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_event_role_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_event_role_valid
      CHECK (event_role IN (
        'allowance_reset', 'allowance', 'swap',
        'bridge_deposit', 'bridge_fee', 'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund',
        'lend_deposit', 'lend_withdraw', 'lend_borrow_operate',
        'predict_buy', 'predict_sell', 'predict_claim', 'predict_close',
        'wrap', 'unwrap',
        'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim',
        'token_launch'
      ));
  END IF;
END$$;

-- ── 3. The launch arm of the kind↔role binding ──────────────────────────────
--
-- A `launch` row carries `token_launch` (or an allowance role, see above), and
-- nothing else; and no OTHER kind may carry `token_launch`. That second half is
-- the one that matters: it is what makes "never mislabel a launch as a swap"
-- a database fact rather than a convention.

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_role_binding;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_role_binding') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_role_binding
      CHECK (
        (kind = 'swap'   AND event_role IN ('allowance_reset', 'allowance', 'swap'))
        OR
        (kind = 'bridge' AND event_role IN (
          'allowance_reset', 'allowance',
          'bridge_deposit', 'bridge_fee',
          'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund'
        ))
        OR
        (kind = 'lend' AND event_role IN ('lend_deposit', 'lend_withdraw', 'lend_borrow_operate'))
        OR
        (kind = 'prediction' AND event_role IN (
          'predict_buy', 'predict_sell', 'predict_claim', 'predict_close'
        ))
        OR
        (kind = 'wrap' AND event_role IN ('wrap', 'unwrap'))
        OR
        (kind = 'yield' AND event_role IN (
          'allowance_reset', 'allowance',
          'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim'
        ))
        OR
        (kind = 'launch' AND event_role IN (
          'allowance_reset', 'allowance',
          'token_launch'
        ))
      );
  END IF;
END$$;

-- ── 4. `launch_images` — the image LOCKER's metadata (contract C2) ──────────
--
-- GLOBAL and PERSISTENT: an image belongs to the user, never to an intent. An
-- intent stores only an `image_id` reference, and cancelling or expiring an
-- intent NEVER deletes an image.
--
-- METADATA ONLY. The BYTES live main-side under the Electron `userData`
-- directory and never cross to the renderer or into the agent's transcript.
-- This table exists precisely so the `trench.images` handler — which runs in
-- `src/vex-agent`, where no locker service seam exists — can read the metadata
-- through an ordinary DB repo like any other read tool, instead of inventing a
-- new `ProtocolExecutionContext` seam. The BYTE path is the separate C2b
-- resolver (`tools/protocols/trench/launch-image-byte-resolver.ts`).
--
-- NO FOREIGN KEY from `token_launch_intents.image_id` to here, deliberately.
-- C2's lifecycle rule is that deletion refuses while a LIVE (non-terminal)
-- intent references the image — a condition on the referencing row's STATUS,
-- which a foreign key cannot express. `ON DELETE RESTRICT` would refuse forever,
-- including long after every referencing intent went terminal, and `ON DELETE
-- SET NULL` would silently erase the audit trail of which image a completed
-- launch actually committed on-chain. The repo owns the rule; both FK variants
-- would state something false.
--
-- `byte_length <= 20480` is the 20 KB hard cap (a gas ceiling — the image is
-- published on-chain). It is enforced here as well as in the main-side
-- validator so a row can never claim a size the launch path would refuse.
-- `digest` is the sha256 of the STORED bytes: the execute leg re-reads the
-- bytes and verifies this digest against the one bound in the authorization
-- record (C0) before signing, so an image swapped between authorization and
-- execution cannot slip through.

CREATE TABLE IF NOT EXISTS launch_images (
  image_id     TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  byte_length  INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 20480),
  mime         TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  width        INTEGER NOT NULL CHECK (width > 0),
  height       INTEGER NOT NULL CHECK (height > 0),
  digest       TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The locker grid renders most-recent-first; `image_id` breaks ties so the
-- order is total and a keyset page can never repeat or skip a row.
CREATE INDEX IF NOT EXISTS launch_images_recent_idx
  ON launch_images (uploaded_at DESC, image_id DESC);

-- ── 5. `token_launch_intents` — the launch state machine (contract C1) ──────
--
-- Modelled on `025_wallet_intents.sql`, whose session-ownership and CAS
-- invariants the repo copies verbatim: every mutation and lookup carries
-- `session_id` in its predicate, so a confirm/get/cancel from another session
-- MISSES even when the intent id is known.
--
-- ── The state machine, and why the entry state depends on the path ──
--
-- There is no single starting state, because two of the three paths have no
-- form to fill:
--
--   Path 1 (`agent_requested_form`) and a `user`-origin launch:
--     awaiting_user_form -> authorized -> consuming -> broadcast_pending
--                        -> confirmed | terminal_failure
--
--   Path 2 (`agent`, full autonomy) and the RESTRICTED approval path:
--     authorized -> consuming -> broadcast_pending
--                -> confirmed | terminal_failure
--     (no form step — the C0 authorization record IS the entry state)
--
--   cancelled | expired are reachable ONLY from `awaiting_user_form`. Both mean
--   nothing was ever authorized and nothing was ever signed, which is why the
--   CHECK below forbids them a tx hash.
--
-- ── `broadcast_pending` is NONTERMINAL, and that is the point ──
--
-- A launch whose signed submission ended AMBIGUOUSLY (no receipt, an RPC error,
-- a receipt-wait throw) stays `broadcast_pending` WITH its tx hash. It is never
-- resubmittable and never terminalized on a timer — only a DEFINITIVE receipt
-- moves it to `confirmed` or `terminal_failure`, via the repair sweep. This is
-- the same discipline `staged-broadcast` and the `agent_activity` repair path
-- already enforce: ambiguity never terminalizes, because the alternative is
-- re-broadcasting a create that may already have minted a token.
--
-- `failure_reason` is a STRUCTURAL-ONLY label (`ErrorKind:errorHash`), exactly
-- as in `wallet_intents`. Raw RPC/provider errors carry URLs, request bodies,
-- addresses and auth headers; they must never reach this column.
--
-- FK CASCADE on session delete keeps intents garbage-collected with their
-- session — no orphan rows. `launched_tokens` deliberately does NOT cascade
-- (see section 6).

CREATE TABLE IF NOT EXISTS token_launch_intents (
  intent_id           TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Who initiated. `user` = the human opened the dialog themselves and no turn
  -- resumes; `agent_requested_form` = the agent asked, the human filled it, and
  -- the §C3b continuation resumes the agent's turn; `agent` = Path 2, full
  -- autonomy, no human in the loop at any point.
  origin              TEXT NOT NULL CHECK (origin IN ('user', 'agent_requested_form', 'agent')),
  status              TEXT NOT NULL CHECK (status IN (
    'awaiting_user_form',
    'authorized',
    'consuming',
    'broadcast_pending',
    'confirmed',
    'terminal_failure',
    'cancelled',
    'expired'
  )),
  chain_id            BIGINT NOT NULL,
  wallet_address      TEXT NOT NULL,
  -- The form. `links` is an object (site / x / telegram / …); an empty object
  -- is the honest representation of "no links", never NULL.
  name                TEXT NOT NULL,
  symbol              TEXT NOT NULL,
  description         TEXT,
  links               JSONB NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(links) = 'object'),
  -- Reference into `launch_images`. NULL while the form is still being filled;
  -- a Vex launch REFUSES to execute without one (our product rule — the Diamond
  -- itself accepts empty image bytes, which is exactly why we enforce it).
  image_id            TEXT,
  -- rule 90: a raw amount travels with the decimals needed to READ it, or it is
  -- a thousandfold error waiting to happen. Enforced by
  -- `token_launch_intents_prebuy_has_decimals` below.
  prebuy_raw          TEXT,
  prebuy_decimals     SMALLINT,
  -- The C0 authorization record this intent was authorized under. Opaque,
  -- session-bound, single-use; the execute leg CAS-consumes it before signing.
  -- `authorization_kind` names WHICH C0 variant — and `full_autonomy` is
  -- deliberately NOT called consent, because no human acted.
  authorization_id    TEXT,
  authorization_kind  TEXT CHECK (authorization_kind IN (
    'user_submit',
    'approval_card',
    'full_autonomy'
  )),
  authorized_at       TIMESTAMPTZ,
  -- ── The §C3b continuation's durable anchors (Lane F consumes these) ──
  --
  -- Only the `agent_requested_form` path resumes anything: a `user`-origin
  -- launch resumes NOTHING (the human is already here), and an `agent` (Path 2)
  -- launch never parked because it never blocked. So all three are NULLABLE,
  -- with `token_launch_intents_form_path_has_tool_call` below making them
  -- REQUIRED on exactly the path that needs them.
  --
  -- `tool_call_id` is the id of the ORIGINAL parked `trench.launch_request_form`
  -- call. Without it the resumed tool result answers no pending call and the
  -- transcript is orphaned — the agent sits waiting for a reply that can never
  -- be matched to its question.
  tool_call_id        TEXT,
  -- Which mission run to claim on resume. NULL in a chat session, which has no
  -- run to claim.
  mission_run_id      TEXT,
  -- `messages.id` of the appended tool-result row. INTEGER and un-referenced,
  -- mirroring `approval_intents.result_message_id` (056) exactly.
  --
  -- Stamped in the SAME transaction that appends the tool-result row, never
  -- after: that is what makes "resumed with no tool result" UNREPRESENTABLE. A
  -- stamp that throws rolls the transcript row back with it.
  result_message_id   INTEGER,
  -- The create transaction's hash. NULL until the moment it is broadcast, then
  -- NEVER rewritten: the single writer is the CAS in
  -- `token-launch-intents/writers.ts` (`markBroadcastPendingWith`), which
  -- stamps it together with `status = 'broadcast_pending'` and only while it is
  -- still NULL. That is what makes a double broadcast, and a retry that
  -- forgets the first hash, unrepresentable — and it is the only handle the
  -- identity repair has to look a pending launch up on chain
  -- (`reads.ts` selects `broadcast_pending AND tx_hash IS NOT NULL`).
  -- `token_launch_intents_broadcast_has_hash` and
  -- `token_launch_intents_unsigned_exits_have_no_hash` below hold both ends of
  -- that contract.
  tx_hash             TEXT,
  -- Filled from the confirmed receipt's decoded `TokenCreated`, by the launch
  -- handler or — after a crash — by the launch identity repair. NEVER guessed.
  token_address       TEXT,
  failure_reason      TEXT,
  -- ONE expiry for the whole pre-authorization window, and the §C3b
  -- continuation's expiry too — deliberately not a second column. The run is
  -- parked for exactly as long as the form is fillable, so two timestamps could
  -- only ever disagree, and a continuation that expired at a different moment
  -- from the intent it resumes is how a turn hangs forever or resumes against a
  -- form the user can still submit. When this passes, the runtime emits an
  -- honest "it expired" tool result instead of waiting.
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  broadcast_at        TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,
  -- The authorization record as authored at authorize time (the C0 snapshot).
  --
  -- On the AGENT paths this is audit only — the gate there is re-derivation
  -- against an in-memory binding, and reading this back would weaken it.
  -- On the USER_SUBMIT path it is unavoidably gate INPUT: the human consented
  -- in the main process minutes earlier, so this row is the only record of what
  -- they agreed to. It is validated as untrusted input before use
  -- (`handlers/launch/execute-user-submit.ts`); see the doctrine box in
  -- `handlers/launch/authorization.ts` for which path may read it and why.
  authorization_json  JSONB,
  -- Identity-sweep SCHEDULING ONLY — never money, status or identity. Stamped
  -- by `token-launch-intents/sweep-claim.ts` on every row it serves, and the
  -- sweep orders by `COALESCE(last_checked_at, created_at) ASC`. Without it the
  -- candidate window is `created_at ASC LIMIT 25` over a set the sweep may
  -- leave UNCHANGED, so 25 permanently-ambiguous launches starve row 26
  -- forever. Same column and same ordering shape as `agent_activity`
  -- (migration 044) — this is the repo's scheduling pattern, not a new one.
  last_checked_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  -- A prebuy amount whose decimals are unknown is unreadable: "1047061" is 1.05
  -- at 6 decimals and 0.00105 at 9. A writer that cannot state the decimals has
  -- no business claiming the amount. `0` is a real, valid answer and stays
  -- valid — the requirement is NOT NULL, never truthiness.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_launch_intents_prebuy_has_decimals'
  ) THEN
    ALTER TABLE token_launch_intents
      ADD CONSTRAINT token_launch_intents_prebuy_has_decimals
      CHECK (prebuy_raw IS NULL OR prebuy_decimals IS NOT NULL);
  END IF;

  -- FAIL CLOSED. Every state at or past `authorized` must name the C0
  -- authorization record it was authorized under. A launch that reached
  -- `consuming` with no authorization id is precisely the shape C3 says must be
  -- impossible, so the database refuses to hold it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_launch_intents_live_has_authorization'
  ) THEN
    ALTER TABLE token_launch_intents
      ADD CONSTRAINT token_launch_intents_live_has_authorization
      CHECK (
        status IN ('awaiting_user_form', 'cancelled', 'expired')
        OR (authorization_id IS NOT NULL AND authorization_kind IS NOT NULL)
      );
  END IF;

  -- Nothing was ever signed on the pre-authorization exits, so neither may
  -- carry a tx hash. Without this, a bug that cancelled a broadcast intent
  -- would erase the only evidence that a create may be in flight.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_launch_intents_unsigned_exits_have_no_hash'
  ) THEN
    ALTER TABLE token_launch_intents
      ADD CONSTRAINT token_launch_intents_unsigned_exits_have_no_hash
      CHECK (status NOT IN ('cancelled', 'expired') OR tx_hash IS NULL);
  END IF;

  -- FAIL CLOSED on the resume path. An `agent_requested_form` intent exists
  -- BECAUSE an agent's turn is parked on it, so it must name the tool call it
  -- will answer. Without this a row could park a turn it has no way to wake,
  -- and the agent would wait forever for a reply nothing can address to it.
  --
  -- Scoped to that ONE origin, deliberately: a `user`-origin launch resumes
  -- nothing and an `agent` (Path 2) launch never parked, so requiring a tool
  -- call id of either would make an honest row unwritable.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_launch_intents_form_path_has_tool_call'
  ) THEN
    ALTER TABLE token_launch_intents
      ADD CONSTRAINT token_launch_intents_form_path_has_tool_call
      CHECK (origin <> 'agent_requested_form' OR tool_call_id IS NOT NULL);
  END IF;

  -- A result message id asserts that a tool result was appended for a parked
  -- call. It therefore cannot exist without the call it answers — on any origin.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_launch_intents_result_answers_a_call'
  ) THEN
    ALTER TABLE token_launch_intents
      ADD CONSTRAINT token_launch_intents_result_answers_a_call
      CHECK (result_message_id IS NULL OR tool_call_id IS NOT NULL);
  END IF;

  -- A broadcast or settled launch must carry its hash. `broadcast_pending` is
  -- the ambiguous state, and an ambiguous state with no hash is unreconcilable:
  -- the repair sweep would have nothing to look up and the row would sit
  -- forever. `terminal_failure` is EXEMPT — a pre-broadcast refusal (no image,
  -- ceiling breached, simulation reverted) is terminal with nothing signed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_launch_intents_broadcast_has_hash'
  ) THEN
    ALTER TABLE token_launch_intents
      ADD CONSTRAINT token_launch_intents_broadcast_has_hash
      CHECK (status NOT IN ('broadcast_pending', 'confirmed') OR tx_hash IS NOT NULL);
  END IF;
END$$;

-- Session-scoped listing + the pending-discovery hot path the app polls.
CREATE INDEX IF NOT EXISTS token_launch_intents_session_idx
  ON token_launch_intents (session_id, created_at DESC);

-- The expiry sweep and the modal's "is there a launch waiting for me?" query
-- both read only the one pre-authorization state.
CREATE INDEX IF NOT EXISTS token_launch_intents_awaiting_idx
  ON token_launch_intents (expires_at)
  WHERE status = 'awaiting_user_form';

-- The identity-repair candidate set: broadcast-but-unresolved rows, oldest
-- first. Partial, so it stays tiny however many launches have settled.
CREATE INDEX IF NOT EXISTS token_launch_intents_broadcast_pending_idx
  ON token_launch_intents (created_at)
  WHERE status = 'broadcast_pending';

-- ── 6. `launched_tokens` — the durable identity index ──────────────────────
--
-- Answers a different question from `agent_activity`. The activity feed answers
-- "what did the agent DO, and did it settle?"; this table answers "which tokens
-- exist because of me?" — the index behind `trench_my_launches`, keyed by
-- token identity rather than by execution.
--
-- NOT A BARE FAIL-SOFT INSERT. "Launched tokens are saved" must survive a crash
-- between the receipt confirming and this row being written, so the write is
-- keyed to the confirmed launch row and RECONCILED by the idempotent identity
-- repair (`sync/launch-identity-repair.ts`), never left to a single best-effort
-- insert. The unique identity index below is what makes re-running that repair
-- free: `ON CONFLICT (chain_id, LOWER(token_address)) DO NOTHING`.
--
-- `session_id` is nullable and does NOT cascade, unlike `token_launch_intents`.
-- The intent is session state and dies with its session; the TOKEN is a
-- permanent on-chain fact that outlives the conversation that created it.
-- Deleting a session must not erase the user's launch history.
--
-- `initial_buy_raw` travels with `initial_buy_decimals` AND
-- `initial_buy_token_address` for the usual reason (rule 90) — and here the
-- token address is not redundant with `token_address`: the prebuy is denominated
-- in what was SPENT (native ETH), not in what was received.
--
-- UNIT CONTRACT, stated once so no writer has to guess: `initial_buy_raw` is
-- the NATIVE ETH prebuy in WEI, `initial_buy_decimals` is therefore 18, and
-- `initial_buy_token_address` names the native asset — never the launched
-- token. That is the amount the plan authorized and the wallet signed, known
-- before the transaction is even broadcast, so it can never be a guess.
-- The tokens RECEIVED (decoded from `Bought`, arg v2) are the executed OUTPUT
-- leg of the `agent_activity` row for this launch; they do NOT belong here.
-- Writing received units into these columns would report the prebuy at the
-- token's decimals and misprice the launch by orders of magnitude.

CREATE TABLE IF NOT EXISTS launched_tokens (
  id                       BIGSERIAL PRIMARY KEY,
  wallet_address           TEXT NOT NULL,
  chain_id                 BIGINT NOT NULL,
  launchpad                TEXT NOT NULL DEFAULT 'trench_express',
  token_address            TEXT NOT NULL,
  name                     TEXT NOT NULL,
  symbol                   TEXT NOT NULL,
  image_ref                TEXT,
  create_tx_hash           TEXT NOT NULL,
  initial_buy_raw          TEXT,
  initial_buy_decimals     SMALLINT,
  initial_buy_token_address TEXT,
  session_id               TEXT REFERENCES sessions(id),
  protocol_execution_id    BIGINT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'launched_tokens_initial_buy_has_decimals'
  ) THEN
    ALTER TABLE launched_tokens
      ADD CONSTRAINT launched_tokens_initial_buy_has_decimals
      CHECK (
        initial_buy_raw IS NULL
        OR (initial_buy_decimals IS NOT NULL AND initial_buy_token_address IS NOT NULL)
      );
  END IF;
END$$;

-- Token identity is case-insensitive (a checksummed and a lowercased address
-- are the same token). This index IS the idempotency of the identity repair.
CREATE UNIQUE INDEX IF NOT EXISTS launched_tokens_identity_uidx
  ON launched_tokens (chain_id, LOWER(token_address));

-- `trench.my_launches`: one wallet's launches, most recent first. `id DESC`
-- breaks `created_at` ties so the page order is total.
CREATE INDEX IF NOT EXISTS launched_tokens_wallet_history_idx
  ON launched_tokens (LOWER(wallet_address), created_at DESC, id DESC);
