/**
 * vex.database.* — Postgres migration IPC surface (M6).
 *
 * `migrate()` runs `runMigrationsForIpc()` from `../database/migrate-runner.ts`
 * with single-flight deduplication so React StrictMode dev double-mount
 * + concurrent renderer invokes share one underlying migrate run.
 *
 * Failure surface: `kind: "failed"` from the runner is mapped to
 * `err({ code: "data.migration_failed", details: { failedAt } })` —
 * NOT to a success kind. Two error channels would split renderer
 * branching logic and break `Result<T, VexError>` semantics
 * (codex turn 1 RED #1).
 */

import { CH, EV } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  migrateInputSchema,
  migrateResultSchema,
  type MigrateResult,
} from "@shared/schemas/database.js";
import { migrationProgressBus } from "../database/progress-bus.js";
import {
  runMigrationsForIpc,
  type MigrateRunResult,
} from "../database/migrate-runner.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { CRITICAL_OP, trackCriticalOp } from "../updates/critical-ops.js";
import { log } from "../logger/index.js";
import { ensureEmbeddingDefaults } from "../onboarding/ensure-embedding-defaults.js";
import { startNativeRuntime } from "../runtime/native/native-runtime.js";
import { getRuntimeMode } from "../runtime/runtime-mode.js";
import { registerHandler } from "./register-handler.js";

/**
 * Native mode: main started the runtime at boot; join that start (or retry a
 * failed one) before migrating, and report the runtime's own reason when it
 * is not usable instead of a missing-connection failure.
 */
async function migrateOnNativeRuntime(): Promise<MigrateRunResult> {
  const started = await startNativeRuntime();
  if (started.kind !== "running" && started.kind !== "reused") {
    return { kind: "failed", message: `The local database could not start: ${started.message}`, failedAt: null };
  }
  return runMigrationsForIpc();
}

const PROGRESS_CHANNEL = EV.database.migrateProgress;

function broadcastMigrationProgress(): () => void {
  return migrationProgressBus.subscribe((payload) =>
    broadcastToAllWindows(PROGRESS_CHANNEL, payload)
  );
}

function mapToResult(
  runResult: MigrateRunResult,
  correlationId: string
): Result<MigrateResult> {
  if (runResult.kind === "applied") {
    return ok({
      kind: "applied",
      applied: runResult.applied,
      files: runResult.files,
      message: runResult.message,
    });
  }
  if (runResult.kind === "noop") {
    return ok({ kind: "noop", message: runResult.message });
  }
  // kind === "failed"
  const details =
    runResult.failedAt !== null
      ? {
          failedAt: {
            version: runResult.failedAt.version,
            file: runResult.failedAt.file,
          },
        }
      : undefined;
  return err({
    code: "data.migration_failed",
    domain: "database",
    message: runResult.message,
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
    ...(details !== undefined ? { details } : {}),
  });
}

export function registerDatabaseHandlers(): Array<() => void> {
  const teardowns: Array<() => void> = [];

  // Single-flight dedup. Migrate has no input variation so a simple
  // promise reference is enough — joiners share the same in-flight run.
  // Cleared in `finally` for both success AND failure so Retry after a
  // failed attempt creates a fresh run (codex turn 1 answer B).
  let migrateInFlight: Promise<MigrateRunResult> | null = null;

  teardowns.push(
    registerHandler({
      channel: CH.database.migrate,
      domain: "database",
      inputSchema: migrateInputSchema,
      outputSchema: migrateResultSchema,
      handle: trackCriticalOp(
        CRITICAL_OP.dbMigration,
        async (_input, ctx): Promise<Result<MigrateResult>> => {
        let run: Promise<MigrateRunResult>;
        if (migrateInFlight !== null) {
          log.info(
            `[ipc:vex:database:migrate] joining in-flight invocation correlationId=${ctx.requestId}`
          );
          // Replay the latest progress event directly to THIS renderer.
          // The broadcast subscriber only forwards FUTURE bus events;
          // a late-joining caller would otherwise miss the planned /
          // index / total handshake the in-flight run already emitted
          // (codex turn 2 should-fix #4).
          const lastProgress = migrationProgressBus.peek();
          if (lastProgress !== null && !ctx.event.sender.isDestroyed()) {
            ctx.event.sender.send(PROGRESS_CHANNEL, lastProgress);
          }
          run = migrateInFlight;
        } else {
          log.info(
            `[ipc:vex:database:migrate] starting correlationId=${ctx.requestId}`
          );
          run = getRuntimeMode() === "native" ? migrateOnNativeRuntime() : runMigrationsForIpc();
          migrateInFlight = run;
        }

        try {
          const runResult = await run;
          const result = mapToResult(runResult, ctx.requestId);
          // M11.5.4 — seed bundled defaults for the
          // EMBEDDING_* env keys are seeded ONLY when every key is
          // absent (preserve-first), so a partial user override is
          // never clobbered. We run post-migrate because the writer
          // needs `knowledge_entries` to exist for any future
          // dim-related logic; failure here is non-fatal — migrate's
          // own Result is what the wizard branches on.
          if (
            result.ok &&
            (runResult.kind === "applied" || runResult.kind === "noop")
          ) {
            try {
              const seed = await ensureEmbeddingDefaults();
              log.info(
                `[ipc:vex:database:migrate] ensureEmbeddingDefaults kind=${seed.kind} keys=${seed.writtenKeys.length}`
              );
            } catch (cause) {
              log.warn(
                "[ipc:vex:database:migrate] ensureEmbeddingDefaults failed (non-fatal)",
                cause
              );
            }
          }
          return result;
        } finally {
          if (migrateInFlight === run) {
            migrateInFlight = null;
          }
        }
      },
      ),
    })
  );

  teardowns.push(broadcastMigrationProgress());

  return teardowns;
}
