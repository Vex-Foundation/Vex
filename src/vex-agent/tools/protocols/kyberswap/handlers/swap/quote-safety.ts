/**
 * Read-only token safety surfacing for kyberswap.swap.quote (Stage 6b).
 *
 * The quote is informational: it surfaces honeypot / fee-on-transfer risk so
 * the agent can see EVM token danger at quote time. It NEVER aborts - gating
 * stays in kyberswap.swap.execute. Each leg is one of:
 *  - { native: true }                   native sentinel - no honeypot concept
 *  - { isHoneypot, isFOT, tax }          live token API audit
 *  - { checkFailed: true, reason }       fail-soft: bounded reason class only
 */

import { getKyberTokenApiClient } from "@tools/kyberswap/token-api/client.js";
import logger from "@utils/logger.js";
import { isRecord } from "@utils/validation-helpers.js";
import { VexError, ErrorCodes } from "../../../../../../errors.js";
import type { Address } from "viem";

/**
 * Bounded failure class for a swallowed honeypot/FoT check.
 *
 * NEVER carries raw provider/HTTP text. It is derived defensively from the
 * caught value's VexError code / numeric status / message keywords so neither
 * the log payload nor the quote output can leak URLs, HTML, API keys, or status
 * bodies.
 */
export type SafetyCheckFailureReason = "timeout" | "rate_limited" | "kyber_error" | "unavailable";

export type QuoteSafetyLeg =
  | { readonly native: true }
  | { readonly isHoneypot: boolean; readonly isFOT: boolean; readonly tax: number }
  | { readonly checkFailed: true; readonly reason: SafetyCheckFailureReason };

export interface QuoteSafety {
  readonly tokenIn: QuoteSafetyLeg;
  readonly tokenOut: QuoteSafetyLeg;
}

/**
 * Classify a caught (untrusted) value into a bounded failure reason.
 *
 * Defensive: treats the value as `unknown`, inspects only a VexError `code`, a
 * numeric `status`, and lowercased keyword matches on a string `message`. The
 * raw message text is NEVER returned or logged - only one of the four bounded
 * literals leaves this function.
 */
export function classifySafetyCheckFailure(err: unknown): SafetyCheckFailureReason {
  const code = err instanceof VexError ? err.code : undefined;
  if (code === ErrorCodes.KYBER_TIMEOUT || code === ErrorCodes.HTTP_TIMEOUT) return "timeout";
  if (code === ErrorCodes.KYBER_RATE_LIMITED) return "rate_limited";
  if (typeof code === "string" && code.startsWith("KYBER_")) return "kyber_error";

  const record = isRecord(err) ? err : undefined;
  const status = record && typeof record.status === "number" ? record.status : undefined;
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";

  const message = record && typeof record.message === "string" ? record.message.toLowerCase() : "";
  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limited";
  }
  if (message.includes("timeout") || message.includes("timed out") || message.includes("etimedout") || message.includes("abort")) {
    return "timeout";
  }
  return "unavailable";
}

/**
 * Resolve the read-only safety leg for a single resolved token.
 *
 * Native tokens have no honeypot concept and are marked, not checked.
 * Any failure of the (untrusted, network) honeypot check is swallowed into a
 * bounded `{ checkFailed: true, reason }` marker - raw provider/HTTP text
 * (URLs, HTML, keys, status bodies) is never propagated into the log payload
 * or the quote output.
 */
export async function resolveQuoteSafetyLeg(
  chainId: number,
  token: { readonly address: Address; readonly isNative: boolean },
): Promise<QuoteSafetyLeg> {
  if (token.isNative) return { native: true };
  try {
    const info = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, token.address);
    return { isHoneypot: info.isHoneypot, isFOT: info.isFOT, tax: info.tax };
  } catch (err) {
    // Read-only fail-soft: log only a bounded class (no raw provider/HTTP text).
    const reason = classifySafetyCheckFailure(err);
    logger.warn("kyberswap.swap.quote.safety_check_failed", {
      chainId,
      address: token.address,
      reason,
    });
    return { checkFailed: true, reason };
  }
}
