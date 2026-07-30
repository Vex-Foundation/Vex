/**
 * Engine/provider failure -> user-facing `VexError` copy for `chat.submit`.
 *
 * WHY THIS IS A MODULE. This is the surface the owner complained about:
 * everything that was not a recognised HTTP status or one of nine errno values
 * collapsed to "Unable to process the message", so a provider 429 — the
 * failure actually hit in production, where a pinned endpoint turned a rate
 * limit into a hard wall — was indistinguishable from a bug. Making that
 * legible is a real responsibility with its own reason to change (copy,
 * categories, provider taxonomy), separate from the `chat.submit` handler's
 * job of validating a session and routing a turn.
 *
 * CLASSIFICATION IS NOT DONE HERE. It is delegated to the ONE shared
 * classifier (`shared/engine-error-classification.ts`), so this handler, the
 * push error channel and the renderer can never disagree about what a given
 * failure means. Only the COPY is decided here.
 *
 * NO NEW `VexErrorCode`. The existing codes are reused deliberately: minting
 * codes is an IPC contract change that needs owner sign-off. Categories that
 * have no perfect code (`context`, `policy`, `media`) map to
 * `validation.invalid_input` — defensible, since the request genuinely was
 * rejected as unusable — and carry the specific, actionable message.
 * `internal.unexpected` stays reserved for the honest last resort.
 */

import { assertNever, type VexError } from "@shared/ipc/result.js";
import {
  classifyEngineFailure,
  type EngineFailureSignals,
} from "@shared/engine-error-classification.js";

/** Session lookup failed. Not an engine failure, but the same copy surface. */
export function sessionNotFoundError(correlationId: string): VexError {
  return {
    code: "validation.invalid_input",
    domain: "chat",
    message: "Session not found.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function providerUnavailableError(correlationId: string): VexError {
  return {
    code: "provider.unavailable",
    domain: "chat",
    message: "No inference provider is available. Unlock Vex or complete provider setup, then retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

/**
 * Capacity / transient family. `retryAfterSeconds` comes from the provider's
 * own `Retry-After` header, bounded to a small integer at the inference
 * boundary — the difference between "rate-limited" and "rate-limited, retry in
 * 41s" is the whole reason it is plumbed through.
 */
function providerTransientError(
  correlationId: string,
  retryAfterSeconds: number | null,
): VexError {
  const message =
    retryAfterSeconds === null
      ? "The inference provider is temporarily unavailable. Try again shortly."
      : `The inference provider is rate-limited or overloaded. Try again in ${retryAfterSeconds}s.`;
  return {
    code: "provider.unavailable",
    domain: "chat",
    message,
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

/**
 * Context family — points at compaction, an action the user can actually take,
 * instead of at a generic failure.
 */
function contextTooLargeError(correlationId: string): VexError {
  return {
    code: "validation.invalid_input",
    domain: "chat",
    message:
      "This conversation is too long for the selected model. Compact the session or start a new one, then retry.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function contentRefusedError(correlationId: string): VexError {
  return {
    code: "validation.invalid_input",
    domain: "chat",
    message:
      "The provider refused this request on content-policy grounds. Rephrase and retry.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function requestRejectedError(correlationId: string): VexError {
  return {
    code: "validation.invalid_input",
    domain: "chat",
    message:
      "The provider rejected this request. Check the selected model in provider setup and retry.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function imageRejectedError(correlationId: string): VexError {
  return {
    code: "validation.invalid_input",
    domain: "chat",
    message:
      "An attached image could not be used by the provider. Remove or replace it and retry.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

/**
 * The provider answered and the SDK could not parse it
 * (`SDKValidationError` / `ResponseValidationError`). Retryable: a malformed
 * response is usually a transient upstream glitch, not a request the user got
 * wrong.
 */
function unreadableProviderResponseError(correlationId: string): VexError {
  return {
    code: "provider.unavailable",
    domain: "chat",
    message: "The provider's response could not be read. Try again shortly.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function invalidApiKeyError(correlationId: string): VexError {
  return {
    code: "provider.invalid_api_key",
    domain: "chat",
    message: "The inference provider rejected the API key. Verify it in provider setup and retry.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function insufficientCreditsError(correlationId: string): VexError {
  return {
    code: "provider.insufficient_credits",
    domain: "chat",
    message: "The inference provider account has insufficient credits. Add funds and retry.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function chatFailedError(correlationId: string): VexError {
  return {
    code: "internal.unexpected",
    domain: "chat",
    message: "Unable to process the message.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  };
}

/**
 * Local own-property reader — the same "own-properties only, never `.cause`"
 * idiom as `mission-error-signal.ts` / `engine/types.ts`, duplicated here (not
 * imported) because `@vex-agent` is the privileged trust surface (rule 90) and
 * a ~20-line reader does not justify widening it to reach one module.
 *
 * Reads the lean signals `MissionRunPausedError` propagates from its cause
 * (`statusCode`, `causeCode`, `errorType`, `errorClass`) plus raw `status` for
 * a non-wrapped error. Covering both shapes is deliberate: whether an
 * agent-mode chat throw arrives wrapped or raw was an open question, and
 * reading the same own-property names off either answers it without depending
 * on which one it is.
 */
function chatErrorSignal(cause: unknown): EngineFailureSignals {
  if (typeof cause !== "object" || cause === null) {
    return { statusCode: null, causeCode: null, errorType: null, errorClass: null };
  }
  const rec = cause as Record<string, unknown>;
  // Own-property reads only — ordinary indexing would also resolve inherited
  // prototype properties (e.g. `Error.prototype.name`), letting a caller
  // "read" a signal that was never actually attached to this value.
  const ownField = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined;
  const rawStatus = ownField("statusCode") ?? ownField("status");
  const statusCode =
    typeof rawStatus === "number" && Number.isFinite(rawStatus) ? rawStatus : null;
  const rawCauseCode = ownField("causeCode");
  const causeCode = typeof rawCauseCode === "string" ? rawCauseCode : null;
  const rawErrorType = ownField("errorType");
  const errorType = typeof rawErrorType === "string" ? rawErrorType : null;
  const rawErrorClass = ownField("errorClass");
  const errorClass = typeof rawErrorClass === "string" ? rawErrorClass : null;
  return { statusCode, causeCode, errorType, errorClass };
}

/** Bounded retry hint, read the same own-property-only way. */
function chatRetryAfterSeconds(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const rec = cause as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rec, "retryAfterSeconds")) return null;
  const v = rec.retryAfterSeconds;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * "Out of credit" vs "bad key", within the `account` category — the one
 * category where the user's next action differs and the category alone does
 * not separate them.
 */
function isCreditExhaustion(signal: EngineFailureSignals): boolean {
  return (
    signal.errorType === "payment_required" ||
    signal.statusCode === 402 ||
    signal.errorClass === "PaymentRequiredResponseError"
  );
}

/**
 * Map a thrown engine failure to the user-facing `VexError`. Total over the
 * category set; `assertNever` makes a new category a compile error here rather
 * than a silent fall-through to "Unable to process the message".
 */
export function classifyEngineError(cause: unknown, correlationId: string): VexError {
  if (
    cause instanceof Error &&
    (cause.message === "No inference provider available" ||
      cause.message === "No inference config available")
  ) {
    return providerUnavailableError(correlationId);
  }

  const signal = chatErrorSignal(cause);
  const category = classifyEngineFailure(signal);

  switch (category) {
    case "account":
      return isCreditExhaustion(signal)
        ? insufficientCreditsError(correlationId)
        : invalidApiKeyError(correlationId);
    case "capacity":
      return providerTransientError(correlationId, chatRetryAfterSeconds(cause));
    case "context":
      return contextTooLargeError(correlationId);
    case "policy":
      return contentRefusedError(correlationId);
    case "request":
      return requestRejectedError(correlationId);
    case "media":
      return imageRejectedError(correlationId);
    case "unreadable_response":
      return unreadableProviderResponseError(correlationId);
    case "unknown":
      return chatFailedError(correlationId);
    default:
      return assertNever(category);
  }
}
