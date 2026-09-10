/**
 * Vex's own in-flight capital accounting for one Lighter account.
 *
 * WHY A LEDGER AND NOT A SUM OVER INTENT TABLES. The provider's account read
 * lags what Vex has just prepared, and a bounded repair listing is a bounded
 * listing: it may legitimately omit rows, so it can never be the basis of a
 * ceiling. Every commitment Vex makes is one row here, so the live rows for an
 * account ARE the whole of what Vex has promised on it.
 *
 * ADMISSION IS ONE TRANSACTION. `admitLighterCapitalCommitment` takes an
 * account-scoped advisory transaction lock, sums the live rows, compares
 * `budget - providerCommitted - live` with `required`, and inserts the
 * commitment in the SAME transaction when it fits. Two sessions, or two keys
 * on one account, that reach admission concurrently therefore serialize on the
 * lock: the second one reads the first one's row and only the total that fits
 * the budget proceeds. Read-then-write in two statements would admit both.
 *
 * RE-ADMISSION UPDATES THE RESERVATION. An intent that admits again - at
 * execute-time revalidation, or after its own commitment was retired - gets its
 * row UPDATED to the requirement just computed, inside the same locked
 * transaction, and its identity is verified while doing it. An insert that
 * merely did nothing on conflict would report success while every other order
 * on the account kept seeing the SMALLER original reservation, which is the one
 * shape of this bug that silently widens a money ceiling. The sum the new
 * requirement is compared against therefore always EXCLUDES the admitting
 * intent's own row: it is being replaced, not added to.
 *
 * ADMISSION IS ALSO SELF-HEALING. Explicit retirement at the outcome paths is
 * the normal way a row leaves `live`, but it cannot be the only way: an
 * approval card the user rejects or lets expire never reaches an executor at
 * all, and a crash between admission and outcome leaves a row nobody will ever
 * settle. A stranded row shrinks the user's budget forever, so every admission
 * first retires this account's commitments whose backing intent is terminal or
 * gone - inside the SAME transaction and under the SAME lock, so the sum it
 * then takes is the healed one. See {@link healLighterCapitalCommitments}.
 *
 * Every figure is an integer string in USDC-6 units and is compared as
 * `bigint`. No token amount is ever a JavaScript number here.
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import logger from "@utils/logger.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import { execute, query, withTransaction } from "../client.js";

export type LighterCapitalCommitmentKind = "create" | "modify" | "leverage";

export interface LighterCapitalCommitmentRow {
  readonly intentId: string;
  readonly kind: LighterCapitalCommitmentKind;
  readonly requiredUnits: string;
  readonly admittedAt: string;
}

export interface AdmitLighterCapitalCommitmentInput {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly intentId: string;
  readonly kind: LighterCapitalCommitmentKind;
  /** What this operation needs, USDC-6 integer string, rounded UP by the caller. */
  readonly requiredUnits: string;
  /** The user's share of collateral, USDC-6 integer string, rounded DOWN by the caller. */
  readonly budgetUnits: string;
  /** What the provider already reports as committed on this account, USDC-6. */
  readonly providerCommittedUnits: string;
  /**
   * An ADDITIONAL row to leave out of the sum.
   *
   * The admitting intent's own row is always excluded now (re-admission
   * REPLACES it), so passing this intent's own id is redundant. It remains for
   * a caller that is replacing a DIFFERENT intent's reservation in the same
   * decision.
   */
  readonly excludeIntentId?: string;
}

export type AdmitLighterCapitalCommitmentResult =
  | { readonly admitted: true; readonly commitmentId: string; readonly liveCommittedUnits: string }
  | { readonly admitted: false; readonly remainingUnits: string; readonly liveCommittedUnits: string };

export async function admitLighterCapitalCommitment(
  input: AdmitLighterCapitalCommitmentInput,
): Promise<AdmitLighterCapitalCommitmentResult> {
  const accountIndex = assertAccountIndex(input.accountIndex);
  const required = assertUnits(input.requiredUnits, "requiredUnits");
  const budget = assertUnits(input.budgetUnits, "budgetUnits");
  const providerCommitted = assertUnits(input.providerCommittedUnits, "providerCommittedUnits");
  const intentId = assertIntentId(input.intentId);

  return withTransaction(async (client) => {
    // Account-scoped, transaction-lifetime lock: released by COMMIT or
    // ROLLBACK, so a failure between the sum and the insert cannot strand it.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      `lighter-capital:${input.environment}`,
      String(accountIndex),
    ]);

    // Heal BEFORE summing, under the lock this transaction already holds: a
    // stranded row must not be counted against the budget of the order being
    // admitted right now.
    await healLighterCapitalCommitments(client, input.environment, accountIndex);

    // The admitting intent's own row NEVER counts against its own new
    // requirement: this admission replaces it.
    const sum = await client.query<{ readonly live_units: string | null }>(
      `SELECT COALESCE(SUM(required_units::numeric), 0)::text AS live_units
         FROM lighter_capital_commitments
        WHERE environment = $1 AND account_index = $2 AND state = 'live'
          AND intent_id <> $3
          AND ($4::text IS NULL OR intent_id <> $4)`,
      [input.environment, accountIndex, intentId, input.excludeIntentId ?? null],
    );
    const live = BigInt(sum.rows[0]?.live_units ?? "0");
    // Budgets round down and obligations round up before they reach this
    // module, so the comparison itself is exact integer arithmetic.
    const remaining = budget - providerCommitted - live;
    // A requirement of ZERO always fits, even when the account is already over
    // its budget. A modification that shrinks an order admits a delta of zero:
    // it FREES capital, and refusing it because `remaining` is negative would
    // trap the user inside the very overage they are trying to reduce. Only a
    // requirement that actually consumes capital is compared.
    if (required > 0n && remaining < required) {
      return {
        admitted: false,
        remainingUnits: (remaining < 0n ? 0n : remaining).toString(10),
        liveCommittedUnits: live.toString(10),
      };
    }

    // UPSERT under the same lock. The conflict target is the intent, and the
    // guard on the update is its IDENTITY: an existing row for this intent that
    // belongs to another environment, account or kind is not this commitment,
    // and rewriting it would move a reservation between accounts. Zero rows
    // back from the statement means exactly that, and it refuses by name.
    const inserted = await client.query<{ readonly commitment_id: string }>(
      `INSERT INTO lighter_capital_commitments
         (commitment_id, environment, account_index, intent_id, kind, required_units)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (intent_id) DO UPDATE
          SET required_units = EXCLUDED.required_units,
              state = 'live',
              retired_at = NULL,
              retire_reason = NULL,
              settled_at = NULL
        WHERE lighter_capital_commitments.environment = EXCLUDED.environment
          AND lighter_capital_commitments.account_index = EXCLUDED.account_index
          AND lighter_capital_commitments.kind = EXCLUDED.kind
       RETURNING commitment_id`,
      [randomUUID(), input.environment, accountIndex, intentId, input.kind, required.toString(10)],
    );
    const commitmentId = inserted.rows[0]?.commitment_id;
    if (commitmentId === undefined) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        `Lighter capital accounting refused: intent ${intentId} already holds a commitment on a different account, `
        + "environment or operation kind. Nothing was admitted.",
      );
    }
    return { admitted: true, commitmentId, liveCommittedUnits: live.toString(10) };
  });
}

// -- self-healing --------------------------------------------------------------

/**
 * How long a commitment keeps counting AFTER ITS SETTLEMENT WAS OBSERVED, and
 * how long a commitment with no intent row at all is tolerated.
 *
 * WHY A LAG EXISTS. A filled or cancelled order stops being Vex's own promise
 * and becomes the provider's number: position margin inside
 * `cross_initial_margin_requirement`, or nothing at all for a cancel. But the
 * account read does not reflect it the instant the order settles, so retiring
 * on the durable state alone would, for a moment, count the same capital in
 * NEITHER place and widen the user's ceiling. Counting it in BOTH places for a
 * while is the safe direction: over-counting only tightens.
 *
 * WHY IT RUNS FROM `settled_at` AND NEVER FROM `admitted_at`. The race the lag
 * fences is not "how old is this order", it is "how stale can another session's
 * ALREADY-READ account snapshot be". Session B reads the account at T, session
 * A's order fills at T+1 and retires; B admits at T+2 against a snapshot that
 * predates A's fill, so A's capital is counted in neither the provider's
 * numbers nor the ledger. Measuring from admission gave a limit order that
 * rested for an hour a lag that had ALREADY elapsed when it filled, which is no
 * fence at all. Measuring from the observed settlement gives every in-flight
 * reader the full window to refresh.
 *
 * WHY TEN MINUTES. It is the grace this repository already uses for "the
 * provider may not show this yet" on the same account
 * (`LIGHTER_LIFECYCLE_REPAIR_EXPIRY_GRACE_MS`, `order-lifecycle-repair.ts`), it
 * is far longer than any observed Lighter settlement, and the cost of erring
 * long is only that the agent's next order inside the window sees a slightly
 * smaller budget. The explicit retirement calls on the outcome paths mean the
 * lag is normally never reached at all: it is the crash-recovery floor, not the
 * ordinary path.
 *
 * It ALSO guards two races that have nothing to do with the provider: a
 * commitment admitted microseconds before its intent row is inserted (which
 * would otherwise read as `intent_missing`), and an approval decided in the
 * same instant its consent window closes.
 */
export const LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS = 10 * 60 * 1_000;

/**
 * Create-intent states that PROVE the order never reached Lighter, so nothing
 * on the account can be covering this commitment. Retired immediately.
 *
 * `expired_unsubmitted` carries that proof in the schema itself: migration 116
 * refuses the state unless `send_attempt_started_at IS NULL`.
 */
export const LIGHTER_CREATE_COMMITMENT_UNSUBMITTED_STATES = ["expired_unsubmitted"] as const;

/**
 * Create-intent terminal states where the provider's own numbers take the
 * commitment over. Retired only after
 * {@link LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS}.
 *
 * `rejected` is here rather than above on purpose: `recordProviderOutcome`
 * reaches it from `open` and `partially_filled` too, so a rejected order may
 * still have moved base. The refusal path in `order-create-execution.ts` knows
 * its own row never signed and retires immediately by name; this sweep, which
 * only sees the state, does not assume it.
 */
export const LIGHTER_CREATE_COMMITMENT_SETTLED_STATES = ["filled", "canceled", "rejected"] as const;

/** Lifecycle-intent states that prove nothing was ever sent. */
export const LIGHTER_LIFECYCLE_COMMITMENT_UNSUBMITTED_STATES = [
  "expired",
  "expired_unsubmitted",
] as const;

/** Lifecycle-intent terminal states the provider's numbers take over. */
export const LIGHTER_LIFECYCLE_COMMITMENT_SETTLED_STATES = ["completed", "rejected"] as const;

/** Leverage-intent states that prove nothing was ever sent. */
export const LIGHTER_LEVERAGE_COMMITMENT_UNSUBMITTED_STATES = [
  "expired",
  "refused_unsubmitted",
  "expired_unsubmitted",
] as const;

/** Leverage-intent terminal states the provider's numbers take over. */
export const LIGHTER_LEVERAGE_COMMITMENT_SETTLED_STATES = ["completed", "rejected"] as const;

/** One retired row, as the heal reports it. */
export interface HealedLighterCapitalCommitment {
  readonly intent_id: string;
  readonly retire_reason: string;
}

/**
 * Retire this account's stranded commitments. MUST be called inside the
 * admission transaction, after the advisory lock and before the sum.
 *
 * Three joins, one per commitment kind, because the three intent kinds live in
 * three tables with three different vocabularies. Each retires:
 *
 * 1. immediately, an intent whose approval was rejected or expired, or whose
 *    execution state proves nothing was ever sent;
 * 2. after the observation lag, an intent that settled at the provider, an
 *    intent row that is GONE, or a consent window that closed with the human
 *    never answering. That last case strands the most rows in practice: a
 *    rejected approval card marks nothing on the intent, so the row simply sits
 *    at `approval_pending` until its own `expires_at` passes.
 *
 * Never widens a ceiling by guesswork: every branch above is a state from which
 * the intent can no longer consume capital.
 */
export async function healLighterCapitalCommitments(
  client: PoolClient,
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<readonly HealedLighterCapitalCommitment[]> {
  const healed: HealedLighterCapitalCommitment[] = [];
  healed.push(...await healApprovalBackedCommitments(client, environment, accountIndex, {
    kind: "create",
    table: "lighter_order_execution_intents",
    unsubmitted: LIGHTER_CREATE_COMMITMENT_UNSUBMITTED_STATES,
    settled: LIGHTER_CREATE_COMMITMENT_SETTLED_STATES,
  }));
  healed.push(...await healApprovalBackedCommitments(client, environment, accountIndex, {
    kind: "modify",
    table: "lighter_order_lifecycle_intents",
    unsubmitted: LIGHTER_LIFECYCLE_COMMITMENT_UNSUBMITTED_STATES,
    settled: LIGHTER_LIFECYCLE_COMMITMENT_SETTLED_STATES,
  }));
  healed.push(...await healLeverageCommitments(client, environment, accountIndex));
  if (healed.length > 0) {
    logger.info("lighter.capital_share.commitments_healed", {
      environment,
      accountIndex,
      retired: healed.length,
      reasons: healed.map((row) => row.retire_reason),
    });
  }
  return healed;
}

interface ApprovalBackedHealSpec {
  readonly kind: LighterCapitalCommitmentKind;
  /** A fixed identifier owned by this module, never caller input. */
  readonly table: "lighter_order_execution_intents" | "lighter_order_lifecycle_intents";
  readonly unsubmitted: readonly string[];
  readonly settled: readonly string[];
}

async function healApprovalBackedCommitments(
  client: PoolClient,
  environment: LighterEnvironment,
  accountIndex: number,
  spec: ApprovalBackedHealSpec,
): Promise<readonly HealedLighterCapitalCommitment[]> {
  // PHASE ONE, the settlement stamp. A crash between the provider outcome and
  // `markLighterCapitalCommitmentSettled` leaves a terminal intent whose
  // commitment carries no stamp. The sweep stamps it HERE, at the moment it
  // first observes the terminal state, so the lag is still measured from an
  // observation of settlement and never from admission.
  await client.query(
    `UPDATE lighter_capital_commitments c
        SET settled_at = NOW()
       FROM ${spec.table} i
      WHERE i.intent_id = c.intent_id
        AND c.environment = $1 AND c.account_index = $2
        AND c.state = 'live' AND c.kind = $3
        AND c.settled_at IS NULL
        AND i.execution_state = ANY($4::text[])`,
    [environment, accountIndex, spec.kind, [...spec.settled]],
  );

  const res = await client.query<HealedLighterCapitalCommitment>(
    `WITH heal AS (
       SELECT c.commitment_id,
              CASE
                WHEN i.intent_id IS NULL THEN 'intent_missing'
                WHEN i.approval_status IN ('rejected','expired') THEN 'approval_' || i.approval_status
                WHEN i.execution_state = ANY($4::text[]) THEN 'unsubmitted_' || i.execution_state
                WHEN i.execution_state = ANY($5::text[]) THEN 'observed_' || i.execution_state
                ELSE 'approval_window_closed'
              END AS reason
         FROM lighter_capital_commitments c
         LEFT JOIN ${spec.table} i ON i.intent_id = c.intent_id
        WHERE c.environment = $1 AND c.account_index = $2 AND c.state = 'live' AND c.kind = $3
          AND (
            (i.intent_id IS NOT NULL AND (
               i.approval_status IN ('rejected','expired')
               OR i.execution_state = ANY($4::text[])
            ))
            -- Settled at the provider: the lag runs from the SETTLEMENT stamp,
            -- which phase one guarantees exists for every terminal intent.
            OR (i.intent_id IS NOT NULL
                AND i.execution_state = ANY($5::text[])
                AND c.settled_at IS NOT NULL
                AND c.settled_at <= NOW() - (interval '1 millisecond' * $6::bigint))
            -- Never settled and never will: no intent row at all, or a consent
            -- window that closed unanswered. Neither is a settlement, so these
            -- are measured from admission.
            OR (c.admitted_at <= NOW() - (interval '1 millisecond' * $6::bigint) AND (
                 i.intent_id IS NULL
                 OR (i.approval_status = 'approval_pending'
                     AND i.expires_at <= NOW() - (interval '1 millisecond' * $6::bigint))
            ))
          )
     )
     UPDATE lighter_capital_commitments c
        SET state = 'retired', retired_at = NOW(), retire_reason = heal.reason
       FROM heal
      WHERE c.commitment_id = heal.commitment_id AND c.state = 'live'
     RETURNING c.intent_id, c.retire_reason`,
    [
      environment,
      accountIndex,
      spec.kind,
      [...spec.unsubmitted],
      [...spec.settled],
      LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS,
    ],
  );
  return res.rows;
}

/**
 * The leverage table has no approval queue: a Settings change is consented to
 * in the app itself, so its unanswered window is `proposed` past `expires_at`.
 */
async function healLeverageCommitments(
  client: PoolClient,
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<readonly HealedLighterCapitalCommitment[]> {
  // Phase one, the settlement stamp: see {@link healApprovalBackedCommitments}.
  await client.query(
    `UPDATE lighter_capital_commitments c
        SET settled_at = NOW()
       FROM lighter_leverage_intents i
      WHERE i.intent_id = c.intent_id
        AND c.environment = $1 AND c.account_index = $2
        AND c.state = 'live' AND c.kind = 'leverage'
        AND c.settled_at IS NULL
        AND i.execution_state = ANY($3::text[])`,
    [environment, accountIndex, [...LIGHTER_LEVERAGE_COMMITMENT_SETTLED_STATES]],
  );

  const res = await client.query<HealedLighterCapitalCommitment>(
    `WITH heal AS (
       SELECT c.commitment_id,
              CASE
                WHEN i.intent_id IS NULL THEN 'intent_missing'
                WHEN i.execution_state = ANY($3::text[]) THEN 'unsubmitted_' || i.execution_state
                WHEN i.execution_state = ANY($4::text[]) THEN 'observed_' || i.execution_state
                ELSE 'consent_window_closed'
              END AS reason
         FROM lighter_capital_commitments c
         LEFT JOIN lighter_leverage_intents i ON i.intent_id = c.intent_id
        WHERE c.environment = $1 AND c.account_index = $2 AND c.state = 'live'
          AND c.kind = 'leverage'
          AND (
            (i.intent_id IS NOT NULL AND i.execution_state = ANY($3::text[]))
            OR (i.intent_id IS NOT NULL
                AND i.execution_state = ANY($4::text[])
                AND c.settled_at IS NOT NULL
                AND c.settled_at <= NOW() - (interval '1 millisecond' * $5::bigint))
            OR (c.admitted_at <= NOW() - (interval '1 millisecond' * $5::bigint) AND (
                 i.intent_id IS NULL
                 OR (i.execution_state = 'proposed'
                     AND i.expires_at <= NOW() - (interval '1 millisecond' * $5::bigint))
            ))
          )
     )
     UPDATE lighter_capital_commitments c
        SET state = 'retired', retired_at = NOW(), retire_reason = heal.reason
       FROM heal
      WHERE c.commitment_id = heal.commitment_id AND c.state = 'live'
     RETURNING c.intent_id, c.retire_reason`,
    [
      environment,
      accountIndex,
      [...LIGHTER_LEVERAGE_COMMITMENT_UNSUBMITTED_STATES],
      [...LIGHTER_LEVERAGE_COMMITMENT_SETTLED_STATES],
      LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS,
    ],
  );
  return res.rows;
}

/**
 * Stamp the moment this intent's SETTLEMENT AT THE PROVIDER was observed.
 *
 * This is what a terminal outcome path calls - not retirement. The commitment
 * stays LIVE and keeps counting against the account's budget until
 * {@link LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS} has passed from this
 * stamp, which is the window every concurrently-held account snapshot needs to
 * refresh before the capital stops being counted anywhere.
 *
 * A non-terminal outcome (`open`, `partially_filled`, `sequencer_pending`)
 * stamps NOTHING: that order can still consume the capital it reserved.
 *
 * Idempotent, and it never moves an existing stamp forward: the earliest
 * observation of settlement is the honest one, and re-stamping would extend the
 * lag every time a repair sweep looked at the row.
 */
export async function markLighterCapitalCommitmentSettled(intentId: string): Promise<void> {
  await execute(
    `UPDATE lighter_capital_commitments
        SET settled_at = NOW()
      WHERE intent_id = $1 AND state = 'live' AND settled_at IS NULL`,
    [assertIntentId(intentId)],
  );
}

/**
 * Retire a commitment whose intent PROVABLY never reached the provider.
 *
 * Idempotent: a retired or absent commitment is a no-op, because a repair sweep
 * and an outcome path both legitimately reach the same intent.
 *
 * A commitment that carries a settlement stamp is NOT retired here before its
 * observation lag has run out. Retiring a settled commitment early is the
 * stale-snapshot race in `settled_at`'s migration note: the capital would be
 * counted in neither the provider's numbers nor the ledger for as long as
 * another session's account read is older than the settlement. Callers on the
 * settled path use {@link markLighterCapitalCommitmentSettled} and let the
 * sweep retire the row when the lag elapses.
 */
export async function retireLighterCapitalCommitment(input: {
  readonly intentId: string;
  readonly reason: string;
}): Promise<void> {
  const reason = input.reason.trim();
  if (!/^[a-z0-9_.-]{1,120}$/.test(reason)) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "A capital commitment retirement needs a machine-readable reason.",
    );
  }
  await execute(
    `UPDATE lighter_capital_commitments
        SET state = 'retired', retired_at = NOW(), retire_reason = $2
      WHERE intent_id = $1 AND state = 'live'
        AND (settled_at IS NULL
             OR settled_at <= NOW() - (interval '1 millisecond' * $3::bigint))`,
    [assertIntentId(input.intentId), reason, LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS],
  );
}

export async function listLiveLighterCapitalCommitments(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<readonly LighterCapitalCommitmentRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT intent_id, kind, required_units, admitted_at
       FROM lighter_capital_commitments
      WHERE environment = $1 AND account_index = $2 AND state = 'live'
      ORDER BY admitted_at ASC, commitment_id ASC`,
    [environment, assertAccountIndex(accountIndex)],
  );
  return rows.map((row) => ({
    intentId: String(row.intent_id),
    kind: row.kind as LighterCapitalCommitmentKind,
    requiredUnits: String(row.required_units),
    admittedAt:
      row.admitted_at instanceof Date
        ? row.admitted_at.toISOString()
        : new Date(row.admitted_at as string).toISOString(),
  }));
}

function assertUnits(value: string, field: string): bigint {
  if (!/^\d+$/.test(value.trim())) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Lighter capital accounting requires ${field} as a whole number of USDC-6 units.`,
    );
  }
  return BigInt(value.trim());
}

function assertAccountIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter capital accounting requires a valid account index.",
    );
  }
  return value;
}

function assertIntentId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter capital accounting requires an intent identifier.",
    );
  }
  return trimmed;
}
