/**
 * AgentScan reporting repo — the state singleton + outbox behind the
 * `agentscan_report` sync lane (migration 073).
 *
 * ── The diff scan, not writer hooks ────────────────────────────────────────
 *
 * `enqueueEligibleActivity` is the ONLY producer of outbox rows. It diffs
 * `agent_activity` against the outbox's `UNIQUE (activity_id, status)` pair,
 * so it captures both brand-new rows and status transitions idempotently —
 * with ZERO code in the money-path writers. Completed outbox rows are kept
 * forever as the report-log; deleting them would let the scan re-enqueue the
 * same pair on every tick.
 *
 * ── Claim-and-stamp (crash-safe drain) ─────────────────────────────────────
 *
 * `claimDueOutbox` bumps `attempt_count` and pushes `next_attempt_at`
 * (exponential, capped 1 h) BEFORE the caller sends, exactly like the
 * launch-attribution lane: a crash mid-send retries after the backoff instead
 * of hot-looping, and the server deduplicates retried batches, so re-sending
 * is always safe. `rescheduleOutbox` overrides the stamp when the server
 * answered with its own `Retry-After`.
 *
 * ── What never goes in here ────────────────────────────────────────────────
 *
 * `last_error` carries status/code words only ("429 rate_limited"), never
 * response bodies and never the ingest token. The eligibility predicate keeps
 * rows the ingest contract cannot express (the approval roles the server's enum
 * does not contain) out of the outbox entirely.
 */

import type { PoolClient } from "pg";
import { query, queryOne, execute, executeWith, queryOneWith, withTransaction } from "../client.js";

export type AgentscanStopReason = "consent_revoked" | "quarantined" | "agent_conflict" | "wallet_conflict";

export interface AgentscanReportingState {
  readonly agentHash: string | null;
  readonly ingestToken: string | null;
  readonly consentVersion: number;
  readonly acceptedAt: string | null;
  readonly registeredAt: string | null;
  readonly registerAttemptCount: number;
  readonly nextRegisterAttemptAt: string;
  readonly backfillEnqueuedAt: string | null;
  /**
   * Which reporting vocabulary this install's DATABASE carries (migration 102
   * stamps 2). It says which roles the schema can STORE, never which roles a
   * backfill has already covered - that is `backfillVocabularyVersion`.
   */
  readonly vocabularyVersion: number;
  /**
   * Which vocabulary the LAST COMPLETED controlled backfill actually scanned,
   * `null` when no backfill has ever completed on this install.
   *
   * Separate from `vocabularyVersion` because the two answer different
   * questions, and conflating them is how an older binary defeats the gate: a
   * build whose `AGENTSCAN_VOCABULARY_VERSION` is 1, running against a database
   * migration 102 has already stamped at 2, scans only the V1 roles and would
   * otherwise leave behind a completion mark that the next V2 build reads as
   * "the family history is already covered" - and every historical family row
   * then reaches the server labelled as live activity. The stamp is written by
   * the marking transaction with the version the scan itself ran under, so it
   * can only ever say what was really covered.
   */
  readonly backfillVocabularyVersion: number | null;
  /**
   * Bumped by every registration reset (`resetForReRegistration`,
   * `resetIdentityForRecovery`). The controlled backfill carries the generation
   * it started under and refuses to write its completion mark if that generation
   * has moved, so a 401 reset landing mid-backfill is never overwritten by the
   * stale mark that started before it.
   */
  readonly registrationGeneration: number;
  readonly stoppedReason: AgentscanStopReason | null;
  /** Display name AgentScan bound to this install (session/complete response). */
  readonly agentName: string | null;
  /** When the last successful wallet-binding handshake completed. */
  readonly lastHandshakeAt: string | null;
  /** session/complete's syncState.lastAcceptedRowId — null for a brand-new agent. */
  readonly serverCursorRowId: number | null;
  /** sha256 of the sorted chainFamily:address inventory list the last handshake covered. */
  readonly boundWalletsFingerprint: string | null;
}

export interface ClaimedOutboxEvent {
  readonly outboxId: number;
  readonly activityId: number;
  readonly status: "pending" | "confirmed" | "definitively_failed" | "superseded_unproven";
  readonly backfill: boolean;
  /** Raw `agent_activity` row for payload building; null if the row vanished between claim and read. */
  readonly activity: Record<string, unknown> | null;
}

/**
 * WHAT IS REPORTABLE AT ALL - the single source of truth for the diff scan,
 * split by VOCABULARY VERSION because the two halves are gated differently.
 *
 * It is the contract vocabulary the server's closed enums accept, minus the
 * deliberate exclusions named below:
 *
 * `allowance` / `allowance_reset` are absent because the server's role enum does
 * not contain them, so every such event would be rejected item by item.
 * Approvals are still recorded locally; they simply have nowhere to go.
 *
 * `wrap`/`unwrap` are in the server's vocabulary and DO have a producer in this
 * install now (the `WalletWrapPrepare`/`WalletWrapConfirm` pair). They are still
 * left out, and the gate is named rather than assumed: adding `'wrap'` to the
 * kind list and the `wrap`/`unwrap` roles to the role list is blocked on a LIVE
 * confirmation that the AgentScan server's ingest accepts kind `wrap` for both
 * directions INCLUDING the pending states. A kind the server rejects costs batch
 * items, and an amount it cannot verify costs strikes, so the vocabulary is
 * proven against the running server before rows are sent, not inferred from the
 * enum it publishes.
 *
 * `pools_fee` is likewise still absent, and that is a NAMED GAP rather than a
 * decision: the server has admitted it on the `launch` arm since its own
 * migration 0015, and no pools.fun launch fee this install charges has ever been
 * reported. Closing it belongs with the lane that owns the pools launch writer,
 * because the same change has to decide what the historical rows mean.
 *
 * `wallet_transfer` and the `transaction` kind's five roles are absent for the
 * same reason as `wrap`: present in the server's vocabulary, never proven live.
 */
const ELIGIBLE_STATUS_AND_FAMILY_SQL = `
      a.status IN ('pending','confirmed','definitively_failed','superseded_unproven')
  AND a.chain_family IN ('eip155','solana')`;

/** The vocabulary every install has always reported. Ungated. */
const ELIGIBLE_VOCABULARY_V1_SQL = `(
      a.kind IN ('swap','bridge','lend','prediction','yield','launch')
  AND a.event_role IN (
        'swap','swap_fee','trench_fee',
        'bridge_deposit','bridge_fee','bridge_fill_expected','bridge_fill_observed','bridge_refund',
        'lend_deposit','lend_withdraw','lend_borrow_operate',
        'predict_buy','predict_sell','predict_claim','predict_close',
        'yield_pt','yield_yt','yield_py','yield_lp','yield_sy','yield_claim',
        'token_launch'))`;

/**
 * The launchpad family and the venue-independent fee leg (migration 102). Every
 * arm mirrors the server's `ROLES_BY_KIND`: the claim kind carries the three new
 * claim roles beside `pools_claim`, `launch_cancel` rides the launch kind, and
 * `vex_fee` is admitted on swap, bridge and launch and nowhere else.
 *
 * `pools_claim` joins HERE rather than in V1 even though the role predates this
 * migration: no install has ever reported one, so admitting it makes historical
 * rows newly eligible, which is exactly the population the version gate exists
 * to route through the controlled backfill.
 */
const ELIGIBLE_VOCABULARY_V2_SQL = `(
      (a.kind = 'claim'
       AND a.event_role IN ('pools_claim','creator_fee_claim','holder_reward_claim','reward_distribution'))
   OR (a.kind = 'launch' AND a.event_role = 'launch_cancel')
   OR (a.kind IN ('swap','bridge','launch') AND a.event_role = 'vex_fee'))`;

/**
 * The vocabulary version this build writes and reports. Migration 102 stamps the
 * same number onto `agentscan_reporting_state.vocabulary_version`, so a build
 * running against a database that has not applied it stays on V1 - it cannot
 * report a role its own CHECK constraint would refuse to store.
 */
export const AGENTSCAN_VOCABULARY_VERSION = 2;

/**
 * THE BACKFILL GATE ON THE WIDENED VOCABULARY, and the defect it exists to
 * prevent.
 *
 * Widening the reportable vocabulary makes rows that ALREADY EXIST newly
 * eligible. The scan runs in two modes: the one-time BACKFILL (`backfill =
 * TRUE`, "this is history") and the incremental tick (`backfill = FALSE`, "this
 * just happened"). Whichever runs first claims the whole newly-eligible
 * population, because a completed outbox row is never re-enqueued and never
 * re-sent. If the incremental tick got there first, months of historical claim
 * rows would reach the server labelled as live activity - a lie it has no way to
 * detect and this install no way to correct.
 *
 * So the new vocabulary is admitted only when BOTH hold:
 *   - the database carries the widening (`vocabulary_version >= 2`), and
 *   - this scan is either the controlled backfill itself, or it runs after a
 *     backfill THAT COVERED THIS VOCABULARY completed
 *     (`backfill_vocabulary_version >= 2`).
 *
 * THE SECOND CONDITION IS A VERSION AND NOT A TIMESTAMP, and that is the whole
 * point of it. `backfill_enqueued_at IS NOT NULL` says only that SOME backfill
 * ran; it cannot say which vocabulary that backfill scanned. A build at
 * `AGENTSCAN_VOCABULARY_VERSION = 1` running against a database migration 102
 * has already stamped at 2 - an older binary on a migrated install, which is an
 * ordinary state during a staged rollout - performs a V1-ONLY scan and, under
 * the timestamp gate, leaves a mark the next V2 build reads as "the family
 * history is covered". Every historical claim row then reaches the server
 * labelled live activity. The version stamp is written by the marking
 * transaction with the version the scan actually ran under, so it can only say
 * what was really covered, and a V1 mark cannot satisfy a V2 gate.
 *
 * That is the VS Code one-time-migration shape (a durable done-marker, the work
 * skipped when it is present, the marker written after the work) applied to a
 * set query: migration 102 resets the marker, the next periodic run enqueues the
 * history under it, and every incremental tick before that mark refuses the new
 * roles instead of stealing them.
 *
 * `$1` is the scan's own backfill flag, cast so Postgres reads it as a boolean
 * in both the predicate and the inserted column.
 */
const ELIGIBILITY_SQL = `
      ${ELIGIBLE_STATUS_AND_FAMILY_SQL}
  AND (
        ${ELIGIBLE_VOCABULARY_V1_SQL}
     OR (${ELIGIBLE_VOCABULARY_V2_SQL}
         AND s.vocabulary_version >= ${AGENTSCAN_VOCABULARY_VERSION}
         AND ($1::boolean
              OR s.backfill_vocabulary_version >= ${AGENTSCAN_VOCABULARY_VERSION}))
      )`;

/**
 * How long a confirmed row may wait for its executed amounts before it is
 * reported without them.
 *
 * The amounts have to ride the TERMINAL event: the server's only merge window
 * is `pending -> terminal`, and a second terminal event for the same pair is
 * silently dropped, so an amount that arrives after the confirmed event was
 * sent can never reach the server. Holding is therefore the only way to report
 * a settled amount at all. The grace bounds the hold: a decoder that never
 * finishes, or a lane that is not running, must not make the activity itself
 * invisible.
 */
const CONFIRMED_AMOUNT_GRACE_MINUTES = 15;

/** The roles whose completeness means BOTH executed legs. */
const BOTH_LEGS_ROLES_SQL = `(
  'swap','wrap','unwrap','token_launch',
  'yield_pt','yield_yt','yield_sy',
  'predict_buy','predict_sell','predict_claim','predict_close')`;

/**
 * The LEND roles: required legs follow the tokens the row itself populated. A
 * vault deposit/withdrawal populates both sides (asset <-> shares) and so still
 * requires both; a direct-market operation moves exactly ONE token and requires
 * only that side.
 */
const LEND_ROLES_SQL = `('lend_deposit','lend_withdraw','lend_borrow_operate')`;

/**
 * The CLAIM-KIND roles that PAY the wallet, and therefore owe their payout
 * before the terminal event is reported.
 *
 * `pools_claim` proved the shape: `collectAndClaim` returns the launched token
 * and the asset it was paired against together, so a row carrying one and not
 * the other has read half a settlement. Migration 102's `creator_fee_claim` and
 * `holder_reward_claim` are that same shape under venue-independent names, and
 * the AgentScan contract admits exactly these three on its second-output-leg
 * allowlist (`SECOND_LEG_ROLES`).
 *
 * `reward_distribution` is deliberately NOT here. The caller of `distribute()`
 * is paid nothing, so there is no leg of theirs to wait for; requiring one would
 * hold every honest distribute for the full grace and then report it amountless
 * anyway. Its amounts are optional on both sides of the wire.
 *
 * A zero is a PROVEN amount, not a missing one, which is why every test here is
 * on the field's presence rather than on its value.
 */
const CLAIM_FAMILY_PAYOUT_ROLES_SQL = `('pools_claim','creator_fee_claim','holder_reward_claim')`;

/**
 * "This row's role has every executed leg it requires" — the SQL mirror of
 * `roleLegsIncomplete` (`./agent-activity/role-legs.ts`), negated.
 *
 * A mirror rather than a shared implementation because the scan is one set
 * query over the whole table and cannot call a row predicate. It must be kept
 * arm for arm with that function: `yield_claim` is output-only,
 * `bridge_deposit` is input-only, the second legs are required only where the
 * row populated their tokens, the LEND roles require each FIRST leg on those
 * same terms (a vault row populates both token sides and needs both, a
 * direct-market row moves exactly ONE token and needs one), and a role that
 * bears no amounts is never incomplete. The claim family proves its OUTPUTS
 * only (it spends nothing), `launch_cancel` waits for the refund only when the
 * row itself declared the token it is refunded in, and `reward_distribution`
 * and `vex_fee` bear no required amounts at all.
 */
const ROLE_LEGS_COMPLETE_SQL = `
  CASE
    WHEN a.event_role = 'yield_claim' THEN a.executed_amount_out_raw IS NOT NULL
    WHEN a.event_role = 'bridge_deposit' THEN a.executed_amount_in_raw IS NOT NULL
    WHEN a.event_role IN ${CLAIM_FAMILY_PAYOUT_ROLES_SQL} THEN
      a.executed_amount_out_raw IS NOT NULL
      AND (a.token_out2_address IS NULL OR a.executed_amount_out2_raw IS NOT NULL)
    WHEN a.event_role = 'launch_cancel' THEN
      (a.token_out_address IS NULL OR a.executed_amount_out_raw IS NOT NULL)
    WHEN a.event_role IN ${LEND_ROLES_SQL} THEN
      (a.token_in_address IS NULL OR a.executed_amount_in_raw IS NOT NULL)
      AND (a.token_out_address IS NULL OR a.executed_amount_out_raw IS NOT NULL)
    WHEN a.event_role IN ('yield_py','yield_lp') THEN
      a.executed_amount_in_raw IS NOT NULL
      AND a.executed_amount_out_raw IS NOT NULL
      AND (a.token_in2_address IS NULL OR a.executed_amount_in2_raw IS NOT NULL)
      AND (a.token_out2_address IS NULL OR a.executed_amount_out2_raw IS NOT NULL)
    WHEN a.event_role IN ${BOTH_LEGS_ROLES_SQL} THEN
      a.executed_amount_in_raw IS NOT NULL AND a.executed_amount_out_raw IS NOT NULL
    ELSE TRUE
  END`;

/**
 * The settlement provenances that END the wait without amounts: a decoder that
 * declined by name (`noteSettlementDeclined`) and the durable quarantine two
 * disagreeing decoders leave behind. Each is a CONCLUSION that no reportable
 * amount is coming, so holding the row longer would only delay the activity.
 */
const SETTLEMENT_CONCLUDED_WITHOUT_AMOUNTS_SQL =
  `a.settlement_source IN ('amounts_incomplete','amounts_undecodable','conflict_quarantined')`;

/**
 * HOLD A CONFIRMED ROW UNTIL ITS MONEY IS KNOWN — the readiness gate, applied
 * before the pair is ever enqueued.
 *
 * The server merges `pending -> terminal` exactly once and silently drops a
 * repeat of a terminal pair, so executed amounts that miss their own confirmed
 * event are lost to it forever. Enqueueing the pending snapshot immediately and
 * the confirmed snapshot only when its amounts are settled is what makes the
 * one merge window carry the money.
 *
 * Three ways out, so the hold can never be permanent: the amounts arrived, a
 * decoder concluded by name that none are coming, or the grace elapsed. Every
 * other status bypasses the gate entirely — a pending row has no amounts to
 * wait for, and neither a definitive failure nor a superseded row ever will.
 */
const CONFIRMED_READINESS_SQL = `
  (a.status <> 'confirmed'
   OR ${ROLE_LEGS_COMPLETE_SQL}
   OR ${SETTLEMENT_CONCLUDED_WITHOUT_AMOUNTS_SQL}
   OR a.confirmed_at IS NULL
   OR a.confirmed_at < NOW() - make_interval(mins => ${CONFIRMED_AMOUNT_GRACE_MINUTES}))`;

/** Exponential claim backoff: 30 s · 2^n, capped at 1 h (exponent clamped so POWER stays finite). */
const CLAIM_BACKOFF_SQL = `LEAST(30 * POWER(2, LEAST(o.attempt_count, 20)), 3600)`;

async function ensureSingleton(): Promise<void> {
  await execute(
    `INSERT INTO agentscan_reporting_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  );
}

interface StateRow {
  agent_hash: string | null;
  ingest_token: string | null;
  consent_version: number;
  accepted_at: Date | null;
  registered_at: Date | null;
  register_attempt_count: number;
  next_register_attempt_at: Date;
  backfill_enqueued_at: Date | null;
  vocabulary_version: number;
  backfill_vocabulary_version: number | null;
  registration_generation: number;
  stopped_reason: AgentscanStopReason | null;
  agent_name: string | null;
  last_handshake_at: Date | null;
  server_cursor_row_id: string | number | null;
  bound_wallets_fingerprint: string | null;
}

function mapState(row: StateRow): AgentscanReportingState {
  return {
    agentHash: row.agent_hash,
    ingestToken: row.ingest_token,
    consentVersion: Number(row.consent_version),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
    registerAttemptCount: Number(row.register_attempt_count),
    nextRegisterAttemptAt: new Date(row.next_register_attempt_at).toISOString(),
    backfillEnqueuedAt: row.backfill_enqueued_at ? new Date(row.backfill_enqueued_at).toISOString() : null,
    vocabularyVersion: Number(row.vocabulary_version),
    backfillVocabularyVersion:
      row.backfill_vocabulary_version === null ? null : Number(row.backfill_vocabulary_version),
    registrationGeneration: Number(row.registration_generation),
    stoppedReason: row.stopped_reason,
    agentName: row.agent_name,
    lastHandshakeAt: row.last_handshake_at ? new Date(row.last_handshake_at).toISOString() : null,
    serverCursorRowId: row.server_cursor_row_id === null ? null : Number(row.server_cursor_row_id),
    boundWalletsFingerprint: row.bound_wallets_fingerprint,
  };
}

export async function getReportingState(): Promise<AgentscanReportingState> {
  await ensureSingleton();
  const row = await queryOne<StateRow>(`SELECT * FROM agentscan_reporting_state WHERE id = 1`);
  if (!row) throw new Error("agentscan_reporting_state singleton missing after ensure");
  return mapState(row);
}

/**
 * Store an identity IF none exists yet; an already-stored identity always
 * wins. The `agent_hash IS NULL` guard (not a read-then-write) is what makes
 * concurrent callers safe — exactly one generator result is ever persisted.
 */
export async function ensureIdentity(
  gen: () => { agentHash: string; ingestToken: string },
): Promise<AgentscanReportingState> {
  await ensureSingleton();
  const identity = gen();
  await execute(
    `UPDATE agentscan_reporting_state
        SET agent_hash = $1, ingest_token = $2, accepted_at = NOW(), updated_at = NOW()
      WHERE id = 1 AND agent_hash IS NULL`,
    [identity.agentHash, identity.ingestToken],
  );
  return getReportingState();
}

export interface MarkHandshakeCompleteInput {
  /** Display name AgentScan bound to this install (session/complete response). */
  readonly agentName: string;
  /** The ROTATED token session/complete returned — replaces whatever was stored. */
  readonly ingestToken: string;
  /** session/complete's syncState.lastAcceptedRowId — null for a brand-new agent. */
  readonly serverCursorRowId: number | null;
  /** sha256 of the sorted chainFamily:address inventory list this handshake covered. */
  readonly walletsFingerprint: string;
}

/**
 * A successful wallet-binding handshake (session/start → sign → session/complete):
 * rotate the stored token, stamp `registered_at` (kept in sync so the existing
 * backfill/drain gate needs no change) and `last_handshake_at`, store the
 * server's name/cursor/fingerprint, and reset the attempt backoff to 0/now —
 * a stale attempt count from a PRIOR failed handshake must not throttle the
 * NEXT one this success has nothing to do with.
 */
export async function markHandshakeComplete(input: MarkHandshakeCompleteInput): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET ingest_token = $1,
            agent_name = $2,
            server_cursor_row_id = $3,
            bound_wallets_fingerprint = $4,
            registered_at = NOW(),
            last_handshake_at = NOW(),
            register_attempt_count = 0,
            next_register_attempt_at = NOW(),
            updated_at = NOW()
      WHERE id = 1`,
    [input.ingestToken, input.agentName, input.serverCursorRowId, input.walletsFingerprint],
  );
}

/** A failed register attempt: bump the counter, hold the next try for `delaySeconds`. */
export async function noteRegisterAttemptFailed(delaySeconds: number): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET register_attempt_count = register_attempt_count + 1,
            next_register_attempt_at = NOW() + make_interval(secs => $1::float8),
            updated_at = NOW()
      WHERE id = 1`,
    [delaySeconds],
  );
}

/**
 * Shared by `resetForReRegistration` and `resetIdentityForRecovery`: EVERY
 * non-poisoned outbox row becomes owed again and flagged `backfill` (a
 * historical resend, not fresh activity). Poisoned rows (`rejected_at`) stay
 * poisoned - a validation refusal the server made once does not become valid by
 * resending the identical payload. Caller runs this inside its own transaction
 * alongside its own state reset, so a crash can't leave one half applied.
 *
 * SENT AND UNSENT ALIKE, and the unsent half is the one this rule exists for.
 * The reset used to be scoped to `sent_at IS NOT NULL`, which reads as "only a
 * row the server already saw needs resending". That is wrong for the state this
 * path is entered from: the 401 that triggers it arrives while a batch is in
 * flight, so the rows that were being sent when the identity went away are
 * exactly the ones still `sent_at IS NULL` and still `backfill = FALSE`. Left
 * untouched, they survive the reset and the drain later sends this install's
 * historical activity to a freshly-registered agent labelled as LIVE. The
 * controlled backfill cannot rescue them either: `enqueueEligibleActivity` is a
 * diff on `(activity_id, status)` and those pairs already have rows, so it
 * inserts nothing and the mislabelling is permanent. Resetting an unsent row is
 * otherwise a no-op on its own terms - it was owed before and is owed after.
 */
async function resetOutboxForFullResend(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE agentscan_outbox
        SET sent_at = NULL, attempt_count = 0, next_attempt_at = NOW(), backfill = TRUE, last_error = NULL
      WHERE rejected_at IS NULL`,
  );
}

/**
 * `auth_lost` recovery (401/403-not_registered on send): the server no longer
 * knows this install (a server-side reset is the expected cause), so it also
 * has none of the history this install already sent. Registration is
 * idempotent — the lane simply re-registers the SAME identity next tick — but
 * the diff scan's NOT-EXISTS can never re-enqueue a pair that already has an
 * outbox row, so a full resend has to come from resetting the existing rows,
 * not from re-scanning. The identity itself (agent_hash/ingest_token) is left
 * untouched: this path is for when the SERVER has forgotten the install, not
 * for when the CLIENT's stored token has drifted from what the server
 * actually holds (that case is `resetIdentityForRecovery`, below).
 */
export async function resetForReRegistration(): Promise<void> {
  await ensureSingleton();
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE agentscan_reporting_state
          SET registered_at = NULL,
              backfill_enqueued_at = NULL,
              backfill_vocabulary_version = NULL,
              registration_generation = registration_generation + 1,
              updated_at = NOW()
        WHERE id = 1`,
    );
    await resetOutboxForFullResend(client);
  });
}

/**
 * `auth_lost` recovery for a session/complete `401` on an EXISTING binding
 * (token mismatch): unlike `resetForReRegistration`, this is NOT recoverable
 * by retrying the same identity, because the server holds SOME current token
 * for this agent_hash that this install does not know (the canonical cause:
 * a crash between the server committing a rotation and this install
 * persisting it via `markHandshakeComplete` — the next handshake attempt
 * would keep presenting the same stale bearer forever, an infinite 401 loop).
 * The only way out is to abandon the identity entirely: clear agent_hash,
 * ingest_token, agent_name, bound_wallets_fingerprint, and every
 * registration/backfill/handshake stamp, and reset the attempt backoff so
 * the next tick retries immediately. `ensureIdentity` then mints a FRESH
 * agent_hash/ingest_token next run, and the server's transfer-on-proof
 * semantics (sprint lead addendum) re-bind the same proven wallets to it —
 * that is the designed recovery, not a data-loss path. The outbox reset is
 * the same full-resend as `resetForReRegistration`, in the same transaction.
 */
export async function resetIdentityForRecovery(): Promise<void> {
  await ensureSingleton();
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE agentscan_reporting_state
          SET agent_hash = NULL,
              ingest_token = NULL,
              agent_name = NULL,
              bound_wallets_fingerprint = NULL,
              registered_at = NULL,
              backfill_enqueued_at = NULL,
              backfill_vocabulary_version = NULL,
              registration_generation = registration_generation + 1,
              last_handshake_at = NULL,
              server_cursor_row_id = NULL,
              register_attempt_count = 0,
              next_register_attempt_at = NOW(),
              updated_at = NOW()
        WHERE id = 1`,
    );
    await resetOutboxForFullResend(client);
  });
}

/** Permanent stop — 410, 403-quarantined, or a register 409. Never auto-cleared. */
export async function markStopped(reason: AgentscanStopReason): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET stopped_reason = $1, stopped_at = NOW(), updated_at = NOW()
      WHERE id = 1`,
    [reason],
  );
}


/**
 * The diff scan. Inserts every eligible-AND-READY (activity, status) pair the
 * outbox has never seen; returns how many were enqueued. `backfill` stamps the
 * rows as belonging to the one-time post-registration history send.
 *
 * A confirmed pair that is held back by `CONFIRMED_READINESS_SQL` is not lost:
 * the scan is a diff, so the next tick that finds it ready enqueues it then.
 * The same is true of a row held back by the vocabulary gate: the controlled
 * backfill picks it up, and every scan after that mark sees it.
 */
const ENQUEUE_ELIGIBLE_SQL = `
     INSERT INTO agentscan_outbox (activity_id, status, backfill)
     SELECT a.id, a.status, $1::boolean
       FROM agent_activity a
      CROSS JOIN (
             SELECT vocabulary_version, backfill_vocabulary_version
               FROM agentscan_reporting_state
              WHERE id = 1
           ) s
      WHERE ${ELIGIBILITY_SQL}
        AND ${CONFIRMED_READINESS_SQL}
        AND NOT EXISTS (SELECT 1 FROM agentscan_outbox o
                         WHERE o.activity_id = a.id AND o.status = a.status)
     ON CONFLICT (activity_id, status) DO NOTHING`;

export async function enqueueEligibleActivity(backfill: boolean): Promise<number> {
  // The singleton has to exist before the CROSS JOIN below, or the scan reads
  // zero state rows and enqueues nothing at all - a silent no-op, not an error.
  await ensureSingleton();
  return execute(ENQUEUE_ELIGIBLE_SQL, [backfill]);
}

/** What one attempt at the controlled backfill did, whether or not it got to mark. */
export interface BackfillEnqueueOutcome {
  /** Rows this attempt enqueued as history. `0` when it declined to run. */
  readonly enqueued: number;
  /** Whether the completion mark was written. `false` means the backfill is still owed. */
  readonly marked: boolean;
  /**
   * Why the attempt declined, `null` when it ran. `generation_moved`: a
   * registration reset landed after the caller read its state, so this scan
   * belongs to an identity that no longer exists. `already_marked`: a concurrent
   * runner completed the same backfill first.
   */
  readonly declined: "generation_moved" | "already_marked" | null;
}

/**
 * THE CONTROLLED BACKFILL, ENQUEUE AND COMPLETION MARK IN ONE TRANSACTION.
 *
 * Two commits used to do this - `enqueueEligibleActivity(true)` and then
 * `markBackfillEnqueued()` - and the window between them is a lost update. The
 * 401 lane (`resetForReRegistration`) clears `backfill_enqueued_at` because the
 * whole history is owed again; if that reset lands after the enqueue commits and
 * before the mark does, the mark writes the timestamp straight back over it. The
 * install then believes a backfill it never ran is complete, and every
 * newly-eligible historical row that the reset made owed is picked up by the
 * next INCREMENTAL tick and reported as live activity.
 *
 * The fix is the one shape that makes the two halves one fact: a single
 * transaction that takes `SELECT ... FOR UPDATE` on the singleton before it
 * scans, so a concurrent reset either completes entirely before this attempt or
 * waits behind it, and never interleaves.
 *
 * THE GENERATION IS THE SECOND HALF OF THE GUARD, and it covers what the lock
 * cannot: a reset that landed BEFORE this transaction started, after the caller
 * read the state that made it decide to backfill. The caller passes the
 * generation it saw; a different one under the lock means this scan was decided
 * against an identity that no longer exists, so the attempt declines without
 * enqueueing or marking and the next tick starts over on the current one.
 *
 * The mark stamps `backfill_vocabulary_version` with the version THIS scan ran
 * under, never the schema's, and never walks it backwards - see
 * `AgentscanReportingState.backfillVocabularyVersion` for why an older binary
 * must not be able to satisfy a newer gate.
 */
export async function enqueueBackfillAndMark(input: {
  startedAtGeneration: number;
}): Promise<BackfillEnqueueOutcome> {
  await ensureSingleton();
  return withTransaction(async (client) => {
    const locked = await queryOneWith<{
      registration_generation: number;
      backfill_enqueued_at: Date | null;
      backfill_vocabulary_version: number | null;
    }>(
      client,
      `SELECT registration_generation, backfill_enqueued_at, backfill_vocabulary_version
         FROM agentscan_reporting_state
        WHERE id = 1
          FOR UPDATE`,
    );
    if (locked === null) throw new Error("agentscan_reporting_state singleton missing after ensure");

    if (Number(locked.registration_generation) !== input.startedAtGeneration) {
      return { enqueued: 0, marked: false, declined: "generation_moved" as const };
    }
    const covered =
      locked.backfill_vocabulary_version === null ? null : Number(locked.backfill_vocabulary_version);
    if (locked.backfill_enqueued_at !== null && covered !== null && covered >= AGENTSCAN_VOCABULARY_VERSION) {
      return { enqueued: 0, marked: false, declined: "already_marked" as const };
    }

    const enqueued = await executeWith(client, ENQUEUE_ELIGIBLE_SQL, [true]);
    await executeWith(
      client,
      `UPDATE agentscan_reporting_state
          SET backfill_enqueued_at = NOW(),
              backfill_vocabulary_version = GREATEST(COALESCE(backfill_vocabulary_version, 0), $2::int),
              updated_at = NOW()
        WHERE id = 1 AND registration_generation = $1::int`,
      [input.startedAtGeneration, AGENTSCAN_VOCABULARY_VERSION],
    );
    return { enqueued, marked: true, declined: null };
  });
}

/**
 * Claim up to `limit` due rows (backfill first, then oldest), stamping the
 * retry backoff before the caller sends. Returns each claimed pair with its
 * live `agent_activity` row for payload building.
 */
export async function claimDueOutbox(limit: number): Promise<ClaimedOutboxEvent[]> {
  const claimed = await query<{
    id: string | number;
    activity_id: string | number;
    status: ClaimedOutboxEvent["status"];
    backfill: boolean;
  }>(
    `WITH claimed AS (
       SELECT o.id FROM agentscan_outbox o
        WHERE o.sent_at IS NULL AND o.rejected_at IS NULL AND o.next_attempt_at <= NOW()
        ORDER BY o.backfill DESC, o.id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE agentscan_outbox o
        SET attempt_count = o.attempt_count + 1,
            next_attempt_at = NOW() + make_interval(secs => ${CLAIM_BACKOFF_SQL}),
            last_error = NULL
       FROM claimed
      WHERE o.id = claimed.id
     RETURNING o.id, o.activity_id, o.status, o.backfill`,
    [limit],
  );
  if (claimed.length === 0) return [];

  const activityIds = [...new Set(claimed.map((c) => Number(c.activity_id)))];
  const activityRows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity WHERE id = ANY($1::bigint[])`,
    [activityIds],
  );
  const byId = new Map(activityRows.map((r) => [Number(r.id), r]));

  return claimed.map((c) => ({
    outboxId: Number(c.id),
    activityId: Number(c.activity_id),
    status: c.status,
    backfill: c.backfill,
    activity: byId.get(Number(c.activity_id)) ?? null,
  }));
}

/** Server accepted (or deduplicated) these events — terminal, never resent. */
export async function markOutboxSent(outboxIds: number[]): Promise<void> {
  if (outboxIds.length === 0) return;
  await execute(
    `UPDATE agentscan_outbox
        SET sent_at = NOW(), last_error = NULL
      WHERE id = ANY($1::bigint[]) AND sent_at IS NULL AND rejected_at IS NULL`,
    [outboxIds],
  );
}

/** Server's per-item validation refusal — terminal; retrying an identical payload can only refail. */
export async function markOutboxRejected(outboxId: number, error: string): Promise<void> {
  await execute(
    `UPDATE agentscan_outbox
        SET rejected_at = NOW(), last_error = $2
      WHERE id = $1 AND sent_at IS NULL AND rejected_at IS NULL`,
    [outboxId, error.slice(0, 200)],
  );
}

/** Override the stamped backoff (e.g. the server's own Retry-After) for still-owed rows. */
export async function rescheduleOutbox(outboxIds: number[], delaySeconds: number): Promise<void> {
  if (outboxIds.length === 0) return;
  await execute(
    `UPDATE agentscan_outbox
        SET next_attempt_at = NOW() + make_interval(secs => $2::float8)
      WHERE id = ANY($1::bigint[]) AND sent_at IS NULL AND rejected_at IS NULL`,
    [outboxIds, delaySeconds],
  );
}
