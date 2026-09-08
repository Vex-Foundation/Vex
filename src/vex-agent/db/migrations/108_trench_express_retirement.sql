-- 108: retire the Trench Express protocol in DURABLE state.
--
-- The code half of this retirement deletes the `trench` namespace, its ten
-- tools, its client, ABI, fee venue, attribution client and image serving. This
-- file is the other half: it decides every Trench row the database still holds
-- that could otherwise sit in a LIVE state waiting for a handler that no longer
-- exists, and it leaves confirmed history byte for byte untouched.
--
-- ── THE DOCTRINE, and where it comes from ──────────────────────────────────
--
-- A retirement RE-POINTS state, it does not erase it. Nothing here deletes a
-- launch, an activity row, a launched token, an approval's audit record or a
-- `trench_*` vocabulary value: the legacy decoders in
-- `sync/legacy-trench-express/` still read every confirmed Trench row, and the
-- app labels those rows "Trench Express (legacy)". What this migration ends is
-- only the ability of a retired protocol to hold LIVE money state.
--
-- Precedent in this repository: `048_drop_hyperliquid.sql` (disable the sync
-- job, terminalize only its still-pending runs, keep completed history).
--
-- ── STATUS ONLY IS NEVER THE EVIDENCE ──────────────────────────────────────
--
-- Every statement below that terminalizes a row names the DURABLE EVIDENCE that
-- nothing was signed for it, in its own predicate. A `consuming` intent in
-- particular is NOT classified by its status: the crash window between
-- `markActivityBroadcast` (which stamps the hash on the activity row) and
-- `markBroadcastPendingWith` (which stamps it on the intent) is real, and a row
-- caught in it HAS a signed transaction with a consumed nonce. Terminalizing
-- that would tell the user nothing was signed, which is exactly the sentence
-- they would act on.
--
-- ── IDEMPOTENT BY CONSTRUCTION ─────────────────────────────────────────────
--
-- Every statement is written so a second application is a no-op: each UPDATE's
-- predicate excludes the state that UPDATE produces, each DELETE is
-- set-based, and the two ALTERs are `DROP DEFAULT` / `IF NOT EXISTS` forms.
-- `db/migrate.ts` applies a file once, but a retirement that could not be
-- re-run safely would be one an operator could never repair by hand.
--
-- EXPAND-ONLY on schema: no column is dropped, no CHECK is narrowed, no table
-- is removed. Rollback is `schema_version` only; the row decisions are
-- deliberate and are not reversed by re-running an earlier file.

-- ── 1. Launch intents: the state cross-product ─────────────────────────────
--
-- Scope is `protocol = 'trench'` on every statement. A pools.fun row must be
-- untouched by all of them, and the discriminator is migration 082's.
--
-- The terminal chosen for a row that never signed is `cancelled`, not
-- `terminal_failure`: `terminal_failure` asserts the create was attempted and
-- did not happen, and for these rows it was never attempted at all.
-- `token_launch_intents_unsigned_exits_have_no_hash` (062, restated by 082)
-- already forbids `cancelled` a hash, so every predicate below carries
-- `tx_hash IS NULL` as well - the constraint is the backstop, the predicate is
-- the intent.
--
-- `failure_reason` is written together with the status, and it is MODEL-VISIBLE
-- on the resume path: `sync/launch-form-expiry.ts` reads a cancelled intent's
-- reason back and answers the parked agent turn with it, so the turn learns the
-- protocol was retired rather than being told its form "expired" - which would
-- be a false statement about why the launch did not happen.
--
-- THE PARKED TURNS ARE NOT STRANDED. An `agent_requested_form` intent parks an
-- agent turn on `tool_call_id`. Moving such a row to a terminal status makes it
-- visible to the durable continuation floor
-- (`token-launch-intents/reads.ts listOutstandingUserFormResumes`, predicate
-- `tool_call_id IS NOT NULL AND resume_consumed_at IS NULL` plus
-- `status <> ALL(LIVE_TOKEN_LAUNCH_INTENT_STATUSES)`), which the launch-form
-- expiry sweep drains every 60s. So terminalizing here is what WAKES those
-- turns; leaving the rows live is what would park them forever.

-- 1a. `previewed` - advisory and NON-LIVE by construction (082): no
--     authorization, no hash, no image lock, and it can never transition into
--     signing. Nothing was ever at stake, so it is simply closed.
--     Empty by construction on this protocol (082 added `previewed` for the
--     pools.fun preview lane and no Trench handler ever wrote one), and the
--     statement is written anyway: "the class is empty" is a claim about code
--     that no longer exists, and the row decision has to be recorded either way.
UPDATE token_launch_intents
   SET status         = 'cancelled',
       cancelled_at   = NOW(),
       failure_reason = 'Trench Express was retired: the protocol was removed from Vex, so this preview can never be launched.'
 WHERE protocol = 'trench'
   AND status   = 'previewed'
   AND tx_hash IS NULL;

-- 1b. `awaiting_user_form` - the form is open and nothing is authorized. There
--     is no dialog left to submit it into and no handler left to execute it.
UPDATE token_launch_intents
   SET status         = 'cancelled',
       cancelled_at   = NOW(),
       failure_reason = 'Trench Express was retired: the protocol was removed from Vex, so this launch form can no longer be submitted. Nothing was signed.'
 WHERE protocol = 'trench'
   AND status   = 'awaiting_user_form'
   AND tx_hash IS NULL;

-- 1c. `authorized` WITH NO STAGED HASH - a C0 authorization exists and the
--     execute leg never consumed it. Terminalized WITHOUT execution: the
--     authorization is single-use and nothing will ever claim it now.
--
--     `tx_hash IS NULL` is in the predicate rather than assumed. No writer
--     stamps a hash on an `authorized` row today (`markBroadcastPendingWith` is
--     the single writer and it moves the status in the same statement), and no
--     CHECK forbids the pair, so the migration states the evidence instead of
--     trusting the code that used to hold it.
UPDATE token_launch_intents
   SET status         = 'cancelled',
       cancelled_at   = NOW(),
       failure_reason = 'Trench Express was retired: the protocol was removed from Vex before this authorized launch was executed. Nothing was signed.'
 WHERE protocol = 'trench'
   AND status   = 'authorized'
   AND tx_hash IS NULL;

-- 1d. `consuming` WITH NO SIGNING EVIDENCE ANYWHERE - the execute leg claimed
--     the authorization and died before anything was signed.
--
--     THE EVIDENCE, and why it is not the intent's own column. A `consuming`
--     row never carries a hash of its own: `markBroadcastPendingWith` writes
--     `tx_hash` and `status = 'broadcast_pending'` in ONE statement, so an
--     intent that has a hash is no longer `consuming` by construction. The only
--     window in which a signature exists while the intent still says
--     `consuming` is the crash between `markActivityBroadcast` - which stamps
--     the hash on the durable ACTIVITY row - and that CAS. So the activity row
--     is where the evidence lives, and it is read through the execution that
--     names the tool (`protocol_executions.tool_id`), never inferred from the
--     intent.
--
--     A session that holds ANY staged or broadcast Trench launch row is
--     therefore excluded, even when several launches share the session and the
--     hash may belong to a sibling intent. That is deliberate: the join is
--     session-grained, the cost of a false EXCLUDE is a row left live on a dead
--     protocol, and the cost of a false INCLUDE is telling a user nothing was
--     signed when their gas was spent. Only one of those is acceptable.
UPDATE token_launch_intents i
   SET status         = 'cancelled',
       cancelled_at   = NOW(),
       failure_reason = 'Trench Express was retired: the protocol was removed from Vex while this launch was still being prepared. Nothing was signed.'
 WHERE i.protocol = 'trench'
   AND i.status   = 'consuming'
   AND i.tx_hash IS NULL
   AND NOT EXISTS (
         SELECT 1
           FROM agent_activity a
           JOIN protocol_executions pe ON pe.id = a.protocol_execution_id
          WHERE a.session_id  = i.session_id
            AND pe.namespace  = 'trench'
            AND pe.tool_id    = 'trench.launch_execute'
            AND a.event_role  = 'token_launch'
            AND a.tx_hash IS NOT NULL
       );

-- 1e. THE ROWS THIS MIGRATION DELIBERATELY DOES NOT TOUCH. Each is a decision,
--     not an omission, and there is no statement for them because the correct
--     action is none.
--
--       `consuming` WITH signing evidence - a Trench launch activity row in the
--         same session carries a staged or broadcast hash. Something was signed
--         and gas was spent; the token may exist. Cancelling it would assert
--         the opposite, and stamping the activity row's hash onto the intent
--         would attribute a possibly-foreign transaction to it (the join is
--         session-grained - see 1d). The row keeps its status and its image
--         lock, honestly, and the activity row keeps the hash that reconciles
--         it. This is a NAMED RESIDUAL: such a row is not claimed by the
--         identity sweep, whose candidate set is `broadcast_pending AND
--         tx_hash IS NOT NULL`, and that was already true before this file.
--
--       `broadcast_pending` - PRESERVED WITH ITS HASH, deliberately. This is the
--         ambiguous state the whole identity-repair lane exists for, and the
--         lane survives the retirement: `sync/launch-identity-repair.ts` is
--         protocol-agnostic and decodes the receipt through the kept legacy
--         decoder (`sync/legacy-trench-express/launch-settlement.ts`). A
--         terminalized row here would erase the only evidence of a create that
--         may already be mined.
--
--       `confirmed`, `terminal_failure`, `cancelled`, `expired`,
--         `superseded_unproven` - terminal history. Immutable audit record,
--         still readable through the legacy decoders, still listed by the app
--         under the label "Trench Express (legacy)".

-- ── 2. The latent Trench WRITE default ─────────────────────────────────────
--
-- Migration 082 gave `token_launch_intents.protocol` a DEFAULT of 'trench',
-- correctly: every row that existed then WAS a Trench launch, and the default
-- was the honest backfill. It is now a trapdoor - a writer that forgets the
-- discriminator would silently create a row on a protocol that has no handler.
--
-- The column stays NOT NULL and its CHECK still admits 'trench', because every
-- historical row carries that value and must keep reading back as what it is.
-- What goes is only the ability to write it by omission. The three live callers
-- (`pools/handlers/launch/{request-form,preview,execute/authorize}.ts`) all pass
-- `protocol: "pools_fun"` explicitly, and `CreateTokenLaunchIntentInput.protocol`
-- becomes required in the same change so the type refuses the omission before
-- the database has to.
ALTER TABLE token_launch_intents ALTER COLUMN protocol DROP DEFAULT;

-- ── 3. Pending approvals for Trench tools: DENIED, never dispatched ────────
--
-- An approval card for `trench.trade_execute` or `trench.launch_execute` that
-- is still `pending` would, on the human's click, resolve a tool that no longer
-- exists. It fails closed either way; what it must not do is fail as an
-- "unexpected error" on a money-path card. It is denied here, with its reason
-- recorded, and NOTHING IS DISPATCHED: `execution_status` stays 'not_started',
-- which is exactly what "the human never got to decide, and nothing ran" looks
-- like in this schema.
--
-- IDENTIFYING A TRENCH CARD. `approval_queue.tool_call` is the envelope
-- `engine/core/approval-runtime/tool-call-envelope.ts` writes, and it has two
-- shapes: a protocol tool is canonicalized into
-- `{command: 'execute_tool', args: {toolId}, vex: {originalToolName}}`, and
-- anything with no manifest keeps `{command, args}`. All three keys are matched,
-- because a row written by an older build may carry either shape and the
-- `vex.originalToolName` audit field is the one that survives both.

UPDATE approval_intents ai
   SET decision        = 'rejected',
       decided_at      = NOW(),
       decision_reason = 'Trench Express was retired: the protocol was removed from Vex, so this action can no longer be executed. Nothing was dispatched.'
  FROM approval_queue aq
 WHERE aq.id = ai.approval_id
   AND ai.decision IS NULL
   AND aq.status = 'pending'
   AND (
         aq.tool_call->'args'->>'toolId'   LIKE 'trench.%'
      OR aq.tool_call->>'command'          LIKE 'trench.%'
      OR aq.tool_call->>'command'          LIKE 'trench\_\_%'
      OR aq.tool_call->'vex'->>'originalToolName' LIKE 'trench%'
       );

UPDATE approval_queue
   SET status      = 'rejected',
       resolved_at = NOW()
 WHERE status = 'pending'
   AND (
         tool_call->'args'->>'toolId'   LIKE 'trench.%'
      OR tool_call->>'command'          LIKE 'trench.%'
      OR tool_call->>'command'          LIKE 'trench\_\_%'
      OR tool_call->'vex'->>'originalToolName' LIKE 'trench%'
       );

-- The mission run parked on such a card would otherwise sit in
-- `paused_approval` forever: the runtime resumes a run from the DECISION side
-- effects, and this decision was taken outside the runtime, so no side effect
-- ran. `paused_error` is the repo's own name for exactly that condition
-- ("decision resolved but no post-tx work completed" -
-- `engine/core/approval-runtime/post-tx/recovery.ts`), and it is the state an
-- operator can `/retry` out of. The run is NOT terminalized: the user's mission
-- is theirs to end.
--
-- `mission_runs.status` is plain TEXT with no CHECK (migration 031 records
-- this), so no constraint restatement is required.
UPDATE mission_runs mr
   SET status = 'paused_error'
  FROM approval_intents ai
       JOIN approval_queue aq ON aq.id = ai.approval_id
 WHERE ai.mission_run_id = mr.id
   AND mr.status = 'paused_approval'
   AND ai.decision = 'rejected'
   AND aq.status = 'rejected'
   AND aq.resolved_at IS NOT NULL
   AND (
         aq.tool_call->'args'->>'toolId'   LIKE 'trench.%'
      OR aq.tool_call->>'command'          LIKE 'trench.%'
      OR aq.tool_call->>'command'          LIKE 'trench\_\_%'
      OR aq.tool_call->'vex'->>'originalToolName' LIKE 'trench%'
       );

-- ── 4. The Trench attribution sync job ─────────────────────────────────────
--
-- `048_drop_hyperliquid.sql`'s pattern verbatim, and for its reason: deleting
-- the seed definition only fixes FRESH databases. An already-installed database
-- still carries the enabled `_global/launch_attribution` periodic job from
-- `seedSyncJobs()`, and a live `syncTick` would keep meeting it as unknown work
-- forever. The job row is DISABLED rather than deleted so the operator can see
-- what it was; completed run history stays as audit record.
UPDATE protocol_sync_jobs
   SET enabled = false
 WHERE sync_type = 'launch_attribution'
   AND enabled;

UPDATE protocol_sync_runs
   SET status  = 'failed',
       ended_at = NOW(),
       error   = 'retired: Trench Express removed'
 WHERE status IN ('pending', 'running')
   AND sync_job_id IN (
         SELECT id FROM protocol_sync_jobs WHERE sync_type = 'launch_attribution'
       );

-- ── 5. Persisted tool embeddings for the ten retired tools ─────────────────
--
-- `tool_embeddings` is a durable recall index keyed by `tool_id`. The reconcile
-- pass would eventually purge these through `deleteOrphanedToolEmbeddings`, but
-- only after a successful embed run against a reachable provider - so until
-- then semantic tool search would keep returning ten tools that cannot be
-- called. Deterministic and immediate here, keyed by the namespace the rows
-- were written under; the `tool_id` prefix is matched as well so a row whose
-- namespace column was ever written differently is still removed.
DELETE FROM tool_embeddings
 WHERE namespace = 'trench'
    OR tool_id LIKE 'trench.%';
