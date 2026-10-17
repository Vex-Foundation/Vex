/**
 * The one door to the native runtime's start while an install may still have
 * data in the previous release's container stack (the engine's boot contract,
 * in the migration engine next to this file).
 *
 *   - Boot asks `detect()` FIRST and opens the gate only on `not_needed`: a
 *     native runtime started on a pending install would create its own
 *     cluster, and the old volume would never be offered. `pending*` and
 *     `state_unreadable` keep it shut.
 *   - Every caller of the native start goes through `startNative()`: the
 *     migrate handler and the runtime screen's Retry. A shut gate answers
 *     `migration_pending` and starts nothing.
 *   - A move or a start-fresh that ends with the data in the native cluster
 *     (`migrated`, `already_completed`, `started_fresh`) opens the gate and
 *     starts the runtime, which the runtime screen then watches.
 *   - While a move runs it owns the native cluster: nothing here starts the
 *     runtime until it has settled, and quit aborts it through `shutdown()`
 *     (the engine keeps the durable steps; the next launch resumes).
 *
 * It also maps the engine's vocabulary onto the shared schema
 * (`@shared/schemas/runtime-migration.ts`), so nothing past main names the
 * old stack's tooling. The engine's own critical op (`localRuntime`) covers
 * every operation; the gate adds none.
 */

import type {
  RuntimeMigrationFailed,
  RuntimeMigrationFailureReason,
  RuntimeMigrationLastFailure,
  RuntimeMigrationProgress,
  RuntimeMigrationRemoveOldDataInput,
  RuntimeMigrationRemoveOldDataResult,
  RuntimeMigrationResult,
  RuntimeMigrationStartFreshResult,
  RuntimeMigrationStatus,
} from "@shared/schemas/runtime-migration.js";
import { ReplayBus } from "../../events/event-bus.js";
import { log } from "../../logger/index.js";
import { startNativeRuntime, type NativeRuntimeStart } from "../native/native-runtime.js";
import type { MigrationFailureRecord } from "../runtime-state.js";
import {
  productionMigration,
  type MigrateResult,
  type MigrationFailed,
  type MigrationFailureKind,
  type MigrationProgress,
  type RemoveOldDataResult,
  type StartFreshResult,
} from "./docker-to-native.js";

/** The gate is shut: the data must be moved (or the user start fresh) first. */
export interface NativeStartBlocked {
  readonly kind: "migration_pending";
  readonly message: string;
}

export interface NativeStartGate {
  /** Boot, native mode: detect, and start the native runtime only when nothing is pending. */
  boot(): Promise<void>;
  /** Start or join the native runtime when the gate is open; never starts it otherwise. */
  startNative(): Promise<NativeRuntimeStart | NativeStartBlocked>;
  /** What the migration screen shows. Re-detects while the gate is shut (never starts the old stack). */
  status(): Promise<RuntimeMigrationStatus>;
  /** Move the data. Joins a move in flight; never rejects. */
  migrate(): Promise<RuntimeMigrationResult>;
  /** A fresh native cluster instead; the old volume is kept. Joins one in flight. */
  startFresh(): Promise<RuntimeMigrationStartFreshResult>;
  removeOldData(input: RuntimeMigrationRemoveOldDataInput): Promise<RuntimeMigrationRemoveOldDataResult>;
  /** The latest progress event of the move in flight (null otherwise), for a screen that joins late. */
  lastProgress(): RuntimeMigrationProgress | null;
  /** Quit: abort a running operation and wait for it to settle. */
  shutdown(): Promise<void>;
}

type Engine = ReturnType<typeof productionMigration>;
type EngineStatus = Awaited<ReturnType<Engine["detect"]>>;

export interface NativeStartGateDeps {
  readonly migration: Engine;
  readonly startNative: () => Promise<NativeRuntimeStart>;
  readonly publishProgress: (progress: RuntimeMigrationProgress) => void;
}

type OpenReason = Extract<EngineStatus, { kind: "not_needed" }>["reason"];

const PENDING_MESSAGE = "Your existing data must be moved to the built-in database first.";

/* ---------------------------- vocabulary ---------------------------- */

const REASON: Record<MigrationFailureKind, RuntimeMigrationFailureReason> = {
  docker_unavailable: "source_offline",
  no_docker_volume: "source_volume_missing",
  source_unavailable: "source_unavailable",
  source_empty: "source_empty",
  disk_full: "disk_full",
  dump_failed: "dump_failed",
  dump_corrupt: "dump_corrupt",
  native_unavailable: "native_unavailable",
  native_start_failed: "native_start_failed",
  native_cluster_busy: "native_cluster_busy",
  restore_failed: "restore_failed",
  verify_failed: "verify_failed",
  state_unreadable: "state_unreadable",
  busy: "busy",
  not_pending: "not_pending",
  unexpected: "unexpected",
};

function reasonOf(kind: string): RuntimeMigrationFailureReason {
  return Object.hasOwn(REASON, kind) ? REASON[kind as MigrationFailureKind] : "unexpected";
}

function lastFailureOf(record: MigrationFailureRecord | null): RuntimeMigrationLastFailure | null {
  return record === null ? null : { reason: reasonOf(record.kind), message: record.message, at: record.at };
}

export function toSharedStatus(status: EngineStatus): RuntimeMigrationStatus {
  switch (status.kind) {
    case "not_needed":
      return { kind: "not_needed" };
    case "pending":
      return { kind: "pending", resumeStep: status.resumeStep, lastFailure: lastFailureOf(status.lastFailure) };
    case "pending_docker_unavailable":
      return {
        kind: "pending_source_offline",
        detail: status.detail,
        resumeStep: status.resumeStep,
        lastFailure: lastFailureOf(status.lastFailure),
      };
    case "state_unreadable":
      return { kind: "state_unreadable", message: status.message };
  }
}

function toSharedFailure(result: MigrationFailed): RuntimeMigrationFailed {
  return {
    kind: "failed",
    reason: REASON[result.reason],
    message: result.message,
    requiredBytes: result.requiredBytes,
    availableBytes: result.availableBytes,
  };
}

function toSharedResult(result: MigrateResult): RuntimeMigrationResult {
  switch (result.kind) {
    case "migrated":
      return { kind: "migrated", oldStackStopped: result.oldStackStopped, message: result.message };
    case "already_completed":
      return { kind: "already_completed", outcome: result.outcome };
    case "cancelled":
      return { kind: "cancelled", resumeStep: result.resumeStep };
    case "failed":
      return toSharedFailure(result);
  }
}

function toSharedFresh(result: StartFreshResult): RuntimeMigrationStartFreshResult {
  return result.kind === "started_fresh" ? result : toSharedFailure(result);
}

function toSharedRemove(result: RemoveOldDataResult): RuntimeMigrationRemoveOldDataResult {
  if (result.kind !== "failed") return result;
  return { kind: "failed", reason: result.reason === "docker_unavailable" ? "source_offline" : "failed", message: result.message };
}

function failure(reason: RuntimeMigrationFailureReason, message: string): RuntimeMigrationFailed {
  return { kind: "failed", reason, message, requiredBytes: null, availableBytes: null };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------ the gate ----------------------------- */

export function createNativeStartGate(deps: NativeStartGateDeps): NativeStartGate {
  const lifetime = new AbortController();
  let openReason: OpenReason | null = null;
  let detection: Promise<EngineStatus> | null = null;
  type Op =
    | { readonly kind: "migrate"; readonly result: Promise<RuntimeMigrationResult> }
    | { readonly kind: "start_fresh"; readonly result: Promise<RuntimeMigrationStartFreshResult> };
  let op: Op | null = null;
  let progress: RuntimeMigrationProgress | null = null;
  let seq = 0;

  function open(reason: OpenReason): void {
    if (openReason !== null) return;
    openReason = reason;
    log.info(`[runtime:migration] gate open (${reason}); starting the native runtime`);
    void deps.startNative();
  }

  /** Single-flight; opens the gate on `not_needed`. Never rejects. */
  function detect(): Promise<EngineStatus> {
    detection ??= deps.migration
      .detect({ signal: lifetime.signal })
      .catch((error: unknown): EngineStatus => {
        // Nothing may be decided from a detection that threw: stay shut.
        log.error(`[runtime:migration] detect threw: ${messageOf(error)}`);
        return { kind: "state_unreadable", message: `Vex could not tell whether its data must be moved: ${messageOf(error)}` };
      })
      .then((status) => {
        log.info(`[runtime:migration] detect: ${status.kind}${status.kind === "not_needed" ? ` (${status.reason})` : ""}`);
        // Never while an operation runs: it owns the cluster until it settles.
        if (status.kind === "not_needed" && op === null) open(status.reason);
        return status;
      })
      .finally(() => {
        detection = null;
      });
    return detection;
  }

  function publish(p: MigrationProgress): void {
    seq += 1;
    const next: RuntimeMigrationProgress = { ...p, seq };
    progress = next;
    try {
      deps.publishProgress(next);
    } catch {
      // An observer must not break the move.
    }
  }

  /** Run `body` as THE operation; a second call of the same kind joins it. */
  function exclusive<T>(kind: "migrate" | "start_fresh", body: () => Promise<T>, busy: () => T): Promise<T> {
    if (op !== null) {
      return op.kind === kind ? (op.result as Promise<T>) : Promise.resolve(busy());
    }
    const result = body();
    op = { kind, result } as Op;
    void result.finally(() => {
      if (op?.result === result) op = null;
    });
    return result;
  }

  const busy = (): RuntimeMigrationFailed => failure("busy", "Another migration step is already running.");

  /** A call on an open gate: report what opened it instead of touching the cluster. */
  function alreadyOpen(): RuntimeMigrationResult {
    if (openReason === "migrated") return { kind: "already_completed", outcome: "migrated" };
    if (openReason === "started_fresh") return { kind: "already_completed", outcome: "fresh" };
    return failure("not_pending", "This install has no data to move.");
  }

  return {
    async boot() {
      await detect();
    },

    async startNative() {
      if (op !== null) return { kind: "migration_pending", message: PENDING_MESSAGE };
      if (openReason === null) await detect();
      // Re-read: the detection above may have opened the gate.
      return openReason === null || op !== null
        ? { kind: "migration_pending", message: PENDING_MESSAGE }
        : deps.startNative();
    },

    async status() {
      if (op !== null) return { kind: "in_progress", op: op.kind, progress: op.kind === "migrate" ? progress : null };
      if (openReason !== null) return { kind: "not_needed" };
      return toSharedStatus(await detect());
    },

    migrate() {
      return exclusive(
        "migrate",
        async (): Promise<RuntimeMigrationResult> => {
          await detection;
          if (openReason !== null) return alreadyOpen();
          progress = null;
          const result = await deps.migration.migrate({ signal: lifetime.signal, onProgress: publish });
          log.info(`[runtime:migration] move ended: ${result.kind}${result.kind === "failed" ? ` (${result.reason})` : ""}`);
          // `op` is still this move: clear it first so the gate may open. The
          // last event is replayed only to a caller joining a move in flight.
          op = null;
          progress = null;
          if (result.kind === "migrated" || (result.kind === "already_completed" && result.outcome === "migrated")) {
            open("migrated");
          } else if (result.kind === "already_completed") {
            open("started_fresh");
          } else if (result.kind === "failed" && result.reason === "not_pending") {
            // Nothing to move after all: the detection says what to do.
            await detect();
          }
          return toSharedResult(result);
        },
        busy,
      );
    },

    startFresh() {
      return exclusive(
        "start_fresh",
        async (): Promise<RuntimeMigrationStartFreshResult> => {
          await detection;
          if (openReason === "started_fresh") return { kind: "started_fresh" };
          if (openReason !== null) return failure("not_pending", "This install has no data to move.");
          const result = await deps.migration.startFresh({ signal: lifetime.signal });
          log.info(`[runtime:migration] start fresh ended: ${result.kind}${result.kind === "failed" ? ` (${result.reason})` : ""}`);
          op = null;
          if (result.kind === "started_fresh") open("started_fresh");
          return toSharedFresh(result);
        },
        busy,
      );
    },

    async removeOldData(input) {
      if (op !== null) return { kind: "refused", reason: "busy", message: "Another migration step is already running." };
      return toSharedRemove(
        await deps.migration.removeOldData({ signal: lifetime.signal, allowWithoutImport: input.allowWithoutImport }),
      );
    },

    lastProgress: () => progress,

    async shutdown() {
      lifetime.abort();
      const running = op?.result;
      if (running !== undefined) {
        log.info("[runtime:migration] quit: cancelling the operation in flight");
        await running;
      }
    },
  };
}

/* ---------------------------- production ----------------------------- */

/** Every progress event of a move, broadcast by `ipc/system/runtime-migration.ts`. */
export const runtimeMigrationProgressBus = new ReplayBus<RuntimeMigrationProgress>();

let production: NativeStartGate | null = null;

export function nativeStartGate(): NativeStartGate {
  production ??= createNativeStartGate({
    migration: productionMigration(),
    startNative: startNativeRuntime,
    publishProgress: (p) => runtimeMigrationProgressBus.emit(p),
  });
  return production;
}
