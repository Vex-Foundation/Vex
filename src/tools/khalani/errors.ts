import { VexError, ErrorCodes } from "../../errors.js";
import type { KhalaniErrorBody } from "./types.js";

/**
 * Attach the metadata the W1 error contract renders: retryability, the
 * provider's own exception name, and the HTTP status.
 *
 * `httpStatus` was computed at the call site and thrown away before W2d, so
 * `renderProtocolFailureOutput` could never print `HTTP 400` for a Khalani
 * failure and no caller could tell a definitive 4xx refusal from an ambiguous
 * 5xx. It is a bounded integer — never scrubbed, never provider prose.
 */
function withMeta(error: VexError, retryable: boolean, status: number, externalName?: string): VexError {
  error.retryable = retryable;
  error.httpStatus = status;
  if (externalName) error.externalName = externalName;
  return error;
}

/**
 * Khalani's `details[]` → the one clause that tells the agent WHICH field it
 * got wrong and why.
 *
 * The provider's own integration guide says to read this array to identify the
 * problematic fields, and we parsed it and then never read it: live, the API
 * said `fromToken: Must be a valid EVM, Solana, BTC, CKB, or Tron address` and
 * the agent was shown `khalani.quote.get failed: Validation failed.` — a
 * diagnosable failure rendered undiagnosable (owner decree 2026-08-02).
 *
 * Only STRING `field`/`message` members are lifted; anything else is provider
 * structure, not a sentence, and is left out rather than stringified. The whole
 * result still passes through the runtime's scrub + cap before the agent sees
 * it, so nothing here is a redaction boundary of its own.
 */
function describeErrorDetails(details: KhalaniErrorBody["details"]): string | null {
  if (!Array.isArray(details)) return null;
  const parts: string[] = [];
  for (const entry of details) {
    if (entry === null || typeof entry !== "object") continue;
    const field = typeof entry.field === "string" ? entry.field.trim() : "";
    const reason = typeof entry.message === "string" ? entry.message.trim() : "";
    if (reason.length === 0) continue;
    parts.push(field.length > 0 ? `${field}: ${reason}` : reason);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** The provider message with its `details[]` clause appended, when it has one. */
function composeMessage(body: KhalaniErrorBody | null, fallback: string): string {
  const base = body?.message?.trim() || fallback;
  const detail = describeErrorDetails(body?.details);
  return detail === null ? base : `${base} (${detail})`;
}

export function mapKhalaniError(status: number, body: KhalaniErrorBody | null): VexError {
  // A 404 with no exception NAME is the "resource does not exist" shape,
  // whether the body was absent (`readJson` → null) or the plain-text
  // `404 Not Found` the API also emits. A 404 that DOES name an exception
  // (e.g. `QuoteNotFoundException`) still falls through to the classifier.
  if (status === 404 && body?.name === undefined) {
    const detail = describeErrorDetails(body?.details);
    return withMeta(
      new VexError(
        ErrorCodes.KHALANI_ORDER_NOT_FOUND,
        detail === null ? "Khalani resource not found." : `Khalani resource not found (${detail}).`,
      ),
      false,
      status,
    );
  }
  if (status === 429) {
    return withMeta(
      new VexError(
        ErrorCodes.KHALANI_RATE_LIMITED,
        composeMessage(body, "Khalani rate limit exceeded."),
        "Retry with backoff."
      ),
      true,
      status,
    );
  }

  const message = composeMessage(body, `Khalani API error (HTTP ${status})`);
  const name = body?.name;

  switch (name) {
    case "ValidationException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_VALIDATION_ERROR, message, "Fix the request parameters and retry."),
        false, status, name,
      );
    case "CannotFillException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_CANNOT_FILL, message, "Try another route, token, chain, or amount."),
        false, status, name,
      );
    case "QuoteNotFoundException":
      return withMeta(
        new VexError(
          message.toLowerCase().includes("expired") ? ErrorCodes.KHALANI_QUOTE_EXPIRED : ErrorCodes.KHALANI_QUOTE_NOT_FOUND,
          message,
          "Re-request a quote before building the deposit plan."
        ),
        true, status, name,
      );
    case "NotSupportedTokenException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_UNSUPPORTED_TOKEN, message, "Search supported tokens first."),
        false, status, name,
      );
    case "NotSupportedChainException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, message, "Check the supported chain list first."),
        false, status, name,
      );
    case "BroadcastException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_BROADCAST_FAILED, message, "Check balances, nonce, or destination chain transaction freshness."),
        false, status, name,
      );
    case "DuplicateRecordException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Treat this as already registered and fetch the order state."),
        false, status, name,
      );
    case "BadRequestException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_VALIDATION_ERROR, message, "Check chain/transaction format, quote freshness, or request state."),
        false, status, name,
      );
    case "UnexpectedFromAddressException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_ADDRESS_MISMATCH, message, "Ensure the wallet address format matches the selected chain family."),
        false, status, name,
      );
    case "NotSupportedContractException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Choose another route or contact support."),
        false, status, name,
      );
    case "BuildDepositParsingException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Re-quote and retry."),
        false, status, name,
      );
    case "NotSupportedAssetReverseContractException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, message, "Choose another route or contact support."),
        false, status, name,
      );
    case "IntentNotFoundException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_QUOTE_NOT_FOUND, message, "Re-quote and re-initiate the flow."),
        false, status, name,
      );
    case "NotSupportedDepositMethodException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_UNSUPPORTED_DEPOSIT_METHOD, message, "Pass a different depositMethod, or omit the parameter to use the route default."),
        false, status, name,
      );
    case "InternalErrorException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Retry with backoff. The upstream service reported an internal error."),
        true, status, name,
      );
    default:
      if (status >= 500) {
        return withMeta(
          new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Retry with backoff. Khalani returned a server-side error."),
          true, status, name ?? undefined,
        );
      }
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message),
        false, status, name ?? undefined,
      );
  }
}
