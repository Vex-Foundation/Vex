/**
 * Bounding for the SDK error CLASS identity of a thrown OpenRouter error.
 *
 * WHY THIS EXISTS. `normalizeOpenRouterError` deliberately rebuilds a plain
 * `Error` so nothing can walk back to the raw body / headers / `userId`. That
 * also destroys the only discriminator the SDK gives for six of its error
 * shapes: `SDKValidationError` and the five `HTTPClientError` transports carry
 * NO HTTP status, so after normalization they are indistinguishable from each
 * other and from "we have no idea". Capturing the class name BEFORE the
 * rebuild is what lets the error channel tell a user "we could not read the
 * provider's answer" apart from "we could not reach the provider at all".
 *
 * CLOSED dictionary, unlike `ApiErrorType`. Class names are OUR compile-time
 * dependency (the installed `@openrouter/sdk`), not a provider-controlled
 * response field: an unrecognized value means the SDK changed under us, not
 * that a provider sent something new. So an unknown name is rejected (`null`)
 * rather than carried verbatim — which keeps this value safe to put on the
 * IPC boundary as a bounded code with a fixed vocabulary the renderer can map
 * to copy.
 *
 * The dictionary below is the complete set of concrete classes exported by
 * `@openrouter/sdk/esm/models/errors/index.d.ts` (v1.1.13), minus the abstract
 * `HTTPClientError` base. Each class sets `this.name` explicitly at runtime,
 * so `err.name` is the reliable read (`constructor.name` would not survive
 * minification).
 */

/**
 * Closed set of SDK error class names. 15 status-mapped response errors, the
 * base + default fallback, 2 validation errors, and 5 status-less transports.
 */
export const OPENROUTER_ERROR_CLASSES: ReadonlySet<string> = new Set([
  // 15 status-mapped response errors
  "BadRequestResponseError",
  "UnauthorizedResponseError",
  "PaymentRequiredResponseError",
  "ForbiddenResponseError",
  "NotFoundResponseError",
  "RequestTimeoutResponseError",
  "ConflictResponseError",
  "PayloadTooLargeResponseError",
  "UnprocessableEntityResponseError",
  "TooManyRequestsResponseError",
  "InternalServerResponseError",
  "BadGatewayResponseError",
  "ServiceUnavailableResponseError",
  "EdgeNetworkTimeoutResponseError",
  "ProviderOverloadedResponseError",
  // base + the real catch-all for any other 4XX/5XX
  "OpenRouterError",
  "OpenRouterDefaultError",
  // validation — "the provider answered, we could not read it"
  "ResponseValidationError",
  "SDKValidationError",
  // transport — status-less, distinguished ONLY by name
  "UnexpectedClientError",
  "InvalidRequestError",
  "RequestAbortedError",
  "RequestTimeoutError",
  "ConnectionError",
]);

/**
 * Read the SDK error class name off a thrown value, admitting ONLY members of
 * the closed dictionary. Returns `null` for a non-Error, a missing/non-string
 * `name`, or any name outside the dictionary (including plain `"Error"`, which
 * is what an already-normalized error carries and says nothing).
 */
export function boundedErrorClass(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const name: unknown = err.name;
  if (typeof name !== "string") return null;
  return OPENROUTER_ERROR_CLASSES.has(name) ? name : null;
}
