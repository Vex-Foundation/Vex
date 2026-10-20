/**
 * In-process inference NOTICE bus: facts about a request that succeeded but
 * not quite as asked, which the user must be told about (never silently).
 *
 * Today one kind exists: Vex Cloud lowered `max_tokens` (owner decision D16,
 * the `x-vex-max-tokens` disclosure read in `openrouter/round-fetch.ts`).
 * The main-side bridge (`vex-app/src/main/agent/inference-notice-bridge.ts`)
 * validates and broadcasts it; the renderer shows it on the session's turn.
 *
 * Same shape as `engine/runtime/error-bus.ts`: a `Set` of listeners,
 * idempotent unsubscribe, a throwing listener isolated from the rest. It
 * lives under `inference/` because the provider is its only producer, and
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

export type InferenceNoticeEvent = MaxTokensClampedNotice;
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
