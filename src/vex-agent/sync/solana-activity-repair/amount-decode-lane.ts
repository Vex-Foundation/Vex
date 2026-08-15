/**
 * The Solana sweep's EXECUTED-AMOUNT lane: which landed rows are worth a full
 * transaction body, how many bodies one sweep run may fetch, and what the decode
 * of that body is allowed to conclude.
 *
 * It exists beside `../solana-activity-repair.ts` rather than inside it because
 * it changes for different reasons: that file owns TERMINALITY (did this
 * signature land, did it carry an error), this one owns MONEY EVIDENCE.
 *
 * WHY A BODY AT ALL. The status question is answered by one batched
 * `getSignatureStatuses` entry, so the sweep deliberately fetched no body on the
 * success path. Executed amounts, however, exist ONLY in
 * `meta.pre/postTokenBalances`, so a row that can carry amounts is worth exactly
 * one extra `getTransaction`. That fetch is bounded two ways: only rows whose
 * OWN persisted record names the mints to bound the deltas by are eligible at
 * all (a swap's settlement profile, a lend/prediction row's declared token
 * columns - see `amountBounds`), and at most
 * `SOLANA_SWEEP_AMOUNT_BODY_FETCH_LIMIT` bodies are fetched per resolve call,
 * one after another - never in parallel, so the existing RPC pacing is unchanged
 * and a large due batch cannot turn into a burst.
 *
 * EVIDENCE READ vs EVIDENCE MISSING. A decode that ran and refused (a wrapped-SOL
 * leg with no ATA entry, an ambiguous double delta, a foreign-owner-only mint)
 * is a CONCLUSION: the row confirms status-only, immediately, exactly as it did
 * before this lane existed. A body we never got to read (RPC unavailable, fetch
 * budget spent) is NOT a conclusion, and confirming on it would burn the row's
 * one-shot terminal write and lose amounts that were there to be read - so the
 * row stays pending and is retried on the next tick.
 */

import { readJupiterFeeSwapSettlementProfile } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/settlement-profile.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import type { SolanaActivitySweepDeps } from "./sweep-port.js";
import {
  decodeDeclaredLegExecutedAmounts,
  decodeJupiterSwapExecutedAmounts,
  type SolanaExecutedLegAmounts,
} from "./executed-amounts.js";

/**
 * Transaction bodies one `resolveSolanaPendingRows` call may fetch for amount
 * decoding, on top of the single batched status call it already makes.
 *
 * Sized well below the 25-row batch limit: the amount lane is an enrichment, and
 * a row it cannot serve this tick is retried 30 seconds later at the FRONT of
 * the queue (its `last_checked_at` is deliberately left untouched, because
 * nothing was checked). Terminality never waits on it.
 */
export const SOLANA_SWEEP_AMOUNT_BODY_FETCH_LIMIT = 8;

export interface SolanaAmountFetchBudget {
  remaining: number;
}

export function createSolanaAmountFetchBudget(): SolanaAmountFetchBudget {
  return { remaining: SOLANA_SWEEP_AMOUNT_BODY_FETCH_LIMIT };
}

export type SolanaAmountLaneOutcome =
  /**
   * Both legs proven from owner-and-mint-bounded SPL deltas - confirm WITH
   * amounts. `blockTimeIso` is the settling block's time read from the same
   * body (`result.blockTime`, seconds), or null when the body did not carry
   * one; the sweep records it via `noteSettledBlockTime` so the AgentScan
   * report can state the chain's own confirmation time instead of nothing.
   */
  | {
      readonly outcome: "amounts";
      readonly amounts: SolanaExecutedLegAmounts;
      readonly blockTimeIso: string | null;
    }
  /** Nothing to decode for this row at all - confirm status-only, as before, and claim nothing about why. */
  | { readonly outcome: "status_only" }
  /**
   * The body WAS read and the decode refused it. Terminality is unaffected (the
   * row still confirms status-only), but this is a CONCLUSION about the amounts:
   * they will never be established for this row, so the caller stamps the
   * settlement decline and the outbox stops holding the row for amounts that are
   * not coming.
   */
  | { readonly outcome: "undecodable"; readonly reason: string }
  /** No evidence was read at all - do not terminalize this tick. */
  | { readonly outcome: "retry_next_tick"; readonly reason: "body_unavailable" | "fetch_budget_spent" };

/**
 * `body` is passed in by the sweep's not-found fallback, which has ALREADY
 * fetched the transaction for its `meta.err` check - decoding that same body
 * costs no extra RPC call and spends no budget.
 */
export async function resolveSolanaExecutedAmounts(
  event: AgentActivityEvent,
  deps: SolanaActivitySweepDeps,
  budget: SolanaAmountFetchBudget,
  alreadyFetchedBody?: unknown,
): Promise<SolanaAmountLaneOutcome> {
  const bounds = amountBounds(event);
  if (bounds === null) return STATUS_ONLY;

  const fetched = alreadyFetchedBody === undefined
    ? await fetchBodyWithinBudget(event, deps, budget)
    : ({ ok: true, body: alreadyFetchedBody } as const);
  if (!fetched.ok) return fetched.deferred;

  const decoded = decodeAmountsForBounds(fetched.body, bounds);
  if (decoded.outcome === "declined") {
    // Observable, structured, and free of provider text: the reason is one of
    // this decoder's own named codes, never a raw RPC payload.
    logger.info("solana_activity_repair.executed_amounts_declined", {
      id: event.id,
      protocol: event.protocol,
      reason: decoded.reason,
    });
    return { outcome: "undecodable", reason: decoded.reason };
  }
  logger.info("solana_activity_repair.executed_amounts_decoded", {
    id: event.id,
    protocol: event.protocol,
    source: "spl_balance_delta",
  });
  return { outcome: "amounts", amounts: decoded.amounts, blockTimeIso: readBlockTimeIso(fetched.body) };
}

/**
 * The decode these bounds call for: a swap must prove both legs, a declared-leg
 * row proves each leg it named. EXPORTED alongside `amountBounds` so the
 * amount-correction lane runs the identical decode on an already-confirmed row.
 */
export function decodeAmountsForBounds(
  body: unknown,
  bounds: SolanaAmountBounds,
): { readonly outcome: "proven"; readonly amounts: SolanaExecutedLegAmounts }
  | { readonly outcome: "declined"; readonly reason: string } {
  return bounds.kind === "swap"
    ? decodeJupiterSwapExecutedAmounts(body, bounds)
    : decodeDeclaredLegExecutedAmounts(body, bounds);
}

/**
 * `result.blockTime` of a raw `getTransaction` body: Unix seconds, nullable by
 * the RPC contract. Anything that is not a positive finite number is treated
 * as absent - a missing block time only means the report sends no confirmation
 * time, so this never guesses.
 */
export function readBlockTimeIso(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const blockTime = (body as Record<string, unknown>).blockTime;
  if (typeof blockTime !== "number" || !Number.isFinite(blockTime) || blockTime <= 0) return null;
  return new Date(blockTime * 1000).toISOString();
}

const STATUS_ONLY = { outcome: "status_only" } as const;

export type SolanaAmountBounds =
  | { readonly kind: "swap"; readonly owner: string; readonly inputMint: string; readonly outputMint: string }
  | {
      readonly kind: "declared_legs";
      readonly owner: string;
      readonly inputMint: string | null;
      readonly outputMint: string | null;
    };

/**
 * WHICH MINTS this row's amounts may be bounded by, or `null` when it has none
 * this lane trusts - the whole of the eligibility rule, in one place.
 *
 * A `swap` row is bounded by its persisted SETTLEMENT PROFILE, Vex's own record
 * of the route it approved, and needs both mints because `confirmActivityEvent`
 * requires both of that role's legs.
 *
 * A `lend`/`prediction` row carries no profile - those handlers never write one
 * - so it is bounded by the mints the ROW ITSELF declared in
 * `token_in_address`/`token_out_address` at intent time. Still Vex's own record,
 * still never the transaction's account list, and each leg is proven separately
 * because these roles legitimately move one side only.
 *
 * A `bridge_deposit` is bounded INPUT-ONLY, whatever its row declares as an
 * output: the counter-leg of a deposit lands on the destination chain, in a
 * different transaction, on the fill row - exactly the asymmetry
 * `roleLegsIncomplete` encodes for that role. Its input is also the only amount
 * AgentScan prices.
 *
 * EXPORTED for the amount-correction lane, which asks the same eligibility
 * question about an already-confirmed row. One rule, two callers, no copy.
 */
export function amountBounds(event: AgentActivityEvent): SolanaAmountBounds | null {
  const owner = event.walletAddress;
  if (event.eventRole === "swap") {
    const profile = readJupiterFeeSwapSettlementProfile(event.routeProvenance);
    return profile
      ? { kind: "swap", owner, inputMint: profile.inputMint, outputMint: profile.outputMint }
      : null;
  }
  if (event.eventRole === "bridge_deposit") {
    const depositMint = solanaMintOrNull(event.tokenInAddress);
    return depositMint === null
      ? null
      : { kind: "declared_legs", owner, inputMint: depositMint, outputMint: null };
  }
  if (event.kind !== "lend" && event.kind !== "prediction") return null;
  const inputMint = solanaMintOrNull(event.tokenInAddress);
  const outputMint = solanaMintOrNull(event.tokenOutAddress);
  if (inputMint === null && outputMint === null) return null;
  return { kind: "declared_legs", owner, inputMint, outputMint };
}

/**
 * A column value usable as an SPL mint, or `null`. This is a LENGTH bound and
 * a `0x` refusal, NOT full base58 alphabet validation: these columns also hold
 * EVM addresses on other rows, and an invalid value that slips the bound fails
 * closed downstream - it can never match a balance entry's mint, so the decode
 * declines rather than misattributing.
 */
function solanaMintOrNull(address: string | null): string | null {
  if (address === null) return null;
  if (address.startsWith("0x")) return null;
  return address.length >= 32 && address.length <= 44 ? address : null;
}

type BodyFetch =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly deferred: SolanaAmountLaneOutcome };

async function fetchBodyWithinBudget(
  event: AgentActivityEvent,
  deps: SolanaActivitySweepDeps,
  budget: SolanaAmountFetchBudget,
): Promise<BodyFetch> {
  if (budget.remaining <= 0) {
    return { ok: false, deferred: { outcome: "retry_next_tick", reason: "fetch_budget_spent" } };
  }
  budget.remaining -= 1;
  const lookup = await deps.getFinalizedTransaction(event.txHash!);
  if (lookup.outcome !== "found") {
    return { ok: false, deferred: { outcome: "retry_next_tick", reason: "body_unavailable" } };
  }
  return { ok: true, body: lookup.value };
}
