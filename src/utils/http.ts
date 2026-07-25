/**
 * HTTP utilities with timeout and error handling.
 */

import type { ZodType } from "zod";
import { VexError, ErrorCodes } from "../errors.js";
import { isRecord } from "./validation-helpers.js";

const DEFAULT_TIMEOUT_MS = 30000;

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * Field names an error body may carry its human-readable reason under, in
 * precedence order. `error` stays FIRST so a body that has it behaves exactly
 * as it did before this widening.
 *
 * Why the others exist: reading `error` alone discarded the provider's own
 * words whenever it named the field differently. Live proof (funded gate,
 * 2026-07-24): `solana.predict.buy` showed the agent `HTTP 400: Bad Request`
 * while Jupiter Prediction had actually answered
 * `{"type":"invalid_request_error","message":"Minimum order is $5",
 *   "code":"create_order_failed", ...}` — an actionable limit replaced by a
 * status line. `detail`/`details` is the same field under the naming
 * convention other JSON APIs use.
 *
 * Only non-empty STRING values are lifted. An object/array value is provider
 * STRUCTURE, not a sentence, and must never be stringified into agent-visible
 * output — that is why a `{error:{...}}` body still degrades to the status
 * line rather than leaking a serialized payload.
 */
const ERROR_BODY_MESSAGE_FIELDS = ["error", "message", "detail", "details"] as const;

/**
 * Field names a provider may carry a MACHINE-readable error code under (e.g.
 * Jupiter Prediction's `"code":"create_order_failed"`). `VexError.externalName`
 * is this repo's existing carrier for exactly that — the Khalani and KyberSwap
 * error mappers already populate it — so classification code can key on the
 * provider's stable code instead of parsing prose.
 */
const ERROR_BODY_CODE_FIELDS = ["code", "errorCode"] as const;

/** First non-empty string among `fields`, or undefined. Untrusted body input. */
function readErrorBodyText(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = body[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * First usable machine code among `fields`. Accepts a string or a finite number
 * (KyberSwap-style numeric codes) and normalizes to the string `externalName`
 * carries; anything else is provider structure and is ignored.
 */
function readErrorBodyCode(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = body[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Fetch with timeout and standardized error handling.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new VexError(
        ErrorCodes.HTTP_TIMEOUT,
        `Request timed out after ${timeoutMs}ms`,
        "Check network connectivity or try again later"
      );
    }
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      err instanceof Error ? err.message : "HTTP request failed",
      "Check network connectivity"
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse a JSON response with error handling.
 *
 * When `schema` is supplied the parsed body is validated with Zod and the
 * validated value is returned (codex-002). Validation failures throw
 * `HTTP_RESPONSE_INVALID` — distinct from network failures so callers can
 * treat a malformed/hostile payload as non-retryable. When `schema` is
 * omitted the body is returned via an unchecked cast for backward
 * compatibility; new external-API callers SHOULD pass a schema (or validate
 * the `readJson` result with a dedicated validator).
 */
export async function parseJsonResponse<T>(
  response: Response,
  schema?: ZodType<T>
): Promise<T> {
  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    let externalName: string | undefined;
    try {
      // Treat the error body as untrusted `unknown` — never assume a shape.
      const errorBody: unknown = await response.json();
      if (isRecord(errorBody)) {
        errorMessage = readErrorBodyText(errorBody, ERROR_BODY_MESSAGE_FIELDS) ?? errorMessage;
        externalName = readErrorBodyCode(errorBody, ERROR_BODY_CODE_FIELDS);
      }
    } catch {
      // Ignore JSON parse errors for error response
    }
    const error = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, errorMessage);
    // Preserve the status: the message alone loses it whenever the provider
    // supplies its own reason string, and callers acting on money need to
    // tell a definitive 4xx refusal from an ambiguous 5xx/transport failure.
    // It is also the ONLY reliable way to branch on a status — never re-parse
    // it out of the message, which the provider's own text now replaces.
    error.httpStatus = response.status;
    if (externalName) error.externalName = externalName;
    throw error;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      "Failed to parse JSON response"
    );
  }

  if (!schema) {
    return json as T;
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new VexError(
      ErrorCodes.HTTP_RESPONSE_INVALID,
      `Response failed schema validation: ${detail}`,
      "The upstream API returned an unexpected response shape"
    );
  }
  return parsed.data;
}

/**
 * Combined fetch + JSON parse with error handling. Pass `schema` to validate
 * the response body at the boundary (codex-002).
 */
export async function fetchJson<T>(
  url: string,
  options: FetchOptions = {},
  schema?: ZodType<T>
): Promise<T> {
  const response = await fetchWithTimeout(url, options);
  return parseJsonResponse<T>(response, schema);
}

/**
 * Safely read JSON from a response without throwing on parse failure.
 * Used by API clients that need to read error bodies before mapping errors.
 */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
