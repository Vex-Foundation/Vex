import { ErrorCodes, VexError } from "../../../../errors.js";

/** Set the moment an approved action starts reserving its nonce. */
export interface LighterSendPhase {
  reserving: boolean;
}

/**
 * Run an approved Lighter action so that a failure to reach Lighter BEFORE it
 * reserved a nonce says so plainly. Up to that point nothing has been
 * reserved, signed or sent, so the trader can simply retry; the transport's
 * own text ("Request timed out after 30000ms") read as if the order might be
 * in flight. Anything thrown once reservation starts is left exactly as it is.
 */
export async function withLighterBeforeSendFailures<T>(run: (phase: LighterSendPhase) => Promise<T>): Promise<T> {
  const phase: LighterSendPhase = { reserving: false };
  try {
    return await run(phase);
  } catch (error) {
    throw phase.reserving ? error : lighterUnreachableBeforeSend(error);
  }
}

/** A timeout, network failure or 5xx from Lighter: it could not be reached, not that it refused. */
export function isLighterUnreachable(error: unknown): error is VexError {
  return error instanceof VexError
    && (error.code === ErrorCodes.LIGHTER_TIMEOUT || error.code === ErrorCodes.LIGHTER_API_ERROR);
}

/** An unreachable-Lighter failure, restated for a moment when nothing was sent. */
export function lighterUnreachableBeforeSend(error: unknown): unknown {
  if (!isLighterUnreachable(error)) return error;
  const restated = new VexError(
    error.code,
    "Vex couldn't reach Lighter before sending, so nothing was signed or sent. Check your connection and try again.",
    `Lighter did not answer: ${error.message}`,
  );
  restated.retryable = error.retryable;
  return restated;
}
