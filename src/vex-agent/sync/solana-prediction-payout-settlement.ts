/**
 * Jupiter Prediction PAYOUT settlement decoder — the protocol-aware arm of
 * `solana-settlement-dispatch.ts` for `predict_sell` / `predict_claim` /
 * `predict_close` (phase-3 W2, live-gate DEFECT 7).
 *
 * WHAT THE CHAIN PROVED, 2026-07-25, with real funds:
 *   - a prediction position pays out in JupUSD, not in the USDC it was bought
 *     with (`JUPITER_PREDICTION_PAYOUT_MINT`);
 *   - the transaction VEX BROADCASTS for a sell/claim does not carry the
 *     money. Sell `5AChd2vmZt…`: the only mint present is JupUSD and the
 *     wallet's balance is identical pre and post (271024 both sides). The
 *     proceeds arrive later, in a keeper's fill.
 *
 * WHY THIS EXISTS AS ITS OWN DECODER, and why the guard is STRICTLY POSITIVE.
 * The generic decoder (`solana-settlement-decoders.ts`) is deliberately
 * protocol-agnostic and cannot express either rule:
 *   - `decodeTokenBalanceDelta` returns `0n`, NOT `null`, when the wallet's
 *     account for the mint exists but is unchanged — precisely the shape
 *     above. `confirmActivityEvent` checks PRESENCE, not magnitude
 *     (044_agent_activity.sql:134-137), and `'0'` is present. So correcting
 *     the mint WITHOUT this guard would upgrade an honest `pending` row into
 *     a CONFIRMED ZERO PAYOUT — a wrong number the agent believes, which is
 *     strictly worse than the row it replaces.
 *   - the generic decoder stores an ABSOLUTE magnitude (`absRaw`), so a
 *     NEGATIVE JupUSD movement would be recorded as a payout of that size. A
 *     merely non-zero guard does not catch that; only `> 0` does.
 *
 * DECLINE IS NOT FAILURE. Zero, negative, untouched, or a foreign mint all
 * leave the row `pending` and re-checked by the sweep with backoff. "We could
 * not read the payout" is not "the payout failed" — this module never
 * terminalizes anything, and `solana-activity-repair.ts` logs
 * `undecodable_success` so a stuck row is operator-visible.
 *
 * THE MINT IS A CONSTANT, NOT A LOOKUP. See
 * `jupiter-prediction/constants.ts` — resolving the payout mint from whatever
 * the settlement happened to carry would make Vex follow an asset migration
 * silently. Asserting the constant fails loudly instead, which is the point.
 * Rows written before this landed name USDC and therefore decline here
 * forever; that is correct and costs nothing, because a prediction
 * transaction never moved the wallet's USDC either, so they were already
 * pending and could never have confirmed honestly.
 *
 * DISPATCH CONTRACT: once dispatch routes a row here, this decline is FINAL —
 * there is deliberately no fall-through to the generic decoder, which knows
 * strictly less about this transaction (see `solana-settlement-dispatch.ts`).
 */

import {
  JUPITER_PREDICTION_PAYOUT_MINT,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/constants.js";
import type { AgentActivityEventRole } from "@vex-agent/db/repos/agent-activity.js";

import {
  decodeTokenBalanceDelta,
  type DecodedSolanaSettlement,
  type ParsedSolanaTransaction,
} from "./solana-settlement-decoders.js";

/**
 * The roles whose settlement is a PAYOUT to the wallet. `predict_sell` is the
 * single-position close; `closeAll` fans out into `predict_close` (a close
 * item) and `predict_claim` (a claim item) — all three credit the wallet, so
 * all three are guarded identically.
 *
 * `predict_buy` is deliberately absent: it DEBITS USDC and the debit happens
 * in the transaction Vex broadcasts (chain-proven on `4VLWmR6QQF…`:
 * 18383433 → 13383433), so the generic decoder proves it correctly.
 */
export const PREDICTION_PAYOUT_EVENT_ROLES = [
  "predict_sell",
  "predict_claim",
  "predict_close",
] as const satisfies readonly AgentActivityEventRole[];

export type PredictionPayoutEventRole = (typeof PREDICTION_PAYOUT_EVENT_ROLES)[number];

export function isPredictionPayoutEventRole(
  eventRole: AgentActivityEventRole,
): eventRole is PredictionPayoutEventRole {
  return (PREDICTION_PAYOUT_EVENT_ROLES as readonly AgentActivityEventRole[]).includes(eventRole);
}

export interface PredictionPayoutDecodeInput {
  readonly parsedTransaction: ParsedSolanaTransaction;
  readonly walletAddress: string;
  /** The row's `token_in_address`. A payout row never names one; anything else is a shape this decoder cannot prove whole. */
  readonly tokenInAddress: string | null;
  /** The row's `token_out_address` — must be the JupUSD payout mint. */
  readonly tokenOutAddress: string | null;
}

/**
 * `{ executedAmountOutRaw }` only for a STRICTLY POSITIVE JupUSD credit to
 * this wallet in this transaction. `null` — leave the row pending — for every
 * other outcome: a foreign or absent payout mint, an input leg this decoder
 * cannot account for, a mint the transaction never touched, a zero delta, or
 * a negative one.
 */
export function decodeJupiterPredictionPayoutSettlement(
  input: PredictionPayoutDecodeInput,
): DecodedSolanaSettlement | null {
  if (input.tokenInAddress !== null) return null;
  if (input.tokenOutAddress !== JUPITER_PREDICTION_PAYOUT_MINT) return null;

  const delta = decodeTokenBalanceDelta(
    input.parsedTransaction,
    input.walletAddress,
    JUPITER_PREDICTION_PAYOUT_MINT,
  );
  if (delta === null || delta <= 0n) return null;

  return { executedAmountOutRaw: delta.toString() };
}
