/**
 * In-process inference NOTICE bus: facts about a request that succeeded but
 * not quite as asked, which the user must be told about (never silently).
 *
 * Four kinds: Vex Cloud lowered `max_tokens` (owner decision D16, the
 * `x-vex-max-tokens` disclosure read in `openrouter/round-fetch.ts`), the
 * Vex Inference balance crossed below the user's alert percent (raised by the
 * main-process balance watch, `vex-app/src/main/vex-cloud/balance-watch.ts`),
 * a cooling withdrawal this app did not start is waiting (raised once per
 * withdrawal id by `vex-app/src/main/vex-cloud/funding/withdrawal-origins.ts`),
 * and a session's own model was picked under the other backend so the turn
 * ran on the default (F06, `engine/core/runner/session-model.ts`).
 * The main-side bridge (`vex-app/src/main/agent/inference-notice-bridge.ts`)
 * validates and broadcasts it; the renderer shows it on the session's turn.
 *
 * Same shape as `engine/runtime/error-bus.ts`: a `Set` of listeners,
 * idempotent unsubscribe, a throwing listener isolated from the rest. It
 * lives under `inference/` because the provider is its main producer, and
 * the provider must not import the engine runtime.
 *
 * Notices carry bounded codes and integers only, never request or response
 * content, and are not model-visible: they describe the transport, not the
 * conversation.
 */

import logger from "@utils/logger.js";

import type { MaxTokensClamp } from "./openrouter/max-tokens-clamp.js";

export const INFERENCE_NOTICE_EVENT_TYPE = "engine.inference.notice" as const;

export interface MaxTokensClampedNotice {
  readonly type: typeof INFERENCE_NOTICE_EVENT_TYPE;
  readonly kind: "max_tokens_clamped";
  /** The session whose turn was clamped. Always set: session-less calls only log. */
  readonly sessionId: string;
  readonly missionRunId: string | null;
  /** Provider id (`vexcloud` in practice; the header is Vex Cloud's). */
  readonly provider: string;
  readonly model: string;
  readonly requested: number;
  readonly effective: number;
  readonly reason: MaxTokensClamp["reason"];
  readonly occurredAt: string;
}

/**
 * The Vex Inference balance crossed below the user's alert percent of its
 * reference (the high-water mark since the last credited deposit). ONE per
 * crossing: the main-process balance watch latches it durably. Shown on the
 * turn of the session that last ran Vex Inference inference.
 */
export interface VexInferenceBalanceLowNotice {
  readonly type: typeof INFERENCE_NOTICE_EVENT_TYPE;
  readonly kind: "vex_inference_balance_low";
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly provider: "vexcloud";
  readonly alertPercent: number;
  /** Available plus provisional, raw wei (VEX, 18 decimals). */
  readonly balanceWei: string;
  readonly thresholdWei: string;
  readonly referenceWei: string;
  readonly occurredAt: string;
}

/**
 * A cooling Vex Inference withdrawal whose id this app did not create. ONE
 * per withdrawal id: the main-process record writes its row exactly once.
 * Shown on the turn of the session that last ran Vex Inference inference;
 * the funding page, Settings and Needs you carry the Cancel key.
 */
export interface VexInferenceForeignWithdrawalNotice {
  readonly type: typeof INFERENCE_NOTICE_EVENT_TYPE;
  readonly kind: "vex_inference_foreign_withdrawal";
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly provider: "vexcloud";
  readonly withdrawalId: string;
  /** Raw wei (VEX, 18 decimals). */
  readonly amountWei: string;
  readonly destination: string;
  readonly releaseAt: string;
  readonly occurredAt: string;
}

/**
 * A session's own model (F06) was picked under the other inference backend,
 * so this turn ran on the default model instead. Raised by the runner
 * (`engine/core/runner/session-model.ts`) on every such turn; the latest one
 * per session is shown until the operator picks again or dismisses it.
 */
export interface SessionModelFallbackNotice {
  readonly type: typeof INFERENCE_NOTICE_EVENT_TYPE;
  readonly kind: "session_model_fallback";
  readonly sessionId: string;
  readonly missionRunId: null;
  /** The active backend, which the turn ran on. */
  readonly provider: string;
  /** The default model the turn ran on. */
  readonly model: string;
  /** The backend and model the session's pick names. */
  readonly pickedProvider: string;
  readonly pickedModel: string;
  readonly occurredAt: string;
}

export type InferenceNoticeEvent =
  | MaxTokensClampedNotice
  | VexInferenceBalanceLowNotice
  | VexInferenceForeignWithdrawalNotice
  | SessionModelFallbackNotice;
export type InferenceNoticeListener = (event: InferenceNoticeEvent) => void;

export class InferenceNoticeBus {
  private readonly listeners = new Set<InferenceNoticeListener>();

  emit(event: InferenceNoticeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must not poison the rest of the bus.
      }
    }
  }

  subscribe(listener: InferenceNoticeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const inferenceNoticeBus = new InferenceNoticeBus();

/**
 * Record one D16 clamp: always logged (structured, no content), and emitted
 * to the bus when the request belongs to a session, so a turn can show it. A
 * background call (memory judge, compaction chunker) has no turn to show it
 * on; its log line is the record.
 */
export function emitMaxTokensClampNotice(
  input: {
    readonly provider: string;
    readonly model: string;
    readonly sessionId: string | null;
    readonly missionRunId: string | null;
    readonly clamp: MaxTokensClamp;
  },
  bus: InferenceNoticeBus = inferenceNoticeBus,
): void {
  logger.info("inference.max_tokens_clamped", {
    provider: input.provider,
    model: input.model,
    sessionId: input.sessionId,
    missionRunId: input.missionRunId,
    requested: input.clamp.requested,
    effective: input.clamp.effective,
    reason: input.clamp.reason,
  });
  if (input.sessionId === null) return;
  bus.emit({
    type: INFERENCE_NOTICE_EVENT_TYPE,
    kind: "max_tokens_clamped",
    sessionId: input.sessionId,
    missionRunId: input.missionRunId,
    provider: input.provider,
    model: input.model,
    requested: input.clamp.requested,
    effective: input.clamp.effective,
    reason: input.clamp.reason,
    occurredAt: new Date().toISOString(),
  });
}

// ── Session model picked under the other backend (F06) ──────────────────

/**
 * Emit the notice that a session's own model was picked under the other
 * backend and this turn ran on the default model. The runner logs the fact
 * itself; this only reaches the session's turn.
 */
export function emitSessionModelFallbackNotice(
  input: {
    readonly sessionId: string;
    readonly provider: string;
    readonly model: string;
    readonly pickedProvider: string;
    readonly pickedModel: string;
  },
  bus: InferenceNoticeBus = inferenceNoticeBus,
): void {
  bus.emit({
    type: INFERENCE_NOTICE_EVENT_TYPE,
    kind: "session_model_fallback",
    sessionId: input.sessionId,
    missionRunId: null,
    provider: input.provider,
    model: input.model,
    pickedProvider: input.pickedProvider,
    pickedModel: input.pickedModel,
    occurredAt: new Date().toISOString(),
  });
}

// ── Vex Inference low-balance notice ─────────────────────────────────────

/** The session whose turn last ran Vex Inference inference: where a balance notice is shown. */
let lastVexInferenceTurn: { readonly sessionId: string; readonly missionRunId: string | null } | null = null;

/** Recorded by the provider for every Vex Inference request that belongs to a session. */
export function noteVexInferenceTurn(sessionId: string | null, missionRunId: string | null): void {
  if (sessionId === null) return;
  lastVexInferenceTurn = { sessionId, missionRunId };
}

/** Test-only. */
export function resetVexInferenceTurnForTests(): void {
  lastVexInferenceTurn = null;
}

/**
 * Emit the low-balance notice for one crossing. Always logged (amounts and
 * the percent only); emitted to the bus when a session has run Vex Inference
 * in this process, so a turn can show it. Without one, the funding page
 * indication is the record. Returns whether a session received it.
 */
export function emitVexInferenceBalanceLowNotice(
  input: {
    readonly alertPercent: number;
    readonly balanceWei: bigint;
    readonly thresholdWei: bigint;
    readonly referenceWei: bigint;
  },
  bus: InferenceNoticeBus = inferenceNoticeBus,
): boolean {
  logger.info("inference.vex_inference_balance_low", {
    alertPercent: input.alertPercent,
    balanceWei: input.balanceWei.toString(),
    thresholdWei: input.thresholdWei.toString(),
    referenceWei: input.referenceWei.toString(),
    sessionId: lastVexInferenceTurn?.sessionId ?? null,
  });
  if (lastVexInferenceTurn === null) return false;
  bus.emit({
    type: INFERENCE_NOTICE_EVENT_TYPE,
    kind: "vex_inference_balance_low",
    sessionId: lastVexInferenceTurn.sessionId,
    missionRunId: lastVexInferenceTurn.missionRunId,
    provider: "vexcloud",
    alertPercent: input.alertPercent,
    balanceWei: input.balanceWei.toString(),
    thresholdWei: input.thresholdWei.toString(),
    referenceWei: input.referenceWei.toString(),
    occurredAt: new Date().toISOString(),
  });
  return true;
}

// ── Vex Inference withdrawal this app did not start ──────────────────────

/**
 * Emit the notice for one cooling withdrawal this app did not create. Always
 * logged (the id and the release time only); emitted to the bus when a
 * session has run Vex Inference in this process. Returns whether a session
 * received it; without one, the funding page, Settings and Needs you are the
 * record.
 */
export function emitVexInferenceForeignWithdrawalNotice(
  input: {
    readonly withdrawalId: string;
    readonly amountWei: string;
    readonly destination: string;
    readonly releaseAt: string;
  },
  bus: InferenceNoticeBus = inferenceNoticeBus,
): boolean {
  logger.warn("inference.vex_inference_foreign_withdrawal", {
    withdrawalId: input.withdrawalId,
    releaseAt: input.releaseAt,
    sessionId: lastVexInferenceTurn?.sessionId ?? null,
  });
  if (lastVexInferenceTurn === null) return false;
  bus.emit({
    type: INFERENCE_NOTICE_EVENT_TYPE,
    kind: "vex_inference_foreign_withdrawal",
    sessionId: lastVexInferenceTurn.sessionId,
    missionRunId: lastVexInferenceTurn.missionRunId,
    provider: "vexcloud",
    withdrawalId: input.withdrawalId,
    amountWei: input.amountWei,
    destination: input.destination,
    releaseAt: input.releaseAt,
    occurredAt: new Date().toISOString(),
  });
  return true;
}
