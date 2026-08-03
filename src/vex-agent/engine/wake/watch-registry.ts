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

/**
 * The watch types a caller may actually use, in registration order.
 *
 * Exists so a refusal can NAME the supported set instead of telling the model
 * only what it may not do. A model that reads `No watch evaluator is registered
 * for "x"` has learned nothing it can act on — the agent-facing-errors decree
 * applies to a schema refusal exactly as it applies to a provider failure.
 */
export function listWakeWatchTypes(): readonly string[] {
  return [...evaluators.keys()];
}

/**
 * Per-condition validation outcome.
 *
 * Validation NEVER throws for the caller as a whole: one unusable condition
 * must not take the surrounding `loop_defer` with it. The live incident this
 * design answers is the reverse — a rejected watch failed the whole call, the
 * run therefore did NOT park, and the agent kept thinking. A watch is an
 * OPTIMIZATION over the timer; losing it must degrade to the timer, never to
 * "still awake".
 */
export type WakeWatchValidation =
  | { readonly kind: "accepted"; readonly condition: WakeWatchCondition }
  | { readonly kind: "rejected"; readonly reason: string };

export interface WakeWatchValidationResult {
  readonly accepted: readonly WakeWatchCondition[];
  readonly rejected: readonly string[];
}

/** Dispatch generic envelopes to their owning validators. */
export async function validateWakeWatchConditions(
  conditions: readonly WakeWatchCondition[],
  context: InternalToolContext,
): Promise<WakeWatchValidationResult> {
  const accepted: WakeWatchCondition[] = [];
  const rejected: string[] = [];
  for (const condition of conditions) {
    const outcome = await validateOne(condition, context);
    if (outcome.kind === "accepted") accepted.push(outcome.condition);
    else rejected.push(outcome.reason);
  }
  return { accepted, rejected };
}

async function validateOne(
  condition: WakeWatchCondition,
  context: InternalToolContext,
): Promise<WakeWatchValidation> {
  const type = condition.type;
  const supported = listWakeWatchTypes();
  const supportedList = supported.length > 0 ? supported.join(", ") : "(none)";
  if (typeof type !== "string" || type.length === 0) {
    return {
      kind: "rejected",
      reason: `a watch condition needs a "type" string. Supported watch types: ${supportedList}.`,
    };
  }
  const evaluator = evaluators.get(type);
  if (evaluator === undefined) {
    return {
      kind: "rejected",
      reason: `watch type "${type}" is not supported. Supported watch types: ${supportedList}.`,
    };
  }
  try {
    return { kind: "accepted", condition: await evaluator.validate(condition, context) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "condition validation failed";
    return { kind: "rejected", reason: `watch "${type}": ${detail}` };
  }
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
