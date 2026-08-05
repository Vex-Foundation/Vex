/**
 * Main-side migration runner. Owns the per-run `pg.Pool` lifecycle —
 * a dedicated single-connection pool is created for each migrate call
 * and torn down via `pool.end()` on completion (no cross-call pool
 * caching: the engine's `getPool()` lives in a different module and we
 * deliberately don't share a global pool with it).
 *
 * Returns a discriminated `MigrateRunResult` that the IPC handler maps:
 *   - `applied | noop` → `ok({...})`
 *   - `failed`         → `err({ code: "data.migration_failed", details: { failedAt } })`
 */

import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  MigrationError,
  runMigrationsWithProgress,
  type MigrationProgressEvent,
} from "@vex-lib/db/migrate-runner.js";
import { log } from "../logger/index.js";
import { buildPoolConfig } from "./db-config.js";
import { markMigrationsApplied } from "./migrations-applied.js";
import { migrationProgressBus } from "./progress-bus.js";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type MigrateRunResult =
  | {
      readonly kind: "applied";
      readonly applied: number;
      readonly files: ReadonlyArray<string>;
      readonly message: string;
    }
  | {
      readonly kind: "noop";
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly failedAt: { readonly version: number; readonly file: string } | null;
    };

function resolveMigrationsDir(): string {
  // Packaged: electron-builder copies resources/migrations → process.resourcesPath/migrations
  // Dev: import.meta.dirname is `vex-app/dist/main/` after bundling (vite outputs a single
  //      main.js containing every imported module, so __dirname collapses to the bundle dir).
  return app.isPackaged
    ? path.join(process.resourcesPath, "migrations")
    : path.resolve(__dirname, "../../resources/migrations");
}

export async function runMigrationsForIpc(): Promise<MigrateRunResult> {
  // Reset the bus at the start of EVERY fresh run — including the
  // no-config failure path below — so a subsequent successful retry
  // doesn't see stale `applied 14/15` left over from a prior attempt
  // (codex turn 2 should-fix #3).
  migrationProgressBus.reset();

  const config = await buildPoolConfig();
  if (config === null) {
    return {
      kind: "failed",
      message:
        "Database connection is not available. Compose bootstrap must complete first.",
      failedAt: null,
    };
  }

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 1,
    idleTimeoutMillis: 1_000,
  });
  pool.on("error", (err) => {
    log.error(`[ipc:vex:database:migrate] pool error: ${err.message}`);
  });

  const startedAt = Date.now();
  try {
    const result = await runMigrationsWithProgress({
      pool,
      migrationsDir: resolveMigrationsDir(),
      onProgress: (event: MigrationProgressEvent) => {
        migrationProgressBus.emit({ ...event, ts: Date.now() });
      },
    });

    log.info(
      `[ipc:vex:database:migrate] completed applied=${result.applied} elapsed=${Date.now() - startedAt}ms`
    );
    // The engine workers' start gate. Both outcomes below mean the schema is at
    // the version this build ships, so this is marked before either returns —
    // a FAILED run falls through to the catch and marks nothing.
    markMigrationsApplied();

    if (result.applied === 0) {
      return {
        kind: "noop",
        message: "All migrations are already applied.",
      };
    }
    return {
      kind: "applied",
      applied: result.applied,
      files: result.files,
      message: `Applied ${result.applied} migration${result.applied === 1 ? "" : "s"}.`,
    };
  } catch (err: unknown) {
    if (err instanceof MigrationError) {
      const causeMsg =
        err.cause instanceof Error ? err.cause.message : String(err.cause);
      log.error(
        `[ipc:vex:database:migrate] failed at ${err.file} (v${err.version}): ${causeMsg}`
      );
      return {
        kind: "failed",
        message: `Migration ${err.file} failed: ${causeMsg}`,
        failedAt: { version: err.version, file: err.file },
      };
    }
    const message = err instanceof Error ? err.message : "unknown error";
    log.error(`[ipc:vex:database:migrate] unexpected error: ${message}`);
    return {
      kind: "failed",
      message,
      failedAt: null,
    };
  } finally {
    try {
      await pool.end();
    } catch {
      /* best-effort; pool may have failed mid-init */
    }
  }
}
