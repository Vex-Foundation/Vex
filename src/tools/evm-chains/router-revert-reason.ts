/**
 * What an EVM router's on-chain revert reason MEANS.
 *
 * Extracted from `tools/uniswap/revert-mapping.ts` (2026-07-25) because the
 * knowledge is not Uniswap's. KyberSwap's router reverts a swap whose price
 * moved with `Return amount is not enough`; Uniswap's says `Too little
 * received`. Those are one condition in two dialects, and the venue that met a
 * string first must not be the only one allowed to understand it — the
 * alternative was a second mapper, and two tables drift. This module is the
 * single owner; `revert-mapping.ts` now consumes it and keeps its own
 * venue-specific viem error-class handling.
 *
 * It lives beside `gas-limit-headroom.ts` and `dependent-leg-gas-estimate.ts`,
 * the other cross-venue EVM policies every venue reaches through, so the
 * import direction stays one-way (venues depend on `evm-chains`, never the
 * reverse) and no venue has to import another venue to read a revert string.
 *
 * Every Uniswap literal below was verified against the real Uniswap
 * V2-periphery / V3-periphery / swap-router-contracts source during the
 * original implementation (GitHub `Uniswap/v2-periphery`,
 * `Uniswap/v3-periphery`, `Uniswap/swap-router-contracts`) and is moved here
 * BYTE-FOR-BYTE, mapping included. The one KyberSwap literal was captured from
 * a real refused estimate (Base, 2026-07-25, native ETH → USDC at 50 bps).
 * ADD NOTHING HERE FROM MEMORY: a string earns a row by appearing in verified
 * upstream source or in a captured chain response, because a wrong row sends
 * an autonomous agent to fix the wrong parameter.
 *
 * `TransferHelper`'s two/three-letter codes ("STF"/"ST"/"SA"/"STE") are
 * matched as an EXACT decoded reason (never a raw substring search over the
 * full error text), so a two-letter code cannot false-positive-match unrelated
 * text elsewhere in viem's verbose error message.
 */

/**
 * A narrow, LOCAL subset of the closed `AgentActivityFailureCode` enum
 * (`vex-agent/db/repos/agent-activity.ts`) — every literal below is also a
 * valid member of that wider type, so a caller can assign a result straight
 * into a `FailActivityEventInput.failureCode` field with no cast. Kept local
 * (not imported from the repo layer) so this venue-primitive module stays
 * import-direction-clean: `src/tools/**` must not depend on
 * `src/vex-agent/**`.
 */
export type EvmRouterRevertFailureCode =
  | "route_not_found"
  | "slippage"
  | "deadline_expired"
  | "insufficient_liquidity"
  | "allowance_or_balance"
  | "chain_unsupported"
  | "simulation_reverted"
  | "broadcast_error"
  | "unknown";

/** Exact on-chain revert reason → failure code. Verified against upstream source / captured chain responses (see file header). */
const ROUTER_REVERT_REASON_TABLE: ReadonlyMap<string, EvmRouterRevertFailureCode> = new Map([
  // ── KyberSwap MetaAggregationRouterV2 ────────────────────────────────────
  // Captured live: Base, 2026-07-25, native ETH → USDC, 2 hops
  // (curve-stable-ng, pancake-infinity-cl), 50 bps. The pool moved past the
  // `minReturnAmount` embedded in the built calldata between build and
  // pre-sign estimate. The identical swap at 300 bps landed
  // (0x2475561bda43bc24cc1d9d8051265c73d71daf661ad7ee2446cd18c81fd6b8e6).
  ["Return amount is not enough", "slippage"],
  // ── UniswapV2Router02.sol ────────────────────────────────────────────────
  ["UniswapV2Router: INVALID_PATH", "route_not_found"],
  ["UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT", "slippage"],
  ["UniswapV2Router: EXCESSIVE_INPUT_AMOUNT", "slippage"],
  ["UniswapV2Router: EXPIRED", "deadline_expired"],
  // ── UniswapV2Library.sol (linked into the router; reachable from a swap call) ─
  ["UniswapV2Library: INVALID_PATH", "route_not_found"],
  ["UniswapV2Library: INSUFFICIENT_LIQUIDITY", "insufficient_liquidity"],
  ["UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT", "insufficient_liquidity"],
  ["UniswapV2Library: INSUFFICIENT_OUTPUT_AMOUNT", "insufficient_liquidity"],
  ["UniswapV2Library: IDENTICAL_ADDRESSES", "simulation_reverted"],
  ["UniswapV2Library: ZERO_ADDRESS", "simulation_reverted"],
  // ── UniswapV2Pair.sol / core (the FoT-supporting router variants avoid
  // TRANSFER_FAILED in normal operation; K/LOCKED remain possible edge cases) ─
  ["UniswapV2: TRANSFER_FAILED", "allowance_or_balance"],
  ["UniswapV2: K", "simulation_reverted"],
  ["UniswapV2: LOCKED", "simulation_reverted"],
  // ── swap-router-contracts V3SwapRouter.sol ───────────────────────────────
  ["Too little received", "slippage"],
  ["Too much requested", "slippage"],
  ["swaps entirely within 0-liquidity regions are not supported", "insufficient_liquidity"],
  // ── v3-periphery PeripheryValidation.sol (checkDeadline modifier — our multicall(deadline, ...) wrapper) ─
  ["Transaction too old", "deadline_expired"],
  // ── v3-periphery PeripheryPayments.sol ───────────────────────────────────
  ["Insufficient WETH9", "slippage"],
  ["Insufficient token", "allowance_or_balance"],
  // ── v3-periphery libraries/TransferHelper.sol ────────────────────────────
  ["STF", "allowance_or_balance"],
  ["ST", "allowance_or_balance"],
  ["SA", "allowance_or_balance"],
  ["STE", "allowance_or_balance"],
]);

/**
 * The failure code for an exact decoded revert reason, or `undefined` when the
 * table has no row for it. `undefined` means "we do not know", NOT "harmless"
 * — callers map it to their own honest fallback (`simulation_reverted` for a
 * genuine decoded revert we have no bucket for) rather than guessing a remedy.
 */
export function classifyRouterRevertReason(reason: string): EvmRouterRevertFailureCode | undefined {
  return ROUTER_REVERT_REASON_TABLE.get(reason);
}

/** Walk an error's `.cause` chain looking for a `shortMessage` string (viem `BaseError` shape). Bounded to avoid an accidental cycle. */
function findShortMessage(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth += 1) {
    const shortMessage = (current as { shortMessage?: unknown }).shortMessage;
    if (typeof shortMessage === "string" && shortMessage.length > 0) return shortMessage;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * `viem`'s `ExecutionRevertedError` embeds the raw on-chain revert reason
 * (already stripped of the "execution reverted[: ]" node prefix) inside its
 * own `shortMessage`, formatted as either "Execution reverted with reason:
 * <reason>." or "Execution reverted for an unknown reason." — extract the
 * `<reason>` segment verbatim, or `undefined` when the node gave no reason.
 *
 * The returned string is CHAIN-CONTROLLED, UNTRUSTED text: a non-standard or
 * malicious contract chooses it. It must cross the caller's own scrub boundary
 * before it reaches model context, a log, or a durable column.
 */
export function extractDecodedRevertReason(err: unknown): string | undefined {
  const shortMessage = findShortMessage(err);
  if (!shortMessage) return undefined;
  const match = /with reason:\s*(.+?)\.?\s*$/.exec(shortMessage);
  return match?.[1]?.trim();
}
