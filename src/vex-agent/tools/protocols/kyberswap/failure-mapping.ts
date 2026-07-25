/**
 * KyberSwap failure → Agent Scan mapping (plan §4.1/§11.2; REVISION 1 —
 * reveal-on-execute-revert design).
 *
 * Three classifications, the first two of the SAME caught (pre-broadcast)
 * error, the third of a MINED on-chain outcome (never a caught error):
 *   - `mapKyberFailureToActivityCode` — the closed 11-member `agent_activity`
 *     `failure_code` enum (`db/repos/agent-activity.ts`), for recording.
 *   - `deriveKyberRevealFailure` — the coordinator-fixed reveal-eligible input
 *     shape (`tools/registry/uniswap-reveal-eligibility.ts`'s
 *     `KyberRevealFailure`), for deciding whether to reveal the hidden
 *     `swap_quote_uniswap`/`swap_execute_uniswap` pair from a caught
 *     PRE-BROADCAST VexError.
 *   - `deriveKyberMinedRevertRevealFailure` — the same reveal-eligible input
 *     shape, but derived from the staged broadcast loop's `outcome.kind ===
 *     "reverted"` (a MINED revert has no caught error to read). Role-scoped
 *     (REVISION 1 R1): produces the signal ONLY for the `swap` leg role.
 *
 * Neither of the first two re-derives `mapAggregatorError`'s VexError mapping
 * (`tools/kyberswap/aggregator/errors.ts`) — both read the ALREADY-MAPPED
 * VexError's `code` + the raw numeric Kyber code carried in `externalName`
 * (set by `withMeta` at the mapping site).
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import type { AgentActivityFailureCode, AgentActivityEventRole } from "@vex-agent/db/repos/agent-activity.js";
import type { KyberRevealFailure } from "../../registry/uniswap-reveal-eligibility.js";

/** The raw numeric Kyber error code, when the caught error carries one (`mapAggregatorError`'s `externalName`). */
function rawKyberCode(err: unknown): number | undefined {
  if (!(err instanceof VexError) || err.externalName === undefined) return undefined;
  const parsed = Number(err.externalName);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Map a caught error from the quote/build/allowance-read path to the closed
 * `agent_activity.failure_code` enum. Never throws — an unrecognized error
 * shape maps to `"unknown"`, the enum's catch-all.
 */
export function mapKyberFailureToActivityCode(err: unknown): AgentActivityFailureCode {
  if (err instanceof VexError) {
    switch (err.code) {
      case ErrorCodes.KYBER_UNSUPPORTED_CHAIN:
        return "chain_unsupported";
      case ErrorCodes.KYBER_ROUTE_NOT_FOUND:
      case ErrorCodes.KYBER_TOKEN_NOT_FOUND:
      // A built swap that diverges from the approved transaction in a
      // NON-price way (wrong target/spender/fee line/flags/native value).
      // Mirrors `solana.swap.execute`, which records its fee-policy
      // divergence abort as `route_not_found` rather than inventing a code:
      // the route we were handed is not the route we approved.
      case ErrorCodes.KYBER_UNSAFE_BUILD:
        return "route_not_found";
      // The built calldata's own `minReturnAmount` sits below the floor the
      // FRESH route implies at the caller's own `slippageBps` — the build
      // widened the tolerance we asked for. A genuine slippage abort, never
      // the generic build-rejection bucket. It is NOT a "the price moved"
      // refusal: that comparison was removed (see `swap-price-floor.ts`).
      case ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED:
        return "slippage";
      case ErrorCodes.KYBER_AMOUNT_TOO_LARGE:
      case ErrorCodes.KYBER_FEE_EXCEEDS_AMOUNT:
        return "insufficient_liquidity";
      case ErrorCodes.INSUFFICIENT_BALANCE:
        return "allowance_or_balance";
      case ErrorCodes.APPROVAL_FAILED:
        return "allowance_or_balance";
      default:
        return "unknown";
    }
  }
  return "unknown";
}

/**
 * Derive the `isRevealEligibleKyberFailure` input from a caught error, or
 * `null` when the error is not a Kyber-route-class failure at all (e.g. a
 * wallet-resolution error) — callers must treat `null` as "not eligible"
 * without needing a second branch.
 *
 * `tokenInputsValidated` must be supplied by the caller (true only once BOTH
 * tokens passed address/native validation + on-chain metadata resolution
 * BEFORE the Kyber call) — this module never guesses it.
 */
export function deriveKyberRevealFailure(
  err: unknown,
  tokenInputsValidated: boolean,
): KyberRevealFailure | null {
  if (!(err instanceof VexError)) return null;
  if (err.code === ErrorCodes.KYBER_UNSUPPORTED_CHAIN) {
    return { kind: "chain_unsupported" };
  }
  const code = rawKyberCode(err);
  if (code === undefined) return null;
  return { kind: "kyber_code", code, tokenInputsValidated };
}

/**
 * Derive the `swap_mined_revert` reveal signal for a MINED on-chain revert of
 * the staged broadcast loop (`outcome.kind === "reverted"` in
 * `kyberswap.swap.execute`) — a structurally different signal from
 * `deriveKyberRevealFailure` above (which reads a caught PRE-BROADCAST
 * VexError; a mined revert is a `StagedBroadcastOutcome`, never thrown).
 *
 * Produced ONLY for the `swap` leg role (REVISION 1 R1 — the shared-branch
 * bug): an `allowance`/`allowance_reset` leg reverting is an ERC-20 approve
 * failure, categorically unrelated to route/venue selection, and must NEVER
 * reveal. The role is encoded in this function's input (coordinator-fixed),
 * not left to an informal caller check at the call site.
 */
export function deriveKyberMinedRevertRevealFailure(
  eventRole: AgentActivityEventRole,
): KyberRevealFailure | null {
  return eventRole === "swap" ? { kind: "swap_mined_revert" } : null;
}
