/**
 * Uniswap revert-string → failure-code mapping (plan §8.2), captured from the
 * SIGN-time path only (never the broadcast/send stage — C29, see
 * `classifyUniswapRevertError`'s own doc — and never a mined receipt: a
 * mined-but-reverted receipt with no decoded reason is the repair sweep's
 * `mined_revert`, see `db/repos/agent-activity.ts`).
 *
 * `UniswapRevertFailureCode` is a narrow, LOCAL subset of the closed
 * `AgentActivityFailureCode` enum — every literal below is also a valid
 * member of that wider type, so a caller can assign this module's result
 * straight into a `FailActivityEventInput.failureCode` field with no cast.
 * Kept local (not imported from `db/repos/agent-activity.js`) so this
 * venue-primitive module stays import-direction-clean (`src/tools/**` must
 * not depend on `src/vex-agent/**`).
 *
 * Every literal revert string below was verified against the real Uniswap
 * V2-periphery / V3-periphery / swap-router-contracts source (GitHub,
 * `Uniswap/v2-periphery`, `Uniswap/v3-periphery`, `Uniswap/swap-router-contracts`,
 * `main`/`master` branch, fetched during implementation) — not recalled from
 * memory. `TransferHelper`'s two/three-letter codes ("STF"/"ST"/"SA"/"STE")
 * are matched as an EXACT decoded reason (never a raw substring search over
 * the full error text), so a two-letter code cannot false-positive-match
 * unrelated text elsewhere in viem's verbose error message.
 */

import {
  ExecutionRevertedError,
  FeeCapTooHighError,
  FeeCapTooLowError,
  InsufficientFundsError,
  IntrinsicGasTooHighError,
  IntrinsicGasTooLowError,
  NonceMaxValueError,
  NonceTooHighError,
  NonceTooLowError,
  TipAboveFeeCapError,
  TransactionTypeNotSupportedError,
} from "viem";

import { VexError, ErrorCodes } from "../../errors.js";
import { redact } from "../../lib/diagnostics/text-redaction.js";

export type UniswapRevertFailureCode =
  | "route_not_found"
  | "slippage"
  | "deadline_expired"
  | "insufficient_liquidity"
  | "allowance_or_balance"
  | "chain_unsupported"
  | "simulation_reverted"
  | "broadcast_error"
  | "unknown";

export interface UniswapRevertClassification {
  readonly failureCode: UniswapRevertFailureCode;
  readonly failureReason: string;
}

/** Exact on-chain revert reason → failure code. Verified against upstream source (see file header). */
const REVERT_REASON_TABLE: ReadonlyMap<string, UniswapRevertFailureCode> = new Map([
  // UniswapV2Router02.sol
  ["UniswapV2Router: INVALID_PATH", "route_not_found"],
  ["UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT", "slippage"],
  ["UniswapV2Router: EXCESSIVE_INPUT_AMOUNT", "slippage"],
  ["UniswapV2Router: EXPIRED", "deadline_expired"],
  // UniswapV2Library.sol (linked into the router; reachable from a swap call)
  ["UniswapV2Library: INVALID_PATH", "route_not_found"],
  ["UniswapV2Library: INSUFFICIENT_LIQUIDITY", "insufficient_liquidity"],
  ["UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT", "insufficient_liquidity"],
  ["UniswapV2Library: INSUFFICIENT_OUTPUT_AMOUNT", "insufficient_liquidity"],
  ["UniswapV2Library: IDENTICAL_ADDRESSES", "simulation_reverted"],
  ["UniswapV2Library: ZERO_ADDRESS", "simulation_reverted"],
  // UniswapV2Pair.sol / core (the FoT-supporting router variants avoid TRANSFER_FAILED
  // in normal operation; K/LOCKED remain possible edge cases)
  ["UniswapV2: TRANSFER_FAILED", "allowance_or_balance"],
  ["UniswapV2: K", "simulation_reverted"],
  ["UniswapV2: LOCKED", "simulation_reverted"],
  // swap-router-contracts V3SwapRouter.sol
  ["Too little received", "slippage"],
  ["Too much requested", "slippage"],
  ["swaps entirely within 0-liquidity regions are not supported", "insufficient_liquidity"],
  // v3-periphery PeripheryValidation.sol (checkDeadline modifier — our multicall(deadline, ...) wrapper)
  ["Transaction too old", "deadline_expired"],
  // v3-periphery PeripheryPayments.sol
  ["Insufficient WETH9", "slippage"],
  ["Insufficient token", "allowance_or_balance"],
  // v3-periphery libraries/TransferHelper.sol
  ["STF", "allowance_or_balance"],
  ["ST", "allowance_or_balance"],
  ["SA", "allowance_or_balance"],
  ["STE", "allowance_or_balance"],
]);

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
 * True iff any error in the `.cause` chain is an instance of one of the given
 * classes. Bounded to avoid an accidental cycle. `new (...args: never[])`
 * (not `any[]`) is deliberate: viem's error classes have DIFFERENT
 * constructor parameter shapes, and `never[]` is the narrowest rest-parameter
 * type every one of them is still assignable to — safe here because this
 * function only ever reads the constructors for `instanceof`, never invokes
 * them (a `never[]` signature cannot be called at all).
 */
function chainIncludesInstanceOf(err: unknown, ctors: readonly (new (...args: never[]) => Error)[]): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    if (ctors.some((ctor) => current instanceof ctor)) return true;
    if (typeof current !== "object" || current === null) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `viem`'s `ExecutionRevertedError` embeds the raw on-chain revert reason
 * (already stripped of the "execution reverted[: ]" node prefix) inside its
 * own `shortMessage`, formatted as either "Execution reverted with reason:
 * <reason>." or "Execution reverted for an unknown reason." — extract the
 * `<reason>` segment verbatim, or `undefined` when the node gave no reason.
 */
function extractDecodedRevertReason(err: unknown): string | undefined {
  const shortMessage = findShortMessage(err);
  if (!shortMessage) return undefined;
  const match = /with reason:\s*(.+?)\.?\s*$/.exec(shortMessage);
  return match?.[1]?.trim();
}

/**
 * C29 (Codex final-review round 2, finding 1 — supersedes FIX2's C15
 * implementation): NOTHING `broadcastUniswapTransaction`
 * (`publicClient.sendRawTransaction`) can throw is provably pre-wire. viem
 * mints `InvalidParamsRpcError`/`InvalidInputRpcError` from the NODE's own
 * JSON-RPC response (`-32602`/`-32000`, traced through viem's
 * `utils/buildRequest.ts` code-to-class switch) — i.e. the request already
 * reached the server; `-32000` in particular can mean "already known" (the
 * transaction may already be in the mempool from this exact call). FIX2
 * wrongly treated these two classes as a safe local-rejection signal and has
 * been REMOVED — there is no independently-branded LOCAL error in this
 * module's flow (`sendRawTransaction` is a single network round-trip with no
 * local pre-validation step ahead of it), so every broadcast rejection is
 * unconditionally ambiguous. See `execute.ts`'s `broadcastUniswapTransaction`
 * caller (`handlers/swap.ts`'s `runStagedBroadcast`), which no longer
 * branches on any pre-wire classifier at all.
 */

const BROADCAST_REJECTION_CLASSES = [
  NonceTooLowError,
  NonceTooHighError,
  NonceMaxValueError,
  FeeCapTooHighError,
  FeeCapTooLowError,
  TipAboveFeeCapError,
  IntrinsicGasTooHighError,
  IntrinsicGasTooLowError,
  TransactionTypeNotSupportedError,
];

/**
 * Classify a thrown SIGN-time error (`signUniswapTransaction` — prepare/
 * estimate-gas/local-sign, never a network broadcast) into a bounded failure
 * code + sanitized-length reason. A sign-time failure is UNAMBIGUOUSLY
 * pre-wire (no `sendRawTransaction` call has happened yet), unlike a
 * broadcast-stage rejection, which per C29 is NEVER classified this way — see
 * `handlers/swap.ts`'s `runStagedBroadcast`, which treats every
 * `broadcastUniswapTransaction` failure as ambiguous unconditionally. NEVER
 * call this for a mined-but-reverted receipt either (that is `mined_revert`,
 * set only by the repair sweep / the handler's own receipt-guard branch —
 * see `db/repos/agent-activity.ts`'s write protocol).
 */
export function classifyUniswapRevertError(err: unknown): UniswapRevertClassification {
  const reason = extractDecodedRevertReason(err);
  if (reason !== undefined) {
    const mapped = REVERT_REASON_TABLE.get(reason);
    if (mapped) return { failureCode: mapped, failureReason: reason };
    // A genuine, decoded on-chain revert we do not have a specific bucket for.
    return { failureCode: "simulation_reverted", failureReason: reason };
  }

  if (chainIncludesInstanceOf(err, [InsufficientFundsError])) {
    return {
      failureCode: "allowance_or_balance",
      failureReason: "insufficient native balance for value + gas",
    };
  }

  if (chainIncludesInstanceOf(err, BROADCAST_REJECTION_CLASSES)) {
    return {
      failureCode: "broadcast_error",
      failureReason: "the network rejected the signed transaction (nonce/fee/gas)",
    };
  }

  if (chainIncludesInstanceOf(err, [ExecutionRevertedError])) {
    // Reverted, but the node gave no decodable reason at all.
    return { failureCode: "unknown", failureReason: "reverted with no reason available" };
  }

  return {
    failureCode: "unknown",
    failureReason: err instanceof Error ? err.constructor.name : "unrecognized error",
  };
}

/** Pre-broadcast `VexError` code → failure code, for a validation/quote failure that never reached a signed payload. */
const PRE_BROADCAST_CODE_TABLE: ReadonlyMap<string, UniswapRevertFailureCode> = new Map([
  [ErrorCodes.KYBER_UNSUPPORTED_CHAIN, "chain_unsupported"],
  [ErrorCodes.KYBER_ROUTE_NOT_FOUND, "route_not_found"],
  [ErrorCodes.KYBER_TOKEN_NOT_FOUND, "route_not_found"],
  [ErrorCodes.INSUFFICIENT_BALANCE, "allowance_or_balance"],
  [ErrorCodes.INVALID_SPENDER, "allowance_or_balance"],
]);

/**
 * Classify a failure that happened BEFORE anything was signed (chain
 * unsupported, token/route resolution, insufficient balance). Used only for
 * `createAgentActivityPreBroadcastFailure` — a hashless, already-terminal
 * failure row. `failureReason` passes `redact()` here too (C25) — defense in
 * depth alongside the caller's own output-boundary redaction (this repo
 * value ALSO flows into `agent_activity.failure_reason`, which the repo
 * re-redacts unconditionally regardless of what a caller passes).
 */
export function classifyPreBroadcastFailure(err: unknown): UniswapRevertClassification {
  if (err instanceof VexError) {
    const mapped = PRE_BROADCAST_CODE_TABLE.get(err.code);
    if (mapped) return { failureCode: mapped, failureReason: redact(err.message).text };
  }
  return {
    failureCode: "unknown",
    failureReason: err instanceof Error ? redact(err.message).text : "unrecognized pre-broadcast error",
  };
}
