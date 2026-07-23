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
    try {
      // Treat the error body as untrusted `unknown` — never assume a shape.
      const errorBody: unknown = await response.json();
      if (isRecord(errorBody) && typeof errorBody.error === "string") {
        errorMessage = errorBody.error;
      }
    } catch {
      // Ignore JSON parse errors for error response
    }
    throw new VexError(ErrorCodes.HTTP_REQUEST_FAILED, errorMessage);
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
