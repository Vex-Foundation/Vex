/**
 * Round guard (Kairos Phase 2B, R-3 / R-4 / R-6): the four wall-clock bounds
 * on ONE model inference round, and the request-local signal they abort.
 *
 * WHY ONE GUARD PER ROUND, OWNED ABOVE FAILOVER. The round deadline has to
 * cover everything the round can spend time on: the streaming send, the
 * endpoint failover's retries and backoff sleeps, the SDK's own retries, and
 * the buffered fallback. `runStreamingInference` creates the guard first and
 * hands its `signal` to every one of them, so the fallback inherits whatever
 * budget is LEFT rather than starting a fresh 300 s.
 *
 * WHY A REQUEST-LOCAL CONTROLLER. A fired bound must stop the request without
 * pretending the user pressed Stop. The guard aborts only its own controller;
 * the caller's signal is never touched, so `aborted` keeps meaning "the user
 * stopped". A caller Stop is FORWARDED into the guard's controller (with the
 * caller's own reason) by a listener on the caller's signal, rather than
 * combined through `AbortSignal.any`: `any` links its result to its sources
 * only weakly, and the whole chain from the caller's signal to the body
 * teardown in `openrouter/round-fetch.ts` must survive a GC. The abort reason is an
 * `InferenceTimeoutError` (named `TimeoutError`), which the SDK maps to its
 * `RequestTimeoutError` and the attempt classifier records as `timeout`.
 *
 * WHY `race`. Aborting the signal asks the provider to stop; it cannot force a
 * pending `next()` to settle. A source that ignores its signal would otherwise
 * hold the round open forever. `race` returns the moment a bound fires OR the
 * caller stops. The
 * work it abandons is not left running with resources held: its signal is
 * already aborted, and the consumer releases the iterator.
 *
 * WHY `setTimeout` AND NOT `AbortSignal.timeout`. The round deadline behaves
 * exactly like `AbortSignal.timeout(ms)`, but a plain timer can be cleared the
 * moment the round ends, so nothing outlives the round and fake timers can
 * drive every bound in tests.
 *
 * All bounds are MODEL INFERENCE only. This guard is never armed around a tool
 * dispatch. `0` (or a non-finite / negative value) disables a bound; with all
 * four off the guard is inert and the caller's signal passes through unchanged,
 * which is byte-for-byte the previous behaviour.
 */

import type { InferenceConfig, StreamChunk } from "./types.js";
import {
  InferenceTimeoutError,
  type InferenceStallKind,
} from "./inference-timeout.js";

/** Effective bounds for one round, in ms; 0 means off. */
export interface RoundBounds {
  readonly firstChunkMs: number;
  readonly idleMs: number;
  readonly reasoningOnlyMs: number;
  readonly roundDeadlineMs: number;
}

function positiveMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Read the bounds off a config. Absent, 0, negative or non-finite: off. */
export function roundBoundsFrom(config: InferenceConfig): RoundBounds {
  return {
    firstChunkMs: positiveMs(config.firstChunkTimeoutMs),
    idleMs: positiveMs(config.streamIdleTimeoutMs),
    reasoningOnlyMs: positiveMs(config.reasoningOnlyTimeoutMs),
    roundDeadlineMs: positiveMs(config.inferenceRoundDeadlineMs),
  };
}

/** What `race` resolves to when a bound fired before the work settled. */
export const STALLED: unique symbol = Symbol("inference-round-stalled");

export interface RoundGuard {
  /**
   * The signal every send, backoff and fallback of this round must use: the
   * caller's signal combined with the guard's own. The caller's signal itself
   * (possibly `undefined`) when no bound is enabled.
   */
  readonly signal: AbortSignal | undefined;
  /** The bound that fired, or `null`. First one wins; it never changes. */
  readonly timedOut: InferenceStallKind | null;
  /** Arm the round deadline and the first-chunk bound. Call once, at start. */
  start(): void;
  /**
   * Feed every chunk the round receives: clears the first-chunk bound,
   * (re)arms the idle bound, starts the reasoning-only bound on the first
   * reasoning chunk and cancels it on the first content / tool-call delta.
   */
  onChunk(type: StreamChunk["type"]): void;
  /**
   * The round degraded to a buffered request: nothing will stream, so only the
   * round deadline still applies.
   */
  enterBuffered(): void;
  /**
   * Settle with the work, or with `STALLED` as soon as a bound fires or the
   * caller stops (check the caller's signal to tell which).
   */
  race<T>(work: Promise<T>): Promise<T | typeof STALLED>;
  /** Clear every timer. Idempotent; must run on every exit path. */
  dispose(): void;
}

type StreamBoundKind = Exclude<InferenceStallKind, "round_deadline">;

export function createRoundGuard(
  bounds: RoundBounds,
  callerSignal: AbortSignal | undefined,
): RoundGuard {
  const enabled =
    bounds.firstChunkMs > 0 ||
    bounds.idleMs > 0 ||
    bounds.reasoningOnlyMs > 0 ||
    bounds.roundDeadlineMs > 0;

  const controller = new AbortController();
  const signal = enabled ? controller.signal : callerSignal;

  const timers = new Map<InferenceStallKind, ReturnType<typeof setTimeout>>();
  let timedOut: InferenceStallKind | null = null;
  let reasoningStarted = false;
  let semanticSeen = false;
  let resolveStalled: () => void = () => {};
  const stalled = new Promise<typeof STALLED>((resolve) => {
    resolveStalled = () => resolve(STALLED);
  });

  const clear = (kind: InferenceStallKind): void => {
    const timer = timers.get(kind);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(kind);
    }
  };

  const clearAll = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  // A caller Stop ends the round's request and any wait on it at once. The
  // round is the user's to end, so no bound may fire after it.
  const onCallerAbort = (): void => {
    clearAll();
    controller.abort(callerSignal?.reason);
    resolveStalled();
  };
  if (enabled && callerSignal !== undefined) {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal.aborted) onCallerAbort();
  }

  const fire = (kind: InferenceStallKind): void => {
    timers.delete(kind);
    // A Stop that already landed wins: the round was the user's to end.
    if (timedOut !== null || callerSignal?.aborted === true) return;
    timedOut = kind;
    clearAll();
    controller.abort(new InferenceTimeoutError(kind));
    resolveStalled();
  };

  const arm = (kind: InferenceStallKind, ms: number): void => {
    if (ms <= 0 || timedOut !== null) return;
    clear(kind);
    timers.set(kind, setTimeout(() => fire(kind), ms));
  };

  const streamBoundMs: Record<StreamBoundKind, number> = {
    first_chunk: bounds.firstChunkMs,
    idle: bounds.idleMs,
    reasoning_only: bounds.reasoningOnlyMs,
  };

  return {
    signal,
    get timedOut() {
      return timedOut;
    },
    start() {
      arm("round_deadline", bounds.roundDeadlineMs);
      arm("first_chunk", streamBoundMs.first_chunk);
    },
    onChunk(type) {
      if (timedOut !== null) return;
      clear("first_chunk");
      arm("idle", streamBoundMs.idle);
      if (type === "content" || type === "tool_call_delta") {
        semanticSeen = true;
        clear("reasoning_only");
      } else if (type === "reasoning" && !reasoningStarted && !semanticSeen) {
        reasoningStarted = true;
        arm("reasoning_only", streamBoundMs.reasoning_only);
      }
    },
    enterBuffered() {
      clear("first_chunk");
      clear("idle");
      clear("reasoning_only");
    },
    race<T>(work: Promise<T>): Promise<T | typeof STALLED> {
      if (!enabled) return work;
      if (timedOut !== null || callerSignal?.aborted === true) {
        // Nobody will await the abandoned work; keep its rejection handled.
        work.catch(() => {});
        return Promise.resolve(STALLED);
      }
      return Promise.race([work, stalled]);
    },
    dispose() {
      clearAll();
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
