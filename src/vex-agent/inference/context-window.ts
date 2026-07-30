/**
 * Effective context limit = min(operator-configured, the model's REAL window).
 *
 * `AGENT_CONTEXT_LIMIT` is an operator throttle, not a capability claim. Its
 * default is 256_000, so on a model whose window is 128k the engine would
 * otherwise band against a limit the provider cannot honour: every pressure
 * band (0.80/0.88/0.92 of the limit) sits ABOVE the real window, so a graceful
 * compact never fires and the turn dies on a hard `context_length_exceeded`.
 * Clamping to the provider-reported window makes the bands mean what they say.
 *
 * Pure module — no fetch, no logger, no engine imports. The provider window is
 * an UNTRUSTED provider-catalog value (`rules/03` runtime boundaries): it is
 * validated here and only ever used to LOWER the configured limit, never to
 * raise it. A missing or implausible window leaves the configured value
 * untouched — the catalog must never be able to block or throttle a run.
 */

import { AGENT_CONTEXT_LIMIT } from "../../lib/agent-config.js";

/**
 * Smallest window we will accept as a clamp source. Reuses the operator-facing
 * `AGENT_CONTEXT_LIMIT.min` so the two floors cannot drift: a value the
 * operator is not allowed to configure is also not a value we let a hostile or
 * malformed catalog row impose. Below it, the row is treated as unusable
 * (`model_window_unusable`) rather than clamping the agent down to a window it
 * could never work in.
 */
export const MODEL_CONTEXT_WINDOW_FLOOR = AGENT_CONTEXT_LIMIT.min;

/**
 * Validate a `/models` row's `context_length`. Returns the window in tokens, or
 * `null` when the field is absent, non-numeric, non-integral, or non-positive.
 * Values below the floor parse successfully (they are real numbers) — the
 * floor is applied by {@link resolveEffectiveContextLimit}, which is where the
 * distinction between "unknown" and "implausible" carries different meaning.
 */
export function parseModelContextWindow(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}

/** Why the effective limit is what it is — logged, and asserted by tests. */
export type ContextLimitReason =
  /** Configured limit already fits the model window; used verbatim. */
  | "within_model_window"
  /** Model window is smaller than the configured limit; clamped down to it. */
  | "clamped_to_model_window"
  /** Catalog reported no usable window; configured limit used unchanged. */
  | "model_window_unknown"
  /** Catalog reported a window below the floor; configured limit used unchanged. */
  | "model_window_unusable";

export interface EffectiveContextLimit {
  /** Limit the engine bands against this turn. */
  readonly effective: number;
  /** Configured (`AGENT_CONTEXT_LIMIT`) value, for logging/diagnostics. */
  readonly configured: number;
  /** Validated provider window, or `null` when unknown/unusable. */
  readonly modelWindow: number | null;
  readonly reason: ContextLimitReason;
}

export function resolveEffectiveContextLimit(
  configured: number,
  rawModelWindow: unknown,
): EffectiveContextLimit {
  const parsed = parseModelContextWindow(rawModelWindow);
  if (parsed === null) {
    return {
      effective: configured,
      configured,
      modelWindow: null,
      reason: "model_window_unknown",
    };
  }
  if (parsed < MODEL_CONTEXT_WINDOW_FLOOR) {
    return {
      effective: configured,
      configured,
      modelWindow: null,
      reason: "model_window_unusable",
    };
  }
  if (parsed < configured) {
    return {
      effective: parsed,
      configured,
      modelWindow: parsed,
      reason: "clamped_to_model_window",
    };
  }
  return {
    effective: configured,
    configured,
    modelWindow: parsed,
    reason: "within_model_window",
  };
}
