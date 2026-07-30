/**
 * ONE classifier for engine/provider failures, two inputs, one user-facing
 * vocabulary.
 *
 * The SDK is asymmetric and the asymmetry is load-bearing: OpenRouter's
 * canonical `ApiErrorType` rides mid-STREAM error chunks, but a THROWN SDK
 * error never carries it — the throw path has only a class name and a numeric
 * status. The buffered (non-stream) path is worse still: `ChatResult` has no
 * error field at all, so class+status is the ONLY signal there. Both inputs
 * therefore converge here, on a single category set, so the renderer never has
 * to learn two vocabularies.
 *
 * OPEN ENUM, TOTAL LOOKUP. `ApiErrorType` is `OpenEnum<T> = T[keyof T] |
 * Unrecognized<string>` in the installed SDK: at runtime an unrecognized value
 * is a plain string, and a value outside the 27 known members is a LEGAL
 * provider response. A `switch` here could never be exhaustiveness-checked
 * (the union always contains branded `string`), so the mapping is a `Record`
 * lookup with a total default. Same for the status branch: OpenRouter's
 * `OpenRouterDefaultError` is the real catch-all for any 4XX/5XX outside the
 * 15 mapped classes, so the status branch is total over integers rather than a
 * fixed case list.
 *
 * This module is pure data + lookup and lives in `shared/` because all three
 * consumers need it: `main/ipc/chat.ts` (mapping a thrown failure to a
 * `VexError`), `main/agent/error-bridge.ts` (stamping the category on the push
 * event), and the renderer (turning a category into copy).
 */

/**
 * User-facing failure categories. Every input maps into exactly one of these,
 * and every one of them must produce a NON-GENERIC message in the UI —
 * `unknown` included, which still has to say something honest.
 */
export const ENGINE_ERROR_CATEGORIES = [
  /** Credit, key, or permission — the user must act on their account. */
  "account",
  /** Rate limit, overload, timeout, transport failure — retry later. */
  "capacity",
  /** Too much context / too many tokens — points at compaction, not failure. */
  "context",
  /** The model or provider refused on content-policy grounds. */
  "policy",
  /** The request itself was rejected as malformed or unsupported. */
  "request",
  /** An image attachment could not be used. */
  "media",
  /** The provider answered and we could not parse it. */
  "unreadable_response",
  /** Honest last resort — we know it failed, not why. */
  "unknown",
] as const;

export type EngineErrorCategory = (typeof ENGINE_ERROR_CATEGORIES)[number];

/**
 * `ApiErrorType` -> category. All 27 members of the installed SDK's enum
 * (v1.1.13) have a row; anything else is the open-enum escape and falls to the
 * total default in `classifyEngineFailure`.
 *
 * `Record<string, …>` rather than `Record<ApiErrorType, …>` on purpose: the
 * key space is open, so a total key type would be a lie and would also drag an
 * `@openrouter/sdk` type into the renderer's dependency graph.
 */
const CATEGORY_BY_ERROR_TYPE: Readonly<Record<string, EngineErrorCategory>> = {
  // account
  authentication: "account",
  permission_denied: "account",
  payment_required: "account",
  // capacity
  rate_limit_exceeded: "capacity",
  provider_overloaded: "capacity",
  provider_unavailable: "capacity",
  timeout: "capacity",
  server: "capacity",
  // context
  context_length_exceeded: "context",
  max_tokens_exceeded: "context",
  token_limit_exceeded: "context",
  payload_too_large: "context",
  string_too_long: "context",
  // policy
  content_policy_violation: "policy",
  refusal: "policy",
  // request
  invalid_request: "request",
  invalid_prompt: "request",
  not_found: "request",
  precondition_failed: "request",
  unprocessable: "request",
  // media
  invalid_image: "media",
  image_too_large: "media",
  image_too_small: "media",
  unsupported_image_format: "media",
  image_not_found: "media",
  image_download_failed: "media",
  // the SDK's own "we could not classify this" member
  unmapped: "unknown",
};

/**
 * SDK error class -> category, for the throw path. The 15 status-mapped
 * classes are here for directness, but the status branch would reach the same
 * answer for them; the rows that MATTER are the six status-less shapes
 * (`SDKValidationError` + the five `HTTPClientError` transports), which have
 * no other signal at all.
 *
 * `RequestAbortedError` maps to `capacity` as a transport-level cancellation.
 * A user-initiated stop never arrives here — that is a control transition, not
 * an error — so this row only covers an abort that escaped the runtime.
 */
const CATEGORY_BY_ERROR_CLASS: Readonly<Record<string, EngineErrorCategory>> = {
  // 15 status-mapped response errors
  BadRequestResponseError: "request",
  UnauthorizedResponseError: "account",
  PaymentRequiredResponseError: "account",
  ForbiddenResponseError: "account",
  NotFoundResponseError: "request",
  RequestTimeoutResponseError: "capacity",
  ConflictResponseError: "request",
  PayloadTooLargeResponseError: "context",
  UnprocessableEntityResponseError: "request",
  TooManyRequestsResponseError: "capacity",
  InternalServerResponseError: "capacity",
  BadGatewayResponseError: "capacity",
  ServiceUnavailableResponseError: "capacity",
  EdgeNetworkTimeoutResponseError: "capacity",
  ProviderOverloadedResponseError: "capacity",
  // validation — the provider answered, we could not read it
  ResponseValidationError: "unreadable_response",
  SDKValidationError: "unreadable_response",
  // status-less transports — name is the ONLY discriminator
  ConnectionError: "capacity",
  RequestTimeoutError: "capacity",
  RequestAbortedError: "capacity",
  UnexpectedClientError: "capacity",
  InvalidRequestError: "request",
  // base + catch-all carry no class-level information beyond their status;
  // deliberately absent so the status branch answers for them.
};

/**
 * Errno-shaped transport codes that mean "the network failed", i.e. retry
 * later. Verbatim copy of the mission runner's closed list
 * (`mission-error-classifier.ts` TRANSIENT_CAUSE_CODES) — duplicated rather
 * than imported because `@vex-agent` is the privileged trust surface
 * (rule 90) and the renderer must be able to import this module.
 */
const TRANSIENT_CAUSE_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Category from an HTTP status, TOTAL over integers. Any 4XX/5XX outside the
 * SDK's 15 mapped classes reaches us as `OpenRouterDefaultError` carrying only
 * a status, so "not in my list" must still produce a sensible answer rather
 * than falling through to `unknown`.
 */
function categoryFromStatus(statusCode: number): EngineErrorCategory {
  if (statusCode === 401 || statusCode === 402 || statusCode === 403) {
    return "account";
  }
  if (statusCode === 413) return "context";
  if (statusCode === 408 || statusCode === 429) return "capacity";
  if (statusCode >= 500 && statusCode <= 599) return "capacity";
  if (statusCode >= 400 && statusCode <= 499) return "request";
  return "unknown";
}

/** The bounded signals a failure can carry. Every field is optional by nature. */
export interface EngineFailureSignals {
  readonly errorType?: string | null;
  readonly errorClass?: string | null;
  readonly statusCode?: number | null;
  readonly causeCode?: string | null;
}

/**
 * Map bounded failure signals to exactly one user-facing category.
 *
 * PRECEDENCE, most specific first: the provider's own taxonomy (`errorType`)
 * beats the SDK class, which beats the raw status, which beats the transport
 * errno. A stream chunk that says `rate_limit_exceeded` is more trustworthy
 * than the 200 the SSE connection was opened with.
 *
 * Returns `"unknown"` when nothing is known — never throws, never widens.
 */
export function classifyEngineFailure(
  signals: EngineFailureSignals,
): EngineErrorCategory {
  const { errorType, errorClass, statusCode, causeCode } = signals;

  if (typeof errorType === "string") {
    // Total default: an unrecognized member is a legal open-enum value, so it
    // resolves to `unknown` rather than being treated as absent.
    return CATEGORY_BY_ERROR_TYPE[errorType] ?? "unknown";
  }

  if (typeof errorClass === "string") {
    const byClass = CATEGORY_BY_ERROR_CLASS[errorClass];
    if (byClass !== undefined) return byClass;
    // Known-but-uninformative class (`OpenRouterError` /
    // `OpenRouterDefaultError`) — fall through to the status branch.
  }

  if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
    return categoryFromStatus(statusCode);
  }

  if (typeof causeCode === "string" && TRANSIENT_CAUSE_CODES.has(causeCode)) {
    return "capacity";
  }

  return "unknown";
}
