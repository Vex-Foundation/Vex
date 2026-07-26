/**
 * Uniswap revert/error → failure-code mapping (plan §8.2), captured from the
 * SIGN-time path only (never the broadcast/send stage — C29, see
 * `classifyUniswapRevertError`'s own doc — and never a mined receipt: a
 * mined-but-reverted receipt with no decoded reason is the repair sweep's
 * `mined_revert`, see `db/repos/agent-activity.ts`).
 *
 * The REVERT-STRING table itself no longer lives here (2026-07-25). It moved
 * to `evm-chains/router-revert-reason.ts` unchanged, because KyberSwap reverts
 * the very same "the price moved" condition with its own wording (`Return
 * amount is not enough`) and needed to read the same rows. A second table
 * would have drifted from this one. What stays here is what is genuinely
 * Uniswap's: the viem error-CLASS handling for this venue's sign path and the
 * pre-broadcast `VexError`-code mapping.
 *
 * `UniswapRevertFailureCode` is the shared `EvmRouterRevertFailureCode` under
 * this module's established name — a narrow, LOCAL subset of the closed
 * `AgentActivityFailureCode` enum, so a caller can assign this module's result
 * straight into a `FailActivityEventInput.failureCode` field with no cast, and
 * `src/tools/**` still never depends on `src/vex-agent/**`.
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

import {
  classifyRouterRevertReason,
  extractDecodedRevertReason,
  type EvmRouterRevertFailureCode,
} from "../evm-chains/router-revert-reason.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { redact } from "../../lib/diagnostics/text-redaction.js";

export type UniswapRevertFailureCode = EvmRouterRevertFailureCode;

export interface UniswapRevertClassification {
  readonly failureCode: UniswapRevertFailureCode;
  readonly failureReason: string;
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
    const mapped = classifyRouterRevertReason(reason);
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
