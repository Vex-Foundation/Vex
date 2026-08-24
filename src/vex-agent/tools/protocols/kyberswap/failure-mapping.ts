/**
 * KyberSwap failure → Agent Scan mapping (plan §4.1/§11.2; REVISION 1 —
 * reveal-on-execute-revert design).
 *
 * Four classifications: the first two of the SAME caught (pre-broadcast)
 * error, the third of a MINED on-chain outcome (never a caught error), the
 * fourth of an ALREADY-CLASSIFIED pre-sign estimate revert:
 *   - `mapKyberFailureToActivityCode` — the closed 11-member `agent_activity`
 *     `failure_code` enum (`db/repos/agent-activity.ts`), for recording.
 *   - `deriveKyberFallbackSignal` — the coordinator-fixed fallback-eligible input
 *     shape (`tools/registry/venue-fallback-eligibility.ts`'s
 *     `KyberFallbackSignal`), for deciding whether to point the agent at the
 *     `SwapQuoteUniswap`/`SwapExecuteUniswap` venue from a caught
 *     PRE-BROADCAST VexError.
 *   - `deriveKyberMinedRevertFallbackSignal` — the same fallback-eligible input
 *     shape, but derived from the staged broadcast loop's `outcome.kind ===
 *     "reverted"` (a MINED revert has no caught error to read). Role-scoped
 *     (REVISION 1 R1): produces the signal ONLY for the `swap` leg role.
 *   - `deriveKyberPreSignRevertFallbackSignal` — the same fallback-eligible input
 *     shape for a PRE-SIGN `eth_estimateGas` revert already classified by
 *     `evm-chains/pre-sign-revert-refusal.ts`. Role-scoped like the mined
 *     revert, and additionally gated on nothing having been broadcast.
 *
 * Neither of the first two re-derives `mapAggregatorError`'s VexError mapping
 * (`tools/kyberswap/aggregator/errors.ts`) — both read the ALREADY-MAPPED
 * VexError's `code` + the raw numeric Kyber code carried in `externalName`
 * (set by `withMeta` at the mapping site). `deriveKyberFallbackSignal` now also
 * reads `httpStatus`, because the status is the one field the error contract
 * classifies on before it reads any prose.
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import type { AgentActivityFailureCode, AgentActivityEventRole } from "@vex-agent/db/repos/agent-activity.js";
import type { EvmRouterRevertFailureCode } from "@tools/evm-chains/router-revert-reason.js";
import type { KyberFallbackSignal, KyberVenueUnavailableReason } from "../../registry/venue-fallback-eligibility.js";

/** The raw numeric Kyber error code, when the caught error carries one (`mapAggregatorError`'s `externalName`). */
function rawKyberCode(err: unknown): number | undefined {
  if (!(err instanceof VexError) || err.externalName === undefined) return undefined;
  const parsed = Number(err.externalName);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * KyberSwap HTTP statuses that mean THE VENUE COULD NOT SERVE US, mapped to the
 * closed reason vocabulary the reveal classifier decides on.
 *
 * Closed by construction: a status not named here is not an availability
 * failure and derivation falls through to the Kyber-code path. 400 is
 * deliberately absent (a malformed request is OUR parameter, not the venue's
 * availability), and so is every other unlisted 4xx. 451 is listed because it
 * is the status an edge returns when it blocks a whole region, which is the
 * exact scenario this class exists for.
 */
function unavailableReasonForStatus(status: number): KyberVenueUnavailableReason | null {
  if (status === 401 || status === 403 || status === 451) return "edge_refused";
  if (status === 404) return "endpoint_missing";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  return null;
}

/**
 * The availability class: the venue could not serve us at all, so no fresh
 * quote and no corrected amount can clear it and a SECOND VENUE is the only
 * remedy Vex has.
 *
 * Read from the VexError CODE first and the HTTP status second, never from
 * message text. The code gate is what keeps the class closed: whenever the
 * response body carried a KyberSwap code, `mapAggregatorError` has already
 * produced a SEMANTIC error (route-not-found, malformed-params, ...), so only
 * the codes below can mean "no usable verdict came back at all".
 *
 * `KYBER_API_ERROR` with NO `httpStatus` is deliberately NOT in the class: that
 * is also the shape of `verifyRouterAddress`'s build-integrity abort and of the
 * response-schema validators, neither of which is evidence about availability.
 * `KYBER_UNREACHABLE` exists precisely so the genuine transport case does not
 * have to be identified by that ambiguous absence.
 */
function deriveVenueUnavailable(err: VexError): KyberFallbackSignal | null {
  if (err.code === ErrorCodes.KYBER_UNREACHABLE) return { kind: "venue_unavailable", reason: "unreachable" };
  if (err.code === ErrorCodes.KYBER_TIMEOUT) return { kind: "venue_unavailable", reason: "timeout" };
  if (err.code === ErrorCodes.KYBER_RATE_LIMITED) return { kind: "venue_unavailable", reason: "rate_limited" };
  if (err.code !== ErrorCodes.KYBER_API_ERROR || err.httpStatus === undefined) return null;
  const reason = unavailableReasonForStatus(err.httpStatus);
  return reason === null ? null : { kind: "venue_unavailable", reason };
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
      // Migration 076. Reuses the SAME derivation the reveal path decides on,
      // so the recorded code and the reveal verdict cannot drift apart. It
      // sits in the default arm because the availability class turns on
      // `httpStatus` as well as `code`, which a case label cannot express;
      // a `KYBER_API_ERROR` with no status still records `unknown`.
      default:
        return deriveVenueUnavailable(err) ? "venue_unavailable" : "unknown";
    }
  }
  return "unknown";
}

/**
 * Derive the `isVenueFallbackWorthwhile` input from a caught error, or
 * `null` when the error is not a Kyber-route-class failure at all (e.g. a
 * wallet-resolution error) — callers must treat `null` as "not eligible"
 * without needing a second branch.
 *
 * `tokenInputsValidated` must be supplied by the caller (true only once BOTH
 * tokens passed address/native validation + on-chain metadata resolution
 * BEFORE the Kyber call) — this module never guesses it. It does not gate the
 * locally-derived kinds, which can only be reached after both tokens resolved.
 */
export function deriveKyberFallbackSignal(
  err: unknown,
  tokenInputsValidated: boolean,
): KyberFallbackSignal | null {
  if (!(err instanceof VexError)) return null;
  if (err.code === ErrorCodes.KYBER_UNSUPPORTED_CHAIN) {
    return { kind: "chain_unsupported" };
  }
  // The pre-sign calldata guard's refusal is thrown LOCALLY, so it carries no
  // `externalName` and the numeric-code path below can never see it. Without
  // this branch a build refusal left the agent with no venue at all: the one
  // fallback that could serve the trade stayed locked while the advice to
  // re-quote returned the same build shape.
  if (err.code === ErrorCodes.KYBER_UNSAFE_BUILD) {
    return { kind: "unsafe_build" };
  }
  // BEFORE the numeric-code path. `mapAggregatorError` used to stamp the HTTP
  // STATUS into `externalName`, which put 403 into the KyberSwap code namespace
  // and made a geo-block read as an unknown provider code. That stamping is
  // gone at the source; this ordering is the second guard, so an availability
  // verdict can never be re-read as a Kyber body code.
  const unavailable = deriveVenueUnavailable(err);
  if (unavailable) return unavailable;
  const code = rawKyberCode(err);
  if (code === undefined) return null;
  return { kind: "kyber_code", code, tokenInputsValidated };
}

/**
 * Derive the `swap_mined_revert` reveal signal for a MINED on-chain revert of
 * the staged broadcast loop (`outcome.kind === "reverted"` in
 * `kyberswap.swap.execute`) — a structurally different signal from
 * `deriveKyberFallbackSignal` above (which reads a caught PRE-BROADCAST
 * VexError; a mined revert is a `StagedBroadcastOutcome`, never thrown).
 *
 * Produced ONLY for the `swap` leg role (REVISION 1 R1 — the shared-branch
 * bug): an `allowance`/`allowance_reset` leg reverting is an ERC-20 approve
 * failure, categorically unrelated to route/venue selection, and must NEVER
 * reveal. The role is encoded in this function's input (coordinator-fixed),
 * not left to an informal caller check at the call site.
 */
export function deriveKyberMinedRevertFallbackSignal(
  eventRole: AgentActivityEventRole,
): KyberFallbackSignal | null {
  return eventRole === "swap" ? { kind: "swap_mined_revert" } : null;
}

/**
 * Derive the `pre_sign_revert` reveal signal for a leg the chain refused at
 * the PRE-SIGN `eth_estimateGas` — the third structurally distinct source, and
 * the only one where nothing of ours ever reached the network.
 *
 * Both gates are encoded here (coordinator-fixed), not left to an informal
 * call-site check, and both mirror the mined-revert path's own rules:
 *   - `eventRole` must be `swap` (R1). An `allowance`/`allowance_reset` leg
 *     refused is an ERC-20 approve condition, categorically unrelated to
 *     route/venue selection.
 *   - `legBroadcastAttempted` must be false. Once this leg's hash was staged,
 *     bytes went to the wire and the refusal is no longer a pre-sign one — the
 *     same discriminator the refusal wording itself turns on.
 * Which failure codes such a refusal may reveal on is the classifier's own
 * closed set (`venue-fallback-eligibility.ts`); this function does not filter
 * it, so the two decisions cannot drift apart in only one of them.
 */
export function deriveKyberPreSignRevertFallbackSignal(input: {
  readonly eventRole: AgentActivityEventRole;
  readonly legBroadcastAttempted: boolean;
  readonly failureCode: EvmRouterRevertFailureCode;
}): KyberFallbackSignal | null {
  if (input.eventRole !== "swap") return null;
  if (input.legBroadcastAttempted) return null;
  return { kind: "pre_sign_revert", failureCode: input.failureCode };
}
