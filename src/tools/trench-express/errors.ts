/**
 * Trench Express error mapping.
 *
 * Maps provider HTTP failures to typed `VexError` with `TRENCH_*` codes. The
 * provider is hostile-by-accident: input mistakes come back as HTTP 500
 * `text/plain` with a LEAKED runtime exception (Bun/JSC wording), and unknown
 * routes/tokens return HTTP 200 with an EMPTY body. This module never surfaces
 * raw provider text beyond a short, single-line, length-bounded snippet — a
 * leaked stack or internal source expression must not reach the agent.
 */

import { VexError, ErrorCodes } from "../../errors.js";

const MAX_SNIPPET_LEN = 100;

/**
 * Reduce an untrusted `text/plain` error body to a safe, bounded, single-line
 * snippet, or `undefined` when there is nothing usable. Control characters are
 * stripped and the result is truncated so a multi-line stack cannot pass
 * through.
 */
function sanitizeProviderText(body: string | undefined): string | undefined {
  if (!body) return undefined;
  // eslint-disable-next-line no-control-regex
  const oneLine = body.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.length > MAX_SNIPPET_LEN ? `${oneLine.slice(0, MAX_SNIPPET_LEN)}…` : oneLine;
}

/**
 * Map a non-ok Trench Express HTTP response to a typed error. `body` is the raw
 * response text (may be a leaked exception) and is only ever exposed as a
 * sanitized bounded snippet.
 *
 * The provider returns HTTP 500 for CLIENT input mistakes as well as genuine
 * server faults and gives no reliable way to tell them apart, so a 5xx is mapped
 * non-retryable: resubmitting the same params will not help, and this is not a
 * transport failure.
 */
export function mapTrenchExpressError(status: number, body?: string): VexError {
  const snippet = sanitizeProviderText(body);

  if (status >= 500) {
    return new VexError(
      ErrorCodes.TRENCH_INVALID_REQUEST,
      `Trench Express rejected the request (HTTP ${status})`,
      snippet
        ? `Provider detail: ${snippet}`
        : "The launchpad returns HTTP 500 for malformed or missing parameters.",
    );
  }

  if (status === 404) {
    return new VexError(
      ErrorCodes.TRENCH_NOT_FOUND,
      `Trench Express resource not found (HTTP ${status})`,
    );
  }

  return new VexError(
    ErrorCodes.TRENCH_API_ERROR,
    `Trench Express API error (HTTP ${status})`,
    snippet ? `Provider detail: ${snippet}` : undefined,
  );
}

/**
 * Normalize a thrown transport error once, at the client boundary. Already-mapped
 * `TRENCH_*` errors pass through; the shared `HTTP_TIMEOUT`/`HTTP_REQUEST_FAILED`
 * VexErrors are re-tagged so callers can branch on a `TRENCH_*` code.
 */
export function mapTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("TRENCH_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    const mapped = new VexError(ErrorCodes.TRENCH_TIMEOUT, err.message, err.hint);
    mapped.retryable = true;
    throw mapped;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    const mapped = new VexError(ErrorCodes.TRENCH_API_ERROR, err.message, err.hint);
    mapped.retryable = true;
    throw mapped;
  }
  throw err;
}
