/**
 * Kairos stream bounds (Phase 2B): the typed timeout vocabulary.
 *
 * One inference round is bounded four ways, each an `agent-config` field
 * (`src/lib/agent-config.ts`, 0 disables):
 *
 *   - `first_chunk`    request start → first chunk of any type;
 *   - `idle`           silence between two chunks after the first;
 *   - `reasoning_only` first reasoning chunk → first content/tool delta;
 *   - `round_deadline` total wall clock for the round, including SDK retries,
 *                      endpoint failover backoff and the buffered fallback.
 *
 * These bounds apply to MODEL INFERENCE only. Nothing here is ever armed
 * around a tool dispatch.
 *
 * WHY THE ERROR IS NAMED `TimeoutError`. The same name `AbortSignal.timeout`
 * aborts with, so every layer that already tells a deadline from a user Stop
 * keeps doing so without learning a new name: the OpenRouter SDK maps an abort
 * whose reason is named `TimeoutError` to its `RequestTimeoutError`, and the
 * Phase 1 attempt classifier (`isInferenceTimeout`) records it as `timeout`.
 * A user Stop stays an `AbortError`.
 */

/** Which Kairos bound stopped an inference round. */
export type InferenceStallKind =
  | "first_chunk"
  | "idle"
  | "reasoning_only"
  | "round_deadline";

/** The name every Kairos timeout error carries (see module doc). */
export const INFERENCE_TIMEOUT_ERROR_NAME = "TimeoutError";

/**
 * The abort reason a fired bound hands its request-local controller. Carries
 * the bound's kind and nothing else: no provider text, no request content.
 */
export class InferenceTimeoutError extends Error {
  readonly kind: InferenceStallKind;

  constructor(kind: InferenceStallKind) {
    super(`Inference stopped: the ${kind} bound was exceeded`);
    this.name = INFERENCE_TIMEOUT_ERROR_NAME;
    this.kind = kind;
  }
}

/**
 * The sanitised `inference_attempts.error_class` for a round a Kairos bound
 * stopped. Bounded vocabulary: the kind is a closed union.
 */
export function kairosStallErrorClass(kind: InferenceStallKind): string {
  return `KairosStall:${kind}`;
}

/**
 * Give an already-normalized error the timeout name, so a deadline that
 * surfaces as a rejection is classified `timeout` rather than a generic
 * `error`.
 *
 * Only the `name` changes. Every own-property the mission auto-retry
 * classifier reads (`statusCode`, `causeCode`, `errorClass`, …) is left
 * exactly as the normalizer set it, and that classifier only ever reads the
 * name to recognise an `AbortError`, which this never produces.
 */
export function nameAsInferenceTimeout<E extends Error>(err: E): E {
  err.name = INFERENCE_TIMEOUT_ERROR_NAME;
  return err;
}
