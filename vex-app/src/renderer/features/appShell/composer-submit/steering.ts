/**
 * Steering attempt (A33) for a submit that lands while a turn is in flight.
 * `steered` means the engine persisted the interrupt row (`queued_live`) -
 * it is on the tape and the live loop reads it at its next tool-step
 * boundary. Anything else is `fallback`: the handler refused or errored
 * BEFORE persisting, so queueing the same text cannot double-send. (The
 * one theoretical exception - the invoke promise failing after main
 * persisted - is an in-process pipe loss; accepted residual risk.)
 */

export type SteerAttemptOutcome = "steered" | "fallback";

export async function trySteerLiveTurn(
  sessionId: string,
  message: string,
): Promise<SteerAttemptOutcome> {
  try {
    const result = await window.vex.chat.steer({ sessionId, message });
    if (result.ok && result.data.outcome === "queued_live") return "steered";
    return "fallback";
  } catch {
    return "fallback";
  }
}

export const STEERED_TOAST_TEXT =
  "Steering queued - the agent reads it at its next step.";
