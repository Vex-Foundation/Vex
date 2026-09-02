/**
 * The bridge between this venue's own objects and the quote-authority snapshot.
 *
 * It exists so the QUOTE and the EXECUTE derive the bound fields through ONE
 * function each. The 2026-08-27 incident on the sibling venue was not a wrong
 * formula; it was two code paths computing the same quantity from different
 * inputs, and only one of them being the one the human saw.
 */

import { formatUnits } from "viem";

import type { UniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import type { UniswapToken } from "@tools/uniswap/types.js";

import {
  UNISWAP_SNAPSHOT_VERSION,
  sealUniswapSnapshot,
  type UniswapExecutionInputs,
  type UniswapExecutionSnapshot,
  type UniswapSnapshotFee,
  type UniswapSnapshotToken,
} from "../../../quote-authority/uniswap.js";
import type { QuotedRoute } from "./route-quote.js";

function snapshotToken(token: UniswapToken): UniswapSnapshotToken {
  return {
    address: token.address,
    isNative: token.isNative,
    symbol: token.symbol,
    decimals: token.decimals,
  };
}

/**
 * The fee EXACTLY as the human was told about it.
 *
 * The skipped branch carries its `reason` into the text, because the two ways a
 * fee can be declined - a dust-sized fee, and a token Vex will not skim - are
 * different facts about the trade, and an execute that swaps one for the other
 * has changed what was disclosed even though both say "no fee".
 */
export function snapshotFeeFrom(charge: UniswapFeeCharge): UniswapSnapshotFee {
  const disclosure = charge.disclosure;
  return disclosure.charged
    ? {
        disposition: "charged",
        amountRaw: disclosure.feeAmountRaw,
        disclosureText: disclosure.note,
      }
    : {
        disposition: "not_charged",
        amountRaw: null,
        disclosureText: `${disclosure.note} Reason: ${disclosure.reason}`,
      };
}

/** What the execute re-resolved, in the shape the snapshot comparison walks. */
export function executionInputsFrom(input: {
  readonly chainId: number;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  readonly charge: UniswapFeeCharge;
}): UniswapExecutionInputs {
  return {
    chainId: input.chainId,
    tokenIn: snapshotToken(input.tokenIn),
    tokenOut: snapshotToken(input.tokenOut),
    totalInRaw: input.charge.totalRaw.toString(),
    swapAmountRaw: input.charge.swapAmountRaw.toString(),
    fee: snapshotFeeFrom(input.charge),
  };
}

/**
 * Seal what this quote authorizes.
 *
 * `quoted.minAmountOut` is the floor `applySlippage` derived from the output
 * this very answer shows. It is stored, and the execute writes THAT number into
 * the calldata - it never recomputes a floor from a fresher route.
 */
export function buildUniswapQuoteSnapshot(input: {
  readonly chainId: number;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  readonly charge: UniswapFeeCharge;
  readonly quoted: QuotedRoute;
  readonly expiresAt: string;
}): UniswapExecutionSnapshot {
  const { tokenOut, quoted } = input;
  const inputs = executionInputsFrom(input);
  return sealUniswapSnapshot({
    v: UNISWAP_SNAPSHOT_VERSION,
    provider: "uniswap",
    chainId: inputs.chainId,
    tokenIn: inputs.tokenIn,
    tokenOut: inputs.tokenOut,
    totalInRaw: inputs.totalInRaw,
    swapAmountRaw: inputs.swapAmountRaw,
    fee: inputs.fee,
    approvedAmountOutRaw: quoted.amountOut.toString(),
    approvedMinOutRaw: quoted.minAmountOut.toString(),
    approvedAmountOutHuman: formatUnits(quoted.amountOut, tokenOut.decimals),
    approvedMinOutHuman: formatUnits(quoted.minAmountOut, tokenOut.decimals),
    slippageBps: quoted.slippageBps,
    expiresAt: input.expiresAt,
  });
}
