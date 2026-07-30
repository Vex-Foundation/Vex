/**
 * The pre-inference byte ceiling (contract C8) — "may this request be issued?"
 *
 * WHY IT EXISTS. The 0.88 barrier is what normally stops the tape outgrowing
 * the model's context window: it strips the mutating surface, so the agent
 * cannot keep adding to a conversation that is already too big. While a live
 * compaction preparation suppresses that barrier, the guard is gone — so every
 * inference on the bypass path is bounded here instead.
 *
 * WHAT MAKES IT SOUND. The caller passes the request envelope OBJECT it is
 * about to send, and this module measures THAT object. `buildTurnEnvelope` is
 * not reproducible (the turn-state segment embeds the current time), so a
 * ceiling computed over a second build would describe a request nobody issues.
 * The measurement itself is the real serialized provider body, not an estimate
 * (`inference/openrouter/request-bytes.ts`).
 *
 * THE ONE PROPERTY THAT MATTERS: on a breach, the request is never issued. Every
 * branch below either relieves the pressure and restarts the iteration, or
 * escalates. There is no path from `breach` to inference.
 *
 * An UNMEASURABLE request counts as a breach. With the barrier bypassed there
 * is no other evidence the request fits, and issuing one we cannot bound is
 * precisely the failure this exists to prevent.
 */

import type { InferenceConfig, ProviderMessage, ToolDefinition } from "@vex-agent/inference/types.js";
import {
  checkPreInferenceCeiling,
  measureInferenceEnvelopeBytes,
} from "../inference-envelope-bytes.js";
import { tryCriticalBandFallback } from "../turn-loop-critical-fallback.js";
import logger from "@utils/logger.js";

export type PreInferenceGateOutcome =
  /** Under the ceiling (or not checked) — issue the request. */
  | { kind: "proceed" }
  /**
   * Breached, and the pressure was addressed (compacted, or correctly declined
   * because a Stop is queued, or nothing was compactable). The caller must
   * restart the iteration WITHOUT issuing the request.
   *
   * `committed` tells the caller whether a compaction actually landed, and
   * therefore whether the loop's cached transcript/summary/token count are now
   * stale and need post-compact bookkeeping. A deferral or a noop changed
   * nothing, so re-reading would be wasted work.
   */
  | {
      kind: "retry_iteration";
      committed: boolean;
      nextCriticalNoopCounter: number;
    }
  | { kind: "escalated"; stopReason: "compact_unable_at_critical" };

export interface PreInferenceGateInput {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly sessionPermission: "restricted" | "full";
  /** False ⇒ the barrier is doing its job; the ceiling is skipped entirely. */
  readonly preparationBypassesBarrier: boolean;
  /** The messages of the envelope that will actually be sent. */
  readonly providerMessages: ProviderMessage[];
  readonly tools: ToolDefinition[];
  readonly config: InferenceConfig;
  readonly contextLimit: number;
  readonly currentTokenCount: number;
  readonly criticalNoopCounter: number;
  /**
   * The lease owner id the calling runner holds. REQUIRED (never optional) so a
   * caller cannot silently drop it: without an owner the ladder below cannot
   * prove ownership, skips the prepared apply and runs the deterministic
   * fallback instead — which violates C8's "force the prepared apply when one
   * is ready". `undefined` is the explicit fail-closed answer for a caller that
   * genuinely holds no lease, not a default.
   */
  readonly runnerOwnerId: string | undefined;
}

export async function checkPreInferenceGate(
  input: PreInferenceGateInput,
): Promise<PreInferenceGateOutcome> {
  // Skipped when the barrier is intact. That is the C8 contract, and it is also
  // where it earns its cost: a full serialization of the tape every turn is not
  // free, and without a bypass it would be measuring something already guarded.
  if (!input.preparationBypassesBarrier) return { kind: "proceed" };

  const measurement = measureInferenceEnvelopeBytes({
    providerMessages: input.providerMessages,
    tools: input.tools,
    config: input.config,
    context: { sessionId: input.sessionId, missionRunId: input.missionRunId },
  });

  const ceiling =
    measurement.kind === "measured"
      ? checkPreInferenceCeiling({
          envelopeBytes: measurement.bytes,
          contextLimit: input.contextLimit,
        })
      : { kind: "breach" as const, projectedTokensLowerBound: Number.NaN };

  if (ceiling.kind === "ok") return { kind: "proceed" };

  logger.warn("compact.pre_inference_ceiling.breach", {
    sessionId: input.sessionId,
    measured: measurement.kind === "measured",
    projectedTokensLowerBound: ceiling.projectedTokensLowerBound,
    contextLimit: input.contextLimit,
  });

  // Relieve the pressure through the SAME ladder the critical band uses:
  // prepared apply first, bounded wait, deterministic fallback, and the same
  // noop/escalation state machine. `turnBand: "critical"` is not a guess — an
  // envelope at or over the window IS the critical condition, whatever the
  // one-turn-lagging token count currently says. The one-shot skip is
  // overridden for the same reason: there is nothing stale about a measurement
  // of the request in hand.
  const outcome = await tryCriticalBandFallback({
    sessionId: input.sessionId,
    missionRunId: input.missionRunId,
    turnBand: "critical",
    skipCriticalCheckNextIter: false,
    criticalNoopCounter: input.criticalNoopCounter,
    currentTokenCount: input.currentTokenCount,
    contextLimit: input.contextLimit,
    sessionPermission: input.sessionPermission,
    ...(input.runnerOwnerId === undefined
      ? {}
      : { runnerOwnerId: input.runnerOwnerId }),
  });

  if (outcome.kind === "escalated") {
    return { kind: "escalated", stopReason: outcome.stopReason };
  }

  // committed / gate_deferred / noop all restart the iteration. `noop` advanced
  // the counter, so a repeat breach escalates through the same machine instead
  // of spinning forever; `gate_deferred` passed it through untouched.
  return {
    kind: "retry_iteration",
    committed: outcome.kind === "committed",
    nextCriticalNoopCounter:
      "nextCriticalNoopCounter" in outcome
        ? outcome.nextCriticalNoopCounter
        : input.criticalNoopCounter,
  };
}
