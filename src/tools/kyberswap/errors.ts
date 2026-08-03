/**
 * Shared KyberSwap error utilities.
 *
 * Provides transport error remapping and the one non-ok response-body reader
 * used by all three KyberSwap sub-clients.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { isRecord } from "../../utils/validation-helpers.js";

/**
 * Remap generic HTTP transport errors to KyberSwap-scoped error codes.
 *
 * `httpStatus` is CARRIED OVER (SPEC §1.5, W2a): it is the field the error
 * contract classifies on before it reads any prose, and re-wrapping used to
 * destroy it — a 403 reached the agent labelled `provider_error`, which invites
 * the one retry that can never succeed.
 */
export function mapKyberTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("KYBER_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw carryStatus(new VexError(ErrorCodes.KYBER_TIMEOUT, err.message, err.hint), err.httpStatus);
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw carryStatus(new VexError(ErrorCodes.KYBER_API_ERROR, err.message, err.hint), err.httpStatus);
  }
  throw err;
}

/** Stamp the provider's status on an error we are re-wrapping. */
export function carryStatus(error: VexError, status: number | undefined): VexError {
  if (status !== undefined) error.httpStatus = status;
  return error;
}

/** What a non-ok KyberSwap response told us, whatever content type it used. */
export interface KyberErrorBody {
  /** KyberSwap's own numeric error code, when the body is its JSON envelope. */
  readonly code: number | null;
  /** The provider's own words — a JSON `message`, or the raw body when it is not JSON. */
  readonly message: string;
  readonly requestId?: string;
}

/**
 * Read a non-ok KyberSwap response WITHOUT discarding what it said.
 *
 * `readJson` returns `null` for any non-JSON body, so a Cloudflare challenge
 * page — the exact thing a missing `User-Agent` produces on all three hosts —
 * collapsed to a bare `HTTP 403` and the agent was never told an edge had
 * blocked it. The raw text is returned here and sanitized downstream by
 * `summarizeProtocolError`, which replaces a whole HTML document with `(html)`
 * and caps the result, so nothing unbounded or unredacted reaches the agent.
 */
export async function readKyberErrorBody(response: Response): Promise<KyberErrorBody> {
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  if (isRecord(parsed)) {
    return {
      code: typeof parsed.code === "number" ? parsed.code : null,
      message: typeof parsed.message === "string" && parsed.message.length > 0
        ? parsed.message
        : `HTTP ${response.status}`,
      ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}),
    };
  }
  return {
    code: null,
    message: text.trim().length > 0 ? `HTTP ${response.status}: ${text}` : `HTTP ${response.status}`,
  };
}
