import { UniswapFeeCapExceededError, UniswapLiveFeeMarketRefusal, type UniswapLiveFeeMarketRefusalKind } from "@tools/uniswap/fee-cap-gate.js";
import { uniswapFailureMessage } from "./error-output.js";

/** A local fee-bound refusal is neither a router revert nor an unknown failure. */
export function uniswapFeeRefusal(error: unknown): {
  failureCode: "fee_bound_refused"; failureReason: string; retryable: boolean; feeRefusalKind: UniswapLiveFeeMarketRefusalKind | "prepared_fee_exceeded";
} | undefined {
  if (!(error instanceof UniswapFeeCapExceededError) && !(error instanceof UniswapLiveFeeMarketRefusal)) return undefined;
  return { failureCode: "fee_bound_refused", failureReason: uniswapFailureMessage(error, { preserveLength: true }),
    retryable: error instanceof UniswapLiveFeeMarketRefusal && error.retryable,
    feeRefusalKind: error instanceof UniswapLiveFeeMarketRefusal ? error.kind : "prepared_fee_exceeded" };
}
