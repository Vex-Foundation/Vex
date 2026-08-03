/**
 * Shared validation for the Trench Express money-path handlers.
 *
 * Both `trench.trade_quote` and `trench.trade_execute` take swap-shaped params
 * (`chain`, `tokenIn`, `tokenOut`, `amountIn`). Exactly ONE leg must be native
 * ETH — that decides the direction: native `tokenIn` is a BUY, native `tokenOut`
 * is a SELL. `min`, `deadline`, `recipient`, and any fee/value parameter are
 * NEVER accepted from the caller (rule 90): a supplied one is rejected BY NAME,
 * never silently dropped, so an attempted override is surfaced rather than hidden.
 */

import { getAddress, isAddress, type Address } from "viem";
import { isNativeTokenInput } from "@tools/kyberswap/helpers.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { resolveLocalChainId } from "@tools/evm-chains/registry.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { TRENCH_MAX_SLIPPAGE_BPS } from "@tools/trench-express/evm/min-out.js";
import { checkSlippageBps, VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import type { TrenchTradeSide } from "@tools/trench-express/evm/curve-reader.js";

/**
 * Parameters Vex derives itself and MUST NOT accept from a caller/model: the
 * minimum-output floor (limit), the deadline, the recipient/destination, and any
 * fee or raw value. A caller-supplied one is rejected by name.
 */
export const TRENCH_FORBIDDEN_TRADE_PARAMS = [
  "min",
  "minOut",
  "minAmountOut",
  "minOutput",
  "deadline",
  "recipient",
  "to",
  "destination",
  "fee",
  "feeBps",
  "feeReceiver",
  "value",
] as const;

/**
 * First caller-supplied forbidden trade param, else null.
 *
 * PRESENCE of the key is the violation, whatever it carries: an empty string,
 * `null`, or an explicit `undefined` is still an attempted override of a
 * fee/limit/destination parameter, and rule 90 requires surfacing it by name
 * rather than dropping it silently.
 */
export function findCallerSuppliedForbiddenTradeParam(
  params: Readonly<Record<string, unknown>>,
): string | null {
  for (const key of TRENCH_FORBIDDEN_TRADE_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(params, key)) return key;
  }
  return null;
}

export interface ResolvedTradeInputs {
  readonly chainId: number;
  readonly side: TrenchTradeSide;
  /** The curve token address (the non-native leg). */
  readonly token: Address;
  /** Identity address for the native ETH leg (the shared native sentinel). */
  readonly nativeAddress: Address;
  /** Human amount of the input token (raw param string, unparsed). */
  readonly amountInHuman: string;
  /**
   * Effective slippage tolerance (bps) Vex applies when computing `min` — the
   * caller's `slippageBps` when supplied (already validated ≤ cap), else the
   * default. The prequote match-hash binds the RAW param (omitted vs present),
   * so quote and execute must pass the same value or omit on both.
   */
  readonly slippageBps: number;
}

export type TradeInputResolution = { readonly ok: true; readonly value: ResolvedTradeInputs } | { readonly ok: false; readonly reason: string };

/**
 * Validate and normalize the swap-shaped trade params into a resolved
 * buy/sell direction + curve token. `chain` defaults to Robinhood Chain; any
 * other chain is rejected (the launchpad is single-chain).
 */
export function resolveTradeInputs(params: Record<string, unknown>): TradeInputResolution {
  const forbidden = findCallerSuppliedForbiddenTradeParam(params);
  if (forbidden) {
    return {
      ok: false,
      reason: `Parameter "${forbidden}" is not accepted — Vex derives the minimum output, deadline, recipient, and fees itself; remove it and retry.`,
    };
  }

  const chainRaw = typeof params.chain === "string" && params.chain.trim() !== "" ? params.chain.trim() : "robinhood";
  const chainId = resolveLocalChainId(chainRaw);
  if (chainId !== TRENCH_CHAIN_ID) {
    return { ok: false, reason: `Trench Express trades run only on Robinhood Chain (${TRENCH_CHAIN_ID}); received chain "${chainRaw}".` };
  }

  const tokenInRaw = typeof params.tokenIn === "string" ? params.tokenIn.trim() : "";
  const tokenOutRaw = typeof params.tokenOut === "string" ? params.tokenOut.trim() : "";
  const amountInHuman = typeof params.amountIn === "string" ? params.amountIn.trim() : "";
  if (!tokenInRaw || !tokenOutRaw || !amountInHuman) {
    return { ok: false, reason: "Missing required: tokenIn, tokenOut, amountIn." };
  }

  const inNative = isNativeTokenInput(tokenInRaw);
  const outNative = isNativeTokenInput(tokenOutRaw);
  if (inNative === outNative) {
    return {
      ok: false,
      reason: 'Exactly one leg must be native ETH: a BUY is tokenIn="ETH" + tokenOut=<token>, a SELL is tokenIn=<token> + tokenOut="ETH".',
    };
  }

  const side: TrenchTradeSide = inNative ? "buy" : "sell";
  const tokenRaw = inNative ? tokenOutRaw : tokenInRaw;
  if (!isAddress(tokenRaw)) {
    return { ok: false, reason: `The curve token must be a contract address; received "${tokenRaw.slice(0, 48)}".` };
  }

  // slippageBps is the ONE price knob the model may set. Rejected HERE (not only
  // at execute) so a tolerance the execute would refuse never produces a quote
  // that appears to authorize it — and REJECTED above the cap, never clamped.
  const slip = resolveSlippageBps(params);
  if (!slip.ok) return { ok: false, reason: slip.reason };

  return {
    ok: true,
    value: {
      chainId,
      side,
      token: getAddress(tokenRaw),
      nativeAddress: NATIVE_TOKEN_ADDRESS,
      amountInHuman,
      slippageBps: slip.bps,
    },
  };
}

/**
 * Resolve the effective slippage tolerance (bps). Absent → the default; present
 * → validated as a whole number in [0, cap], REJECTING (not clamping) anything
 * above the cap or non-integer/negative — mirroring the swap venues.
 */
function resolveSlippageBps(
  params: Record<string, unknown>,
): { readonly ok: true; readonly bps: number } | { readonly ok: false; readonly reason: string } {
  const raw = params.slippageBps;
  if (raw === undefined || raw === null) return { ok: true, bps: VEX_DEFAULT_SLIPPAGE_BPS };
  if (typeof raw !== "number") {
    return { ok: false, reason: 'Parameter "slippageBps" must be a whole number of basis points (1 bps = 0.01%).' };
  }
  const violation = checkSlippageBps('Parameter "slippageBps"', raw, TRENCH_MAX_SLIPPAGE_BPS);
  if (violation) return { ok: false, reason: violation };
  return { ok: true, bps: raw };
}
