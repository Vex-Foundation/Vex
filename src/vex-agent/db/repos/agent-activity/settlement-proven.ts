/**
 * THE SETTLEMENT-PROVEN ACTIVITY WRITER: one client-bound INSERT for an
 * exchange funding leg whose truth lives in a settlement-chain transaction.
 *
 * ## Why this module exists at all
 *
 * A Lighter deposit and a claimed Lighter withdrawal are ordinary EVM
 * transactions signed by the user's own wallet, and the venue credit or release
 * that follows is a fact the venue reports. Until this file, no writer in this
 * repository could record that shape: `./bridge-intent.ts`'s `insertBridgeRow`
 * hardcodes `kind='bridge'` and stamps route endpoints the non-bridge CHECK
 * forbids; `./swap-intent.ts`'s `createAgentActivityIntentWith` has no
 * `tx_hash` column at all (it is the PRE-SIGN entry point, and a hash arrives
 * later through `markActivityBroadcast`); and `markActivityBroadcast` itself is
 * a pool-level CAS on an already-open row, which is exactly what a lane that
 * learns the hash and the outcome TOGETHER, inside somebody else's
 * transaction, cannot use.
 *
 * So the row was either impossible (hashless, claimed by nothing, blocking
 * compaction forever) or invalid (rejected by a CHECK). This module writes the
 * one shape the schema admits for it, in one statement, on the caller's client.
 *
 * ## What the row claims, and what it does not
 *
 * The row's IDENTITY is the settlement transaction: chain id, hash, sender and
 * nonce. That is the part a receipt reader can verify independently, and it is
 * why the row is written `pending`: the EXISTING EVM claim lane
 * (`./evm-claim.ts` selects `status='pending' AND chain_family='eip155' AND
 * tx_hash IS NOT NULL AND submit_attempted_at IS NOT NULL`) picks it up and
 * confirms it from the real receipt through
 * `confirmActivityEventStatusOnly`. This writer never states a chain outcome
 * itself; it states an identity and lets the chain settle it.
 *
 * The venue side (the L2 credit that followed a deposit, the withdrawal a claim
 * released) is CLIENT-REPORTED evidence, per the AgentScan contract R2.7:
 * receipt verification proves the settlement transaction and its amounts, never
 * the L2 credit. It is therefore carried in `route_provenance` as provenance,
 * not in any column a reader could mistake for proven settlement.
 *
 * ## Why an unsigned leg is REFUSED rather than written weaker
 *
 * Migration 045's `agent_activity_evm_signed_leg_has_nonce` requires a nonce on
 * any `eip155` row that carries a hash and no `evidence_source`, and 049's
 * `agent_activity_non_bridge_no_bridge_cols` forbids `evidence_source` and
 * `observed_at` on every non-bridge row. The two together mean a deposit Vex
 * did not sign has NO valid shape in this table: it can be neither a signed leg
 * (no nonce) nor an observed one (the column is forbidden). Writing it hashless
 * would produce a row the claim lane can never select and the compaction gate
 * can never clear. The honest answer is a typed refusal that the caller
 * records, and that is what this returns.
 *
 * ## Ownership and the transaction
 *
 * Client-bound with no pool-level twin, deliberately: every caller writes this
 * row as part of a wider money transition (a deposit credit, a withdrawal
 * claim) and the row must commit or roll back WITH it. The caller owns the
 * transaction and MUST have taken the session control lock as its first lock,
 * exactly as `createAgentActivityIntentWith` requires - this row joins the set
 * the compaction safe-moment gate reads
 * (`../approval-intents/money-state.ts`), so a writer outside that lock would
 * let the gate report `clear` a microsecond before the money state existed.
 */

import type { PoolClient } from "pg";
import { formatUnits, getAddress } from "viem";

import { queryOneWith } from "../../client.js";
import { jsonb } from "../../params.js";
import { completeExecutionIntentWith, createExecutionIntent } from "../executions.js";

import { mapRow } from "./mappers.js";
import type { AgentActivityEvent } from "./types.js";

/** The two exchange funding legs. A deposit SPENDS; a claimed withdrawal RECEIVES. */
export type SettlementProvenEventRole = "exchange_deposit" | "exchange_withdrawal";

/** The asset that moved, in its own atomic units. Never a float, never a price. */
export interface SettlementProvenAsset {
  /** The settlement-chain token contract. */
  readonly address: string;
  readonly symbol: string;
  /** Needed to read `amountRaw` at all: "11000000" is 11 at 6 decimals and 0.011 at 9. */
  readonly decimals: number;
}

/**
 * WHERE the durable execution comes from.
 *
 * `existingId` reuses an execution the caller already owns, and this writer
 * then leaves its completion alone: that row's lifecycle belongs to whoever
 * opened it. Otherwise this call opens its OWN `protocol_executions` intent and
 * COMPLETES it in the same statement pair, because nothing else will: an
 * execution left at `execution_status='intent'` is unresolved money state that
 * blocks the compaction safe-moment gate forever, which is precisely the defect
 * a bare FK-satisfying insert would have introduced.
 */
export type SettlementProvenExecution =
  | { readonly existingId: number }
  | {
      readonly toolId: string;
      readonly namespace: string;
      /** Sanitized inside `createExecutionIntent`, never by the caller. */
      readonly intentParams: Record<string, unknown>;
    };

export interface SettlementProvenActivityInput {
  readonly eventRole: SettlementProvenEventRole;
  /** `agent_activity.protocol` - the venue this leg funds, e.g. `lighter`. */
  readonly protocol: string;
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly execution: SettlementProvenExecution;
  /** The SETTLEMENT chain, never the venue's own L2: the receipt lives there. */
  readonly chainId: number;
  readonly chainSlug?: string;
  readonly txHash: string;
  /** The signer. `null` when the leg was not signed by Vex - see the refusal contract above. */
  readonly fromAddress: string | null;
  /** The signer's nonce for this exact transaction. `null` has the same meaning as a null sender. */
  readonly nonce: number | null;
  /**
   * When this row entered the claim lane's queue. Defaults to the insert's own
   * `NOW()`, and it means exactly that: the row's staging clock, which is what
   * `./evm-claim.ts` uses as the immutable phase anchor and what the 90 s money
   * gate measures from. It is NOT a claim about when the transaction was
   * broadcast; the block time is the honest answer to that and it is written
   * later, by the lane that reads the receipt.
   */
  readonly submitAttemptedAt?: string;
  readonly asset: SettlementProvenAsset;
  /** Atomic units as digits. Never a `number`: a u128 transfer exceeds `MAX_SAFE_INTEGER`. */
  readonly amountRaw: string;
  /** Client-reported venue evidence (environment, account index, venue tx, block height). */
  readonly venueEvidence: Record<string, unknown>;
}

/** Why nothing was written. Never a bare `null`: the caller has to be able to say which. */
export type SettlementProvenRefusal =
  | "no_signed_leg"
  | "malformed_signed_leg"
  | "malformed_amount"
  | "malformed_asset";

export type InsertSettlementProvenActivityRowOutcome =
  | {
      readonly outcome: "recorded";
      readonly activityId: number;
      readonly executionId: number;
      readonly event: AgentActivityEvent;
    }
  /**
   * A row for this exact settlement transaction already exists. NOT an error
   * and NOT a second row: one broadcast backs exactly one activity row
   * (migration 044's unique `tx_hash` index), so a replay of the caller's
   * transition converges on the row that is already there.
   */
  | {
      readonly outcome: "already_recorded";
      readonly activityId: number;
      readonly event: AgentActivityEvent;
    }
  | {
      readonly outcome: "refused";
      readonly reason: SettlementProvenRefusal;
      readonly detail: string;
    };

const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ATOMIC_AMOUNT_PATTERN = /^[1-9][0-9]*$/;

/**
 * Insert ONE `pending` settlement-proven exchange row on the caller's
 * transaction, and return what was written or why nothing was.
 *
 * The row satisfies every CHECK the table carries for this shape, and the
 * columns it deliberately leaves NULL are load-bearing rather than merely
 * unset: `evidence_source` and `observed_at` (049 forbids them off the bridge
 * arm, and setting `evidence_source` would additionally forbid the very
 * sender, nonce and submit stamp that make the row claimable), the route
 * endpoints, `normalized_route`, `provider_order_id`, `provider_status`,
 * `last_attempted_at`, every second-leg column, and every terminal field.
 *
 * REQUIRES the caller's transaction to already hold the session control lock
 * for `input.sessionId`.
 */
export async function insertSettlementProvenActivityRowWith(
  client: PoolClient,
  input: SettlementProvenActivityInput,
): Promise<InsertSettlementProvenActivityRowOutcome> {
  const txHash = input.txHash.trim().toLowerCase();
  if (!TX_HASH_PATTERN.test(txHash)) {
    return refused("malformed_signed_leg", "the settlement transaction hash is not a 32-byte hex hash");
  }
  if (input.fromAddress === null || input.nonce === null) {
    return refused(
      "no_signed_leg",
      "the settlement transaction has no recorded sender and nonce, so Vex cannot state that it signed it",
    );
  }
  let fromAddress: string;
  try {
    fromAddress = getAddress(input.fromAddress.trim());
  } catch {
    return refused("malformed_signed_leg", "the recorded sender is not a valid EVM address");
  }
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) {
    return refused("malformed_signed_leg", "the recorded nonce is not a non-negative safe integer");
  }
  if (!ATOMIC_AMOUNT_PATTERN.test(input.amountRaw)) {
    return refused("malformed_amount", "the amount is not a positive integer of atomic units");
  }
  if (!Number.isInteger(input.asset.decimals) || input.asset.decimals < 0 || input.asset.decimals > 36) {
    return refused("malformed_asset", "the asset decimals are outside the readable range");
  }
  let assetAddress: string;
  try {
    assetAddress = getAddress(input.asset.address.trim());
  } catch {
    return refused("malformed_asset", "the settlement asset address is not a valid EVM address");
  }

  // ONE BROADCAST, ONE ROW. Read before writing rather than catching the unique
  // violation: a failed statement aborts the CALLER's transaction, which on
  // this path would roll back the money transition this row accompanies. A
  // concurrent inserter from another session can still lose that race, and
  // then the whole caller transaction rolls back and its own retry converges
  // here - the correct unknown-outcome behaviour, not a silent second row.
  const existing = await queryOneWith<Record<string, unknown>>(
    client,
    "SELECT * FROM agent_activity WHERE LOWER(tx_hash) = $1 LIMIT 1",
    [txHash],
  );
  if (existing) {
    const event = mapRow(existing);
    return { outcome: "already_recorded", activityId: event.id, event };
  }

  const executionId = "existingId" in input.execution
    ? input.execution.existingId
    : await createExecutionIntent(
        input.execution.toolId,
        input.execution.namespace,
        input.sessionId,
        input.execution.intentParams,
        client,
      );
  if (!Number.isInteger(executionId) || executionId <= 0) {
    throw new Error("agent_activity: settlement-proven insert has no durable execution id");
  }

  // A DEPOSIT SPENDS AND A CLAIMED WITHDRAWAL RECEIVES, so the side is derived
  // from the role rather than chosen by the caller: the two can never disagree,
  // and no funding row can claim a counterparty leg that does not exist.
  const spends = input.eventRole === "exchange_deposit";
  const amountHuman = formatUnits(BigInt(input.amountRaw), input.asset.decimals);

  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `INSERT INTO agent_activity (
       protocol_execution_id, event_index, event_role, kind, protocol,
       chain_id, chain_slug, chain_family, wallet_address, session_id,
       token_in_address, token_in_symbol, token_in_decimals, amount_in_human, amount_in_raw,
       token_out_address, token_out_symbol, token_out_decimals, amount_out_human, amount_out_raw,
       status, tx_hash, from_address, nonce, submit_attempted_at, route_provenance
     ) VALUES (
       $1,
       -- Under the caller's session control lock, so the next free index cannot
       -- be taken between the read and the insert. A caller-supplied index
       -- could collide with a sibling leg of the same execution and abort the
       -- caller's whole transaction over bookkeeping.
       (SELECT COALESCE(MAX(event_index) + 1, 0) FROM agent_activity WHERE protocol_execution_id = $1),
       $2, 'exchange', $3,
       $4, $5, 'eip155', $6, $7,
       $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17,
       'pending', $18, $19, $20, COALESCE($21::timestamptz, NOW()), $22::jsonb
     ) RETURNING *`,
    [
      executionId,
      input.eventRole,
      input.protocol,
      input.chainId,
      input.chainSlug ?? null,
      input.walletAddress,
      input.sessionId,
      spends ? assetAddress : null,
      spends ? input.asset.symbol : null,
      spends ? input.asset.decimals : null,
      spends ? amountHuman : null,
      spends ? input.amountRaw : null,
      spends ? null : assetAddress,
      spends ? null : input.asset.symbol,
      spends ? null : input.asset.decimals,
      spends ? null : amountHuman,
      spends ? null : input.amountRaw,
      txHash,
      fromAddress,
      input.nonce,
      input.submitAttemptedAt ?? null,
      jsonb(input.venueEvidence),
    ],
  );
  if (!row) throw new Error("agent_activity: settlement-proven insert returned no row");

  if (!("existingId" in input.execution)) {
    // THE ATTEMPT IS OVER; THE CHAIN OUTCOME IS NOT. Completing the execution
    // states only that this recording finished, which is true the moment the
    // row exists. The still-`pending` activity row is what keeps the money-state
    // gate honest about the settlement itself, and it is the row the claim lane
    // owns.
    await completeExecutionIntentWith(client, {
      executionId,
      result: { status: "settlement_leg_recorded", eventRole: input.eventRole, txHash },
      success: true,
      tradeCapture: null,
      externalRefs: { txHash },
      durationMs: 0,
    });
  }

  const event = mapRow(row);
  return { outcome: "recorded", activityId: event.id, executionId, event };
}

function refused(
  reason: SettlementProvenRefusal,
  detail: string,
): InsertSettlementProvenActivityRowOutcome {
  return { outcome: "refused", reason, detail };
}
