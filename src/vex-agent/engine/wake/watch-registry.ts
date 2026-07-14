/**
 * Generic `loop_defer` watch registry.
 *
 * The scheduler validates only a discriminated envelope. A protocol that owns
 * a condition registers its live validation and trigger predicate here, so a
 * future `token_price` condition does not require scheduler-specific code.
 */

import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

export type WakeWatchCondition = Readonly<Record<string, unknown>>;

export interface WakeWatchSignal {
  readonly type: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface WakeWatchEvaluator {
  readonly type: string;
  /** Validate and canonicalize one condition before it is persisted. */
  validate(condition: WakeWatchCondition, context: InternalToolContext): Promise<WakeWatchCondition>;
  /** Return whether a normalized signal promotes this pending wake. */
  isTriggered(condition: WakeWatchCondition, signal: WakeWatchSignal): boolean;
}

const evaluators = new Map<string, WakeWatchEvaluator>();

/** One evaluator owns each discriminant; conflicting registrations fail closed. */
export function registerWakeWatchEvaluator(evaluator: WakeWatchEvaluator): void {
  const existing = evaluators.get(evaluator.type);
  if (existing !== undefined && existing !== evaluator) {
    throw new Error(`Wake watch evaluator already registered for "${evaluator.type}".`);
  }
  evaluators.set(evaluator.type, evaluator);
}

/** Dispatch generic envelopes to their owning validators. */
export async function validateWakeWatchConditions(
  conditions: readonly WakeWatchCondition[],
  context: InternalToolContext,
): Promise<readonly WakeWatchCondition[]> {
  const normalized: WakeWatchCondition[] = [];
  for (const condition of conditions) {
    const type = condition.type;
    if (typeof type !== "string" || type.length === 0) {
      throw new Error("Watch condition type is required.");
    }
    const evaluator = evaluators.get(type);
    if (evaluator === undefined) {
      throw new Error(`No watch evaluator is registered for "${type}".`);
    }
    normalized.push(await evaluator.validate(condition, context));
  }
  return normalized;
}

/** A malformed persisted condition or unknown variant must never fire. */
export function isWakeWatchTriggered(
  condition: WakeWatchCondition,
  signal: WakeWatchSignal,
): boolean {
  const type = condition.type;
  if (typeof type !== "string") return false;
  const evaluator = evaluators.get(type);
  if (evaluator === undefined) return false;
  try {
    return evaluator.isTriggered(condition, signal);
  } catch {
    return false;
  }
}
