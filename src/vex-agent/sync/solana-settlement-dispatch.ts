/**
 * The ONE entry point the Solana activity sweep uses to turn a landed
 * transaction into executed amounts — registered-decoder dispatch for Solana
 * (design `solana-settlement-profile-design.md` D2; the promotion
 * `solana-settlement-decoders.ts`'s own doc named as the trigger for "a future
 * need for PER-PROTOCOL decode logic").
 *
 * TWO ARMS, ONE RULE:
 *   - a row whose `route_provenance` carries a VALIDATED settlement profile is
 *     decoded by that profile's protocol-aware decoder, which is the only kind
 *     of decoder that may classify a landing tip or a SOL-wrap funding
 *     transfer;
 *   - everything else — lend, prediction, bridge-deposit legs, and any row
 *     written before the profile existed — takes the generic owner+mint
 *     balance-delta path, completely unchanged.
 *
 * A MISSING OR INVALID PROFILE IS NEVER A GUESS. It simply is not evidence, so
 * dispatch degrades to the generic decoder, which declines whenever it cannot
 * prove a leg. There is deliberately NO fallback in the other direction: once a
 * profile has selected a protocol decoder, that decoder's decline is FINAL —
 * re-running the generic decoder afterwards would be an attempt to get a second
 * opinion from the arm that knows strictly less about the transaction.
 *
 * ADDING A PROTOCOL: add the kind to `settlement-profile.ts` and add one arm
 * below. Nothing else in the sweep changes.
 */

import {
  JUPITER_FEE_SWAP_SETTLEMENT_KIND,
  parseSolanaSettlementProfile,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/settlement-profile.js";

import { decodeJupiterFeeSwapSettlement } from "./solana-jupiter-swap-settlement.js";
import {
  decodeSolanaBalanceSettlement,
  type DecodedSolanaSettlement,
  type SolanaSettlementDecodeInput,
} from "./solana-settlement-decoders.js";

export interface SolanaSettlementDispatchInput extends SolanaSettlementDecodeInput {
  /** The row's persisted `route_provenance` JSONB — untrusted, validated by `parseSolanaSettlementProfile`. */
  readonly routeProvenance: Record<string, unknown> | null;
}

export function decodeSolanaSettlement(
  input: SolanaSettlementDispatchInput,
): DecodedSolanaSettlement | null {
  const profile = parseSolanaSettlementProfile(input.routeProvenance);

  // The profile describes a SWAP's economics, and the amounts it proves are
  // written into THIS row's executed columns — so it may only be used when the
  // row's own role and named mints agree with it. A mismatch (which should not
  // exist: one handler writes both) takes the generic path rather than
  // recording amounts for legs this row does not name.
  if (
    profile?.kind === JUPITER_FEE_SWAP_SETTLEMENT_KIND
    && input.eventRole === "swap"
    && input.tokenInAddress === profile.inputMint
    && input.tokenOutAddress === profile.outputMint
  ) {
    return decodeJupiterFeeSwapSettlement({
      parsedTransaction: input.parsedTransaction,
      walletAddress: input.walletAddress,
      profile,
    });
  }

  return decodeSolanaBalanceSettlement(input);
}
