/**
 * Durable audit and reconciliation for one user-originated Lighter leverage
 * change (TxType 20).
 *
 * NOT A CACHE OF THE ACCOUNT'S LEVERAGE. Lighter owns that number; a local copy
 * would go stale the moment the user changes it in Lighter's own interface. What
 * lives here is the consent that was captured, the identity of the transaction
 * that carried it, and enough evidence for reconciliation to prove the outcome
 * without ever signing again.
 *
 * EVERY TRANSITION IS GUARDED by `WHERE execution_state = <expected>`, so an
 * illegal transition updates no row and returns `null`. The caller detects that
 * and stops, rather than discovering later that a state machine drifted. This is
 * the shape `lighter-fee-authorization-intents.ts` established; the difference
 * is that this row carries no `session_id` and no approval id, because a
 * Settings action is the user acting directly.
 *
 * The nonce reservation is owned by `lighter-nonce-state.ts`. This module never
 * releases it: releasing is a decision about proven non-submission, and it
 * belongs to the executor that knows whether bytes could have left.
 */

import type { PoolClient } from "pg";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { queryOne, queryOneWith, query } from "../client.js";
import { jsonb } from "../params.js";

/** The closed execution set. Enforced by the migration's CHECK as well. */
export type LighterLeverageExecutionState =
  | "proposed"
  | "expired"
  | "refused_unsubmitted"
  | "signing"
  | "signed"
  | "submission_staged"
  | "submitted"
  | "completed"
  | "ambiguous"
  | "rejected"
  | "expired_unsubmitted";

/** States that still hold, or may still hold, a nonce reservation. */
export const LIGHTER_LEVERAGE_UNRESOLVED_STATES = [
  "signing",
  "signed",
  "submission_staged",
  "submitted",
  "ambiguous",
] as const satisfies readonly LighterLeverageExecutionState[];

/** States a live-market uniqueness check treats as still occupying the market. */
export const LIGHTER_LEVERAGE_LIVE_STATES = [
  "proposed",
  ...LIGHTER_LEVERAGE_UNRESOLVED_STATES,
] as const satisfies readonly LighterLeverageExecutionState[];

/**
 * The terms the human saw, frozen at proposal time. `current*` are CONSENT
 * INVARIANTS: they are re-read before signing and a change refuses the intent.
 */
export interface LighterLeverageObservedBefore {
  readonly symbol: string;
  readonly currentInitialMarginFraction: number;
  readonly currentMarginMode: 0 | 1;
  readonly currentSource: "position_row" | "market_default";
  readonly marketMinInitialMarginFraction: number;
  readonly openPositionSize: string;
  readonly openPositionSide: "long" | "short" | "none";
  readonly publicKey: string;
  /** Shown beside the decision, never bound: they change on their own. */
  readonly liquidationPrice: string | null;
  readonly openOrderCount: number;
}

export interface LighterLeverageIntentRow {
  readonly intentId: string;
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly requestedInitialMarginFraction: number;
  readonly requestedMarginMode: 0 | 1;
  readonly observedBefore: LighterLeverageObservedBefore;
  readonly executionState: LighterLeverageExecutionState;
  readonly consentedAt: Date | null;
  readonly revalidation: Record<string, unknown> | null;
  readonly nonceValue: string | null;
  readonly txExpiryMs: number | null;
  readonly signerTxHash: string | null;
  readonly sendAttemptStartedAt: Date | null;
  readonly providerOutcome: Record<string, unknown> | null;
  readonly failureReason: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const COLUMNS = "*";

function map(row: Record<string, unknown>): LighterLeverageIntentRow {
  return {
    intentId: String(row.intent_id),
    environment: row.environment as LighterEnvironment,
    walletAddress: String(row.wallet_address),
    accountIndex: Number(row.account_index),
    apiKeyIndex: Number(row.api_key_index),
    marketIndex: Number(row.market_index),
    requestedInitialMarginFraction: Number(row.requested_initial_margin_fraction),
    requestedMarginMode: Number(row.requested_margin_mode) as 0 | 1,
    observedBefore: row.observed_before_json as LighterLeverageObservedBefore,
    executionState: row.execution_state as LighterLeverageExecutionState,
    consentedAt: row.consented_at == null ? null : new Date(row.consented_at as string | Date),
    revalidation: (row.revalidation_json as Record<string, unknown> | null) ?? null,
    nonceValue: (row.nonce_value as string | null) ?? null,
    txExpiryMs: row.tx_expiry_ms == null ? null : Number(row.tx_expiry_ms),
    signerTxHash: (row.signer_tx_hash as string | null) ?? null,
    sendAttemptStartedAt:
      row.send_attempt_started_at == null
        ? null
        : new Date(row.send_attempt_started_at as string | Date),
    providerOutcome: (row.provider_outcome_json as Record<string, unknown> | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    expiresAt: new Date(row.expires_at as string | Date),
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

export async function create(input: {
  readonly intentId: string;
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly requestedInitialMarginFraction: number;
  readonly requestedMarginMode: 0 | 1;
  readonly observedBefore: LighterLeverageObservedBefore;
  readonly expiresAt: Date;
}): Promise<LighterLeverageIntentRow> {
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO lighter_leverage_intents
       (intent_id, environment, wallet_address, account_index, api_key_index, market_index,
        requested_initial_margin_fraction, requested_margin_mode, observed_before_json, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLUMNS}`,
    [
      input.intentId,
      input.environment,
      input.walletAddress.toLowerCase(),
      input.accountIndex,
      input.apiKeyIndex,
      input.marketIndex,
      input.requestedInitialMarginFraction,
      input.requestedMarginMode,
      jsonb(input.observedBefore),
      input.expiresAt,
    ],
  );
  if (!row) throw new Error("The Lighter leverage proposal could not be persisted.");
  return map(row);
}

export async function find(intentId: string): Promise<LighterLeverageIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_leverage_intents WHERE intent_id = $1`,
    [intentId],
  );
  return row ? map(row) : null;
}

/** The row occupying this market, if any. A second Apply must not start. */
export async function findLive(
  environment: LighterEnvironment,
  accountIndex: number,
  marketIndex: number,
): Promise<LighterLeverageIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_leverage_intents
      WHERE environment=$1 AND account_index=$2 AND market_index=$3
        AND execution_state = ANY($4::text[])`,
    [environment, accountIndex, marketIndex, [...LIGHTER_LEVERAGE_LIVE_STATES]],
  );
  return row ? map(row) : null;
}

/**
 * Bounded listing of intents that may still hold a nonce reservation, for the
 * repair path. Bounded and ordered, never used for accounting.
 */
export async function listUnresolved(options: {
  readonly environment?: LighterEnvironment;
  readonly accountIndex?: number;
  readonly limit?: number;
} = {}): Promise<readonly LighterLeverageIntentRow[]> {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Lighter leverage repair listing requires a limit from 1 to 500.");
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_leverage_intents
      WHERE execution_state = ANY($1::text[])
        AND ($2::text IS NULL OR environment = $2)
        AND ($3::bigint IS NULL OR account_index = $3)
      ORDER BY updated_at ASC, intent_id ASC LIMIT $4`,
    [
      [...LIGHTER_LEVERAGE_UNRESOLVED_STATES],
      options.environment ?? null,
      options.accountIndex ?? null,
      limit,
    ],
  );
  return rows.map(map);
}

/** Retire proposals whose confirmation window closed with no Confirm. */
export async function expireStaleProposals(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<number> {
  const rows = await query<{ readonly intent_id: string }>(
    `UPDATE lighter_leverage_intents
        SET execution_state='expired', updated_at=NOW()
      WHERE environment=$1 AND account_index=$2
        AND execution_state='proposed' AND consented_at IS NULL AND expires_at <= NOW()
      RETURNING intent_id`,
    [environment, accountIndex],
  );
  return rows.length;
}

/**
 * Mark ONE proposal expired. Used when Confirm arrives too late.
 *
 * `expired` means "the confirmation window closed with NO Confirm", which is
 * why the guard demands an unconsented row: once the person has pressed
 * Confirm, the honest terminal state is `refused_unsubmitted` and its reason
 * names what stopped the change.
 */
export async function markExpired(intentId: string): Promise<LighterLeverageIntentRow | null> {
  return transition(intentId, ["proposed"], "expired", {}, "consented_at IS NULL");
}

/**
 * Confirm arrived, every consent invariant still held against live state, and
 * the shared nonce was reserved: record the CONSENT, what the live re-read
 * showed, the reserved nonce and the WIRE expiry, and enter `signing`. One
 * statement, inside the caller's transaction, so the reservation and this row
 * commit together or not at all and a crash can never leave a held nonce with
 * no owning row.
 *
 * WHY CONSENT COMMITS HERE, and not in an earlier `proposed` update: migration
 * 156 states that consent exists for exactly the states reached through
 * Confirm, so a `proposed` row may never carry a consent timestamp. Recording
 * consent while leaving the row `proposed` is precisely the write that
 * constraint refuses, and it refused every ordinary confirmation until this
 * transition became one statement.
 */
export async function reserveSigningWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly nonceValue: string;
    readonly txExpiryMs: number;
    readonly revalidation: Record<string, unknown>;
  },
): Promise<LighterLeverageIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `UPDATE lighter_leverage_intents
        SET execution_state='signing', consented_at=COALESCE(consented_at, clock_timestamp()),
            revalidation_json=$4, nonce_value=$2, tx_expiry_ms=$3, updated_at=NOW()
      WHERE intent_id=$1 AND execution_state='proposed'
        AND expires_at > clock_timestamp()
      RETURNING ${COLUMNS}`,
    [input.intentId, input.nonceValue, input.txExpiryMs, jsonb(input.revalidation)],
  );
  return row ? map(row) : null;
}

/** The signed identity, persisted BEFORE any send can be attempted. */
export async function markSigned(input: {
  readonly intentId: string;
  readonly signerTxHash: string;
}): Promise<LighterLeverageIntentRow | null> {
  return transition(input.intentId, ["signing"], "signed", {
    signerTxHash: input.signerTxHash,
  });
}

export async function markSubmissionStaged(
  intentId: string,
): Promise<LighterLeverageIntentRow | null> {
  return transition(intentId, ["signed"], "submission_staged", {});
}

/**
 * The send-admission latch. Exactly one caller can win it, and it is set in the
 * statement immediately preceding `sendTx`, so a second attempt after a crash
 * finds the latch already down and reconciles instead of sending again.
 *
 * `expires_at > clock_timestamp()` is the CONSENT-EXPIRY predicate, and it
 * belongs in this statement rather than only in the caller's check: admission
 * is the last authority gate before bytes leave, and the caller's clock read
 * happened before the round trip that opens the latch. This is the same
 * predicate `markSendAttemptStarted` carries in the fee template
 * (`lighter-fee-authorization-intents.ts`), for the same reason.
 */
export async function markSendAttemptStarted(input: {
  readonly intentId: string;
  readonly signerTxHash: string;
}): Promise<boolean> {
  const row = await queryOne<{ readonly intent_id: string }>(
    `UPDATE lighter_leverage_intents
        SET send_attempt_started_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE intent_id=$1 AND execution_state='submission_staged' AND signer_tx_hash=$2
        AND send_attempt_started_at IS NULL
        AND expires_at > clock_timestamp()
      RETURNING intent_id`,
    [input.intentId, input.signerTxHash],
  );
  return row !== null;
}

export async function markSubmitted(input: {
  readonly intentId: string;
  readonly providerOutcome: Record<string, unknown>;
}): Promise<LighterLeverageIntentRow | null> {
  return transition(input.intentId, ["submission_staged"], "submitted", {
    providerOutcome: input.providerOutcome,
  });
}

/**
 * Proven executed by an exact `getTx` match on the signed identity.
 *
 * ACCEPTS EVERY POST-RESERVATION STATE, because a crash can leave the row in
 * any of them while the transaction it names went on to execute. The state the
 * process last managed to write is not evidence about Lighter; the proof is,
 * and the proof is tied to `signer_tx_hash`, which is why the row-level guard
 * is a hash rather than a narrower state list.
 */
export async function markCompleted(input: {
  readonly intentId: string;
  readonly providerOutcome: Record<string, unknown>;
}): Promise<LighterLeverageIntentRow | null> {
  return transition(
    input.intentId,
    LIGHTER_LEVERAGE_UNRESOLVED_STATES,
    "completed",
    { providerOutcome: input.providerOutcome },
    "signer_tx_hash IS NOT NULL",
  );
}

/**
 * Unknown outcome. NOT a failure: bytes may have reached Lighter, so the nonce
 * stays reserved until reconciliation proves what happened.
 *
 * The hash guard is the table's own CHECK restated where the caller can detect
 * it: `ambiguous` asserts "a transaction with THIS identity may exist", which
 * an intent with no signed hash cannot claim. A refused transition returns
 * `null` and the executor reports the intent unresolved with the reason, rather
 * than a constraint violation escaping as an unexplained failure. Re-entry from
 * `ambiguous` is allowed so a later reconciliation pass records its own
 * outcome without needing a state it cannot legally reach.
 */
export async function markAmbiguous(input: {
  readonly intentId: string;
  readonly failureReason: string;
  readonly providerOutcome?: Record<string, unknown>;
}): Promise<LighterLeverageIntentRow | null> {
  return transition(
    input.intentId,
    LIGHTER_LEVERAGE_UNRESOLVED_STATES,
    "ambiguous",
    { failureReason: input.failureReason, providerOutcome: input.providerOutcome },
    "signer_tx_hash IS NOT NULL",
  );
}

/**
 * Lighter did not execute this change, and there is evidence of that: either a
 * SPECIFIC failed execution status in an exact proof, or a wire expiry that
 * elapsed with the reserved nonce still unconsumed, which no transaction
 * carrying that nonce can ever escape. A missing proof is not evidence and
 * never reaches here.
 */
export async function markRejected(input: {
  readonly intentId: string;
  readonly failureReason: string;
  readonly providerOutcome: Record<string, unknown>;
}): Promise<LighterLeverageIntentRow | null> {
  return transition(
    input.intentId,
    LIGHTER_LEVERAGE_UNRESOLVED_STATES,
    "rejected",
    { failureReason: input.failureReason, providerOutcome: input.providerOutcome },
    "signer_tx_hash IS NOT NULL",
  );
}

/**
 * SIGNED, then consent or the wire expiry elapsed with NO send attempt started.
 * The hash is retained: this state's claim is "a signature for this identity
 * exists and no send was attempted", and the second half is what makes
 * releasing the reservation safe.
 *
 * An interrupted attempt that never produced a hash is `refused_unsubmitted`
 * instead: there is no transaction identity to retain, so the two states stay
 * distinguishable rather than one of them meaning two different things.
 */
export async function markExpiredUnsubmitted(input: {
  readonly intentId: string;
  readonly failureReason: string;
}): Promise<LighterLeverageIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_leverage_intents
        SET execution_state='expired_unsubmitted', failure_reason=COALESCE(failure_reason,$2),
            updated_at=NOW()
      WHERE intent_id=$1 AND execution_state IN ('signing','signed','submission_staged')
        AND signer_tx_hash IS NOT NULL AND send_attempt_started_at IS NULL
      RETURNING ${COLUMNS}`,
    [input.intentId, input.failureReason],
  );
  return row ? map(row) : null;
}

/**
 * Confirm was refused, and NOTHING WAS SIGNED. Either a live invariant refused
 * it before the reservation, or the attempt was interrupted after reserving but
 * before the signer produced a hash.
 *
 * CONSENT IS RECORDED, including on the pre-reservation refusal: the person
 * pressed Confirm and the refusal came after, so a row that claims otherwise
 * would misreport what the human did. The guards are the state's own claim,
 * restated where the caller can detect a violation: no signed hash exists, and
 * no send attempt was ever started, so releasing the nonce reservation through
 * the unsubmitted path is safe.
 */
export async function markRefusedUnsubmitted(input: {
  readonly intentId: string;
  readonly failureReason: string;
}): Promise<LighterLeverageIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_leverage_intents
        SET execution_state='refused_unsubmitted',
            consented_at=COALESCE(consented_at, clock_timestamp()),
            failure_reason=COALESCE(failure_reason,$2), updated_at=NOW()
      WHERE intent_id=$1
        AND execution_state IN ('proposed','signing','signed','submission_staged')
        AND signer_tx_hash IS NULL AND send_attempt_started_at IS NULL
      RETURNING ${COLUMNS}`,
    [input.intentId, input.failureReason],
  );
  return row ? map(row) : null;
}

async function transition(
  intentId: string,
  expectedStates: readonly LighterLeverageExecutionState[],
  nextState: LighterLeverageExecutionState,
  details: {
    readonly signerTxHash?: string;
    readonly failureReason?: string;
    readonly providerOutcome?: Record<string, unknown>;
  },
  /**
   * An extra row-level predicate the transition requires. It is a literal
   * fragment written HERE, never caller-supplied text: every call site in this
   * module passes a constant, and no value from a request reaches it.
   */
  guard?: string,
): Promise<LighterLeverageIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_leverage_intents SET
       execution_state = $3,
       signer_tx_hash = COALESCE($4, signer_tx_hash),
       failure_reason = COALESCE(failure_reason, $5),
       provider_outcome_json = COALESCE($6::jsonb, provider_outcome_json),
       updated_at = NOW()
     WHERE intent_id = $1 AND execution_state = ANY($2::text[])
       ${guard === undefined ? "" : `AND ${guard}`}
     RETURNING ${COLUMNS}`,
    [
      intentId,
      [...expectedStates],
      nextState,
      details.signerTxHash ?? null,
      details.failureReason ?? null,
      details.providerOutcome === undefined ? null : jsonb(details.providerOutcome),
    ],
  );
  return row ? map(row) : null;
}
