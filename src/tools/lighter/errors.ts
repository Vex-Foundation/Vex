import { ErrorCodes, VexError } from "../../errors.js";
import { summarizeProtocolError } from "../../utils/error-summary.js";
import type { LighterEnvironment } from "./constants.js";

const MAX_BODY_EXCERPT = 200;

export async function readLighterErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function describeLighterBody(raw: unknown): string | undefined {
  const text = bodyText(raw);
  if (text === undefined) return undefined;
  const cleaned = summarizeProtocolError(new Error(text)).message.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_BODY_EXCERPT
    ? `${cleaned.slice(0, MAX_BODY_EXCERPT)}...`
    : cleaned;
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
