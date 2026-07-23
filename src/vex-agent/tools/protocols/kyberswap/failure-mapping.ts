/**
 * KyberSwap failure → Agent Scan mapping (plan §4.1/§11.2).
 *
 * Two independent classifications of the SAME caught error:
 *   - `mapKyberFailureToActivityCode` — the closed 11-member `agent_activity`
 *     `failure_code` enum (`db/repos/agent-activity.ts`), for recording.
 *   - `deriveKyberRevealFailure` — the coordinator-fixed reveal-eligible input
 *     shape (`tools/registry/uniswap-reveal-eligibility.ts`'s
 *     `KyberRevealFailure`), for deciding whether to reveal the hidden
 *     `swap_quote_uniswap`/`swap_execute_uniswap` pair.
 *
 * Neither re-derives `mapAggregatorError`'s VexError mapping
 * (`tools/kyberswap/aggregator/errors.ts`) — both read the ALREADY-MAPPED
 * VexError's `code` + the raw numeric Kyber code carried in `externalName`
 * (set by `withMeta` at the mapping site).
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import type { AgentActivityFailureCode } from "@vex-agent/db/repos/agent-activity.js";
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
        return "route_not_found";
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
