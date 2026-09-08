import { ErrorCodes, VexError } from "../../errors.js";
import { summarizeProtocolError } from "../../utils/error-summary.js";
import type { LighterEnvironment } from "./constants.js";

export async function readLighterErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The provider's own words about a rejection, sanitized, with NO cut of our own.
 *
 * `summarizeProtocolError` (`utils/error-summary/`) is the single owner of both
 * the redaction and the bound on this text: it strips API keys, Lighter
 * read-only auth tokens and the rest of the secret shapes, then applies its own
 * documented cap. This function used to apply a SECOND, venue-local cut at 200
 * characters with a "..." suffix on top of that, and Lighter's longest
 * rejections are the useful ones - a reproduction lost the trailing "missing
 * field X" instruction, which was the only actionable sentence in the body and
 * the reason the caller had asked. The venue-local cut is gone; whatever the
 * shared owner hands back reaches the caller unchanged, and a consumer that
 * needs a tighter bound owns that bound and reports it (CLAUDE.md, "FORBIDDEN:
 * silent content cutting").
 */
export function describeLighterBody(raw: unknown): string | undefined {
  const text = bodyText(raw);
  if (text === undefined) return undefined;
  const cleaned = summarizeProtocolError(new Error(text)).message.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned;
}

function bodyText(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const fields = raw as Record<string, unknown>;
    const nested = fields.error;
    if (nested !== null && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    for (const key of ["error", "message", "detail"] as const) {
      const value = fields[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
  }
}

function withStatus(error: VexError, status: number): VexError {
  error.httpStatus = status;
  return error;
}

function environmentName(environment: LighterEnvironment): string {
  return environment === "core" ? "Lighter Core" : "Lighter RHC";
}

function withBody(sentence: string, body: unknown): string {
  const excerpt = describeLighterBody(body);
  return excerpt === undefined ? sentence : `${sentence} Upstream said: ${excerpt}`;
}

export function mapLighterError(
  environment: LighterEnvironment,
  status: number,
  body?: unknown,
): VexError {
  const name = environmentName(environment);

  if (status === 429) {
    const err = new VexError(
      ErrorCodes.LIGHTER_RATE_LIMITED,
      withBody(`${name} API rate limited (HTTP 429).`, body),
      "Wait before retrying; Lighter rate limits public REST requests and WebSocket usage.",
    );
    err.retryable = true;
    return withStatus(err, status);
  }

  if (status === 404) {
    return withStatus(
      new VexError(
        ErrorCodes.LIGHTER_NOT_FOUND,
        withBody(`${name} resource not found (HTTP 404).`, body),
        "Check the selected Lighter environment and market id.",
      ),
      status,
    );
  }

  if (status >= 500) {
    const err = new VexError(
      ErrorCodes.LIGHTER_API_ERROR,
      withBody(`${name} server error (HTTP ${status}).`, body),
      "Lighter answered with a server error. Try again later.",
    );
    err.retryable = true;
    return withStatus(err, status);
  }

  if (status >= 400) {
    return withStatus(
      new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        withBody(`${name} rejected the request (HTTP ${status}).`, body),
        "Check the market id, filter, limit, candle resolution, and timestamp bounds.",
      ),
      status,
    );
  }

  return withStatus(
    new VexError(
      ErrorCodes.LIGHTER_API_ERROR,
      withBody(`${name} API returned HTTP ${status}.`, body),
    ),
    status,
  );
}

export function mapLighterSubmitError(
  environment: LighterEnvironment,
  status: number,
): VexError {
  const name = environmentName(environment);

  if (status === 429) {
    const err = new VexError(
      ErrorCodes.LIGHTER_RATE_LIMITED,
      `${name} rate limited signed transaction submission (HTTP 429).`,
      "Wait before retrying. Do not retry blindly until the nonce state has been reconciled.",
    );
    err.retryable = true;
    return withStatus(err, status);
  }

  if (status >= 500) {
    const err = new VexError(
      ErrorCodes.LIGHTER_API_ERROR,
      `${name} server error during signed transaction submission (HTTP ${status}).`,
      "Treat the order state as ambiguous until Lighter nonce and order state are re-read.",
    );
    err.retryable = true;
    return withStatus(err, status);
  }

  if (status >= 400) {
    return withStatus(
      new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        `${name} rejected signed transaction submission (HTTP ${status}).`,
        "Check approval, account, API-key nonce, margin, market, price protection, and order constraints before trying again.",
      ),
      status,
    );
  }

  return withStatus(
    new VexError(
      ErrorCodes.LIGHTER_API_ERROR,
      `${name} returned HTTP ${status} during signed transaction submission.`,
    ),
    status,
  );
}

export function mapLighterTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("LIGHTER_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    const mapped = new VexError(ErrorCodes.LIGHTER_TIMEOUT, err.message, err.hint);
    mapped.retryable = true;
    throw mapped;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    const mapped = new VexError(ErrorCodes.LIGHTER_API_ERROR, err.message, err.hint);
    mapped.retryable = true;
    throw mapped;
  }
  throw err;
}
