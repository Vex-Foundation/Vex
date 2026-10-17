/**
 * The native runtime's start as one observable state: what the "Preparing
 * local runtime" screen shows (plan 8.4), on a replay bus like the migration
 * progress, and read whole by `vex:system:runtimeStatus` for a renderer that
 * arrives late.
 *
 * `native-runtime.ts` is the only writer. A start walks postgres -> model ->
 * embeddings and settles `ready` or `failed`:
 *
 *   - An attempt keeps its FIRST failure. It comes from the code closest to
 *     it: the model store tells a full disk from an unreachable source, while
 *     the start outcome that follows only says the embeddings half failed.
 *   - A start over a runtime that is already ready (the migrate handler
 *     re-checking it) publishes only what takes time and how it ends, so the
 *     state never steps back through phases it has passed.
 *   - Download progress arrives per network chunk. It is published at most
 *     every PROGRESS_INTERVAL_MS and at the last byte, and the speed is
 *     measured over SPEED_WINDOW_MS windows from the first chunk of this
 *     attempt, so the bytes a resumed download already had never count.
 */

import type {
  NativeRuntimeFailureKind,
  NativeRuntimeStatus,
  NativeRuntimeStep,
} from "@shared/schemas/system.js";
import { ReplayBus } from "../../events/event-bus.js";
import type { ModelProgress } from "./model-store.js";

export const PROGRESS_INTERVAL_MS = 250;
export const SPEED_WINDOW_MS = 1_000;

type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
type State = WithoutSeq<NativeRuntimeStatus>;

export interface NativeRuntimeProgress {
  current(): NativeRuntimeStatus;
  /** A start begins; `initializing` when it will create the cluster. */
  begin(initializing: boolean): void;
  modelChecking(): void;
  model(progress: ModelProgress): void;
  embeddingsStarting(): void;
  ready(): void;
  /** Ignored once this attempt has failed. `step` defaults to the current one. */
  fail(kind: NativeRuntimeFailureKind, message: string, step?: NativeRuntimeStep): void;
}

export function createNativeRuntimeProgress(options: {
  readonly publish: (status: NativeRuntimeStatus) => void;
  readonly now?: () => number;
}): NativeRuntimeProgress {
  const now = options.now ?? Date.now;
  let status: NativeRuntimeStatus = { seq: 0, phase: "idle" };
  let quiet = false;
  let publishedAt = 0;
  let speedWindow: { readonly at: number; readonly bytes: number } | null = null;
  let bytesPerSecond: number | null = null;

  const set = (next: State): void => {
    status = { ...next, seq: status.seq + 1 } as NativeRuntimeStatus;
    publishedAt = now();
    options.publish(status);
  };

  const currentStep = (): NativeRuntimeStep =>
    status.phase === "model" || status.phase === "embeddings" ? status.phase : "postgres";

  return {
    current: () => status,

    begin(initializing) {
      quiet = status.phase === "ready";
      speedWindow = null;
      bytesPerSecond = null;
      if (!quiet) set({ phase: "postgres", initializing });
    },

    modelChecking() {
      if (!quiet) set({ phase: "model", model: { state: "checking" } });
    },

    model(progress) {
      if (progress.phase === "verifying") {
        set({ phase: "model", model: { state: "verifying" } });
        return;
      }
      const at = now();
      if (speedWindow === null || progress.receivedBytes < speedWindow.bytes) {
        // First chunk, or a source that ignored the Range and started over.
        speedWindow = { at, bytes: progress.receivedBytes };
      } else if (at - speedWindow.at >= SPEED_WINDOW_MS) {
        bytesPerSecond = Math.round(((progress.receivedBytes - speedWindow.bytes) * 1_000) / (at - speedWindow.at));
        speedWindow = { at, bytes: progress.receivedBytes };
      }
      const entering = !(status.phase === "model" && status.model.state === "downloading");
      const lastByte = progress.receivedBytes === progress.totalBytes;
      if (entering || lastByte || at - publishedAt >= PROGRESS_INTERVAL_MS) {
        set({
          phase: "model",
          model: {
            state: "downloading",
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes,
            bytesPerSecond,
          },
        });
      }
    },

    embeddingsStarting() {
      if (!quiet) set({ phase: "embeddings" });
    },

    ready() {
      if (status.phase !== "ready") set({ phase: "ready" });
    },

    fail(kind, message, step) {
      if (status.phase === "failed") return;
      set({ phase: "failed", step: step ?? currentStep(), kind, message });
    },
  };
}

export const nativeRuntimeProgressBus = new ReplayBus<NativeRuntimeStatus>();

/** The process-wide state, written by `native-runtime.ts`. */
export const nativeRuntimeProgress = createNativeRuntimeProgress({
  publish: (status) => nativeRuntimeProgressBus.emit(status),
});
