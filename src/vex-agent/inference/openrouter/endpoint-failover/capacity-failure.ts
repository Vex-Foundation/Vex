/**
 * Is this failure a CAPACITY failure, and can switching endpoints help?
 *
 * Two separate questions, and conflating them is the expensive mistake:
 *
 * - "capacity" decides whether we RETRY at all. Everything else — 400, 401,
 *   402, 403, 404, 413, 422, `context_length_exceeded`, content policy — is a
 *   property of the REQUEST or the ACCOUNT and follows us to every endpoint, so
 *   it must keep failing on attempt one exactly as today.
 * - "switchable" decides whether the retry may target a DIFFERENT endpoint.
 *
 * LIVE EVIDENCE (probe `provider-429-layer`, 2026-07-29 — sanitized shape in
 * `agents_dm/runtime-harness/fixtures/openrouter-429-shape.json`, reproduced
 * across two independent runs): a real 429 from `deepinfra/fp4` carried
 * `error.metadata.limit_source = "upstream_provider_shared_pool"` and
 * `provider_error_code = "engine_overloaded"`, and `baidu/fp8` served the
 * identical request successfully in the same minute. So the 429 was
 * ENDPOINT-level and switching is the right remedy. The same run also showed
 * `errorClass = TooManyRequestsResponseError` with `metadata.errorType`
 * ABSENT — the status/class branch is the only path at 429 — and NO
 * `Retry-After` header at all, which is why {@link CapacityFailure} carries a
 * nullable hint and the backoff has its own floor (see `retry-policy.ts`).
 *
 * `limit_source` is what keeps a shared-pool overload apart from an
 * account/key/credit limit. An account limit is applied to US, not to the
 * endpoint: retrying elsewhere cannot succeed and would burn one attempt per
 * endpoint on every turn. Such a failure stays retryable (a quota window can
 * reopen) but is NOT switchable.
 *
 * Reads only the LEAN own-properties `normalizeOpenRouterError` attaches
 * (`statusCode`, `errorClass`, `errorType`, `limitSource`,
 * `providerErrorCode`, `retryAfterSeconds`) — never the raw SDK error, whose
 * body/headers/metadata this codebase deliberately destroys.
 */

/** Bounded reason codes. Persisted to `session_endpoint_switches.reason_class`. */
export type CapacityFailureClass =
  /** 429 whose limit was applied at the upstream endpoint's shared pool. */
  | "rate_limited_shared_pool"
  /** 429 whose limit was applied to our account/key/credits — never switchable. */
  | "rate_limited_account"
  /** Provider explicitly reported itself overloaded (503 / ProviderOverloaded). */
  | "provider_overloaded"
  /** Provider unreachable through the router (502). */
  | "provider_unavailable"
  /** Any other upstream 5xx, including edge/gateway timeouts. */
  | "upstream_server_error";

export interface CapacityFailure {
  readonly reasonClass: CapacityFailureClass;
  /** False ⇒ retry on the SAME endpoint only; a switch cannot help. */
  readonly switchable: boolean;
  /** Provider's own wait hint in whole seconds, or `null` when it sent none. */
  readonly retryAfterSeconds: number | null;
}

/**
 * Statuses that are decidedly NOT capacity, listed explicitly rather than
 * inferred from a `< 500` test: the point of the list is that a future reader
 * sees exactly which failures must never be retried or re-routed.
 */
const NON_CAPACITY_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 402, 403, 404, 405, 408, 409, 413, 422,
]);

/**
 * SDK error classes that mean "upstream had no capacity", independent of the
 * status we could read. `ProviderOverloadedResponseError` is the router's own
 * signal for it.
 */
const OVERLOAD_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "ProviderOverloadedResponseError",
]);

/**
 * `limit_source` substrings that mean the limit was applied to US. Substring
 * matching, not equality: the vocabulary is undocumented and provider-owned, so
 * a new member like `account_daily_quota` must land on the safe side without a
 * code change. Checked BEFORE the shared-pool reading, since
 * `upstream_provider_shared_pool` also contains "provider".
 */
const ACCOUNT_LIMIT_MARKERS: ReadonlyArray<string> = [
  "account",
  "api_key",
  "apikey",
  "key_",
  "credit",
  "quota",
  "organi",
  "byok",
  "user",
];

function ownProperty(err: unknown, key: string): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  return Object.prototype.hasOwnProperty.call(err, key)
    ? (err as Record<string, unknown>)[key]
    : undefined;
}

function ownNumber(err: unknown, key: string): number | null {
  const value = ownProperty(err, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ownString(err: unknown, key: string): string | null {
  const value = ownProperty(err, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Classify a 429's `limit_source`. Absent or unrecognized ⇒ shared-pool, i.e.
 * SWITCHABLE. That default is deliberate and matches owner decision 8 ("429
 * switches"): before this field was carried, every 429 was treated as an
 * endpoint capacity failure, and the live probe showed the endpoint-level
 * reading is the common one. The account reading is the narrow, explicitly
 * marked case.
 */
function isAccountLimit(limitSource: string | null): boolean {
  if (limitSource === null) return false;
  const token = limitSource.toLowerCase();
  return ACCOUNT_LIMIT_MARKERS.some((marker) => token.includes(marker));
}

/**
 * Returns the capacity classification, or `null` when the failure is not a
 * capacity failure and must propagate immediately.
 */
export function classifyCapacityFailure(err: unknown): CapacityFailure | null {
  const status = ownNumber(err, "statusCode") ?? ownNumber(err, "status");
  const errorClass = ownString(err, "errorClass");
  const retryAfterSeconds = ownNumber(err, "retryAfterSeconds");

  if (status !== null && NON_CAPACITY_STATUSES.has(status)) return null;

  if (status === 429) {
    const account = isAccountLimit(ownString(err, "limitSource"));
    return {
      reasonClass: account ? "rate_limited_account" : "rate_limited_shared_pool",
      switchable: !account,
      retryAfterSeconds,
    };
  }

  if (errorClass !== null && OVERLOAD_ERROR_CLASSES.has(errorClass)) {
    return { reasonClass: "provider_overloaded", switchable: true, retryAfterSeconds };
  }

  if (status === 503) {
    return { reasonClass: "provider_overloaded", switchable: true, retryAfterSeconds };
  }
  if (status === 502) {
    return { reasonClass: "provider_unavailable", switchable: true, retryAfterSeconds };
  }
  if (status !== null && status >= 500 && status <= 599) {
    return { reasonClass: "upstream_server_error", switchable: true, retryAfterSeconds };
  }

  // No status at all: transport/validation shapes (`ConnectionError`,
  // `SDKValidationError`, …). Not capacity — they fail immediately, exactly as
  // before this package existed.
  return null;
}
