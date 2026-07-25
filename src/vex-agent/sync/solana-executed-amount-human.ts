/**
 * The money convention a CONFIRMED Solana `agent_activity` row must satisfy:
 * every proven executed magnitude gets its exact-decimal human sibling, not
 * just a raw atomic integer.
 *
 * WHY THIS EXISTS: a live 0.5 USDC Jupiter Lend deposit confirmed with
 * `executed_amount_in_raw='500000'` and `executed_amount_in_human=NULL`, while
 * a confirmed EVM row carries both (`settlement-decoders.ts`'s
 * `DecodedSettlement` has always declared the human fields, and the EVM sweep
 * passes them through). The Solana decoders see a TRANSACTION, never the row's
 * token metadata, so they cannot format anything; the sweep holds the row and
 * its persisted `token_*_decimals`, so the conversion belongs here — between
 * the decode and the confirm.
 *
 * DEGRADE, NEVER FAIL. A row whose decimals were never persisted (written
 * before rows carried them) or a leg the row never named simply keeps its raw
 * magnitude and gets no human sibling. A missing decimal must never block a
 * confirm, never change a decode DECISION, and never produce an approximate
 * number instead of an exact one.
 *
 * STRING MATH ONLY. `atomicToExactDecimalString` is BigInt-based; `Number`,
 * `parseFloat` and `tokenAmountToUi` are forbidden here — u64 amounts exceed
 * `Number.MAX_SAFE_INTEGER` and a STORED money field must be exact.
 */

import { atomicToExactDecimalString } from "@tools/solana-ecosystem/shared/solana-validation.js";

import type { DecodedSolanaSettlement } from "./solana-settlement-decoders.js";

export interface SolanaSettlementLegDecimals {
  readonly tokenInDecimals: number | null;
  readonly tokenOutDecimals: number | null;
}

/**
 * Return the decoded settlement with an exact-decimal sibling for each leg
 * whose decimals the row actually persisted. Never throws; never alters a raw
 * magnitude.
 */
export function withExactExecutedAmountHuman(
  decoded: DecodedSolanaSettlement,
  legDecimals: SolanaSettlementLegDecimals,
): DecodedSolanaSettlement {
  const inHuman = exactHumanAmount(decoded.executedAmountInRaw, legDecimals.tokenInDecimals);
  const outHuman = exactHumanAmount(decoded.executedAmountOutRaw, legDecimals.tokenOutDecimals);
  return {
    ...decoded,
    ...(inHuman !== undefined ? { executedAmountInHuman: inHuman } : {}),
    ...(outHuman !== undefined ? { executedAmountOutHuman: outHuman } : {}),
  };
}

/** `undefined` whenever the pair cannot produce an EXACT decimal string — a bad pair drops the human field rather than corrupting it or throwing. */
function exactHumanAmount(amountRaw: string | undefined, decimals: number | null): string | undefined {
  if (amountRaw === undefined || decimals === null) return undefined;
  if (!Number.isInteger(decimals) || decimals < 0) return undefined;
  try {
    return atomicToExactDecimalString(BigInt(amountRaw), decimals);
  } catch {
    return undefined;
  }
}
