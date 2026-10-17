/**
 * Settings' two actions on the native runtime: RESTART and RESET LOCAL DATA
 * (plan 8.4). Both take the runtime's hold (`native-runtime.ts`), so no other
 * start can slip in between their stop and what follows it.
 *
 * WHEN THEY REFUSE. Outside the native runtime; while a start, a restart or a
 * reset runs, or a data migration holds the `localRuntime` critical op; while
 * the schema migration runs (`dbMigration`: the database must not vanish under
 * it); and while runtime-state.json records a migration that has not
 * completed, because that migration owns the cluster until it does (the boot
 * wiring does not even start the runtime then). The checks run before the
 * hold is taken and the critical-op ones again right after, so nothing that
 * began during the first await is overlooked.
 *
 * RESTART. Stop both servers (the progress returns to `idle`), then the
 * ordinary start, so the progress bus walks postgres -> model -> embeddings ->
 * ready and the Settings rows follow it. The start republishes the database
 * connection and the embeddings environment through the runtime host, the
 * only writer of `setDbConnection`; the main-process IPC pool retires itself
 * on that handoff. The engine's pool does not watch the handoff: it reads
 * VEX_DB_URL lazily and only recycles when a caller notices a different URL,
 * and its idle clients died with the old server. So once the start is usable
 * the engine's pool is recycled unconditionally (`reconnectEngineDb`). While
 * it runs the restart counts as a `localRuntime` critical op, so an update
 * cannot restart the app halfway through.
 *
 * RESET LOCAL DATA. Deletes the cluster (`pg18/`, and an initdb staging dir a
 * crash may have left) and clears its record in runtime-state.json (`pg`: the
 * system_identifier and last port). Wallets, the vault, the config and the
 * embeddings model are files elsewhere and are not touched; the migration's
 * record and `provider` stay, so a migrated install is not offered the
 * migration again. The next start finds no PG_VERSION, runs initdb and, with
 * `pg` null, bootstraps and records the NEW cluster's identity (D6) instead of
 * judging it against the old one. (Deleting pg18 alone would also do: the
 * supervisor drops a recorded identity when it has to create the cluster.
 * Clearing it here keeps the file honest if the app stops before that start.)
 *
 * Its guards, in order, and each one refuses before anything is deleted:
 *
 *   1. native mode;
 *   2. the data directory is exactly `<runtime dir>/pg18`, resolved through
 *      realpath, and is a real directory, not a link;
 *   3. runtime-state.json parses and records no unfinished migration;
 *   4. nothing else runs (above), and the hold is ours;
 *   5. the stop did not fail;
 *   6. no live process holds the data directory (postmaster.pid names a PID
 *      that is alive: the stop's own report is not taken on trust);
 *   7. guard 2 again, right before the delete, so a directory swapped for a
 *      link while the servers stopped is refused too.
 *
 * A refusal after the stop starts the runtime again. A successful reset keeps
 * the hold: the caller relaunches the app into setup, and nothing in this
 * process may start the runtime (and create a cluster) on its way out.
 */

import path from "node:path";
import type { Stats } from "node:fs";
import type {
  LocalRuntimeRefusal,
  NativeRuntimeStatus,
  RuntimeDirSize,
  RuntimeResetResult,
  RuntimeRestartResult,
} from "@shared/schemas/system.js";
import { CRITICAL_OP } from "../../updates/critical-ops.js";
import { pgDataDir, runtimeStatePath } from "../runtime-paths.js";
import { RuntimeStateCorruptError, type RuntimeState } from "../runtime-state.js";
import type { NativeRuntimeHold } from "./native-runtime.js";
import { parsePostmasterPid } from "./postgres-facts.js";

export interface LocalRuntimeMaintenanceDeps {
  readonly runtimeDir: string;
  readonly isNative: () => boolean;
  readonly acquireHold: () => NativeRuntimeHold | null;
  /** Labels of the critical ops in flight (`activeCriticalOps`). */
  readonly activeCriticalOps: () => readonly string[];
  /** Mark a `localRuntime` critical op; returns its end. */
  readonly beginLocalRuntimeOp: () => () => void;
  readonly currentStatus: () => NativeRuntimeStatus;
  /** Point the engine's pool at the connection the start published. */
  readonly reconnectEngineDb: () => Promise<boolean>;
  readonly readState: (file: string) => Promise<RuntimeState>;
  readonly writeState: (file: string, state: RuntimeState) => Promise<void>;
  readonly measure: (dir: string) => Promise<RuntimeDirSize>;
  readonly fs: {
    readonly lstat: (file: string) => Promise<Stats>;
    readonly realpath: (file: string) => Promise<string>;
    readonly readFile: (file: string) => Promise<string>;
    readonly rm: (file: string) => Promise<void>;
  };
  readonly processAlive: (pid: number) => boolean;
  readonly log: {
    readonly info: (line: string) => void;
    readonly warn: (line: string) => void;
    readonly error: (line: string) => void;
  };
}

export interface LocalRuntimeMaintenance {
  /** Joins a restart already in flight. */
  restart(): Promise<RuntimeRestartResult>;
  reset(): Promise<RuntimeResetResult>;
}

type Refused = Extract<RuntimeRestartResult, { kind: "refused" }>;

function refused(reason: LocalRuntimeRefusal, message: string): Refused {
  return { kind: "refused", reason, message };
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export function createLocalRuntimeMaintenance(deps: LocalRuntimeMaintenanceDeps): LocalRuntimeMaintenance {
  const statePath = runtimeStatePath(deps.runtimeDir);
  const dataDir = pgDataDir(deps.runtimeDir);
  let restarting: Promise<RuntimeRestartResult> | null = null;

  /** Busy for a reason the critical-op registry knows. */
  function busy(): Refused | null {
    const ops = deps.activeCriticalOps();
    if (ops.includes(CRITICAL_OP.localRuntime)) {
      return refused("busy", "The local runtime is busy: it is starting, or a data migration is running.");
    }
    if (ops.includes(CRITICAL_OP.dbMigration)) {
      return refused("busy", "The database is being updated. Try again when it finishes.");
    }
    return null;
  }

  /** The recorded state, or why it rules the action out. */
  async function checkState(): Promise<{ readonly state: RuntimeState } | Refused> {
    let state: RuntimeState;
    try {
      state = await deps.readState(statePath);
    } catch (error: unknown) {
      const detail = error instanceof RuntimeStateCorruptError ? error.message : String(error);
      deps.log.error(`[runtime:native] runtime state unreadable: ${detail}`);
      return refused("state_unreadable", "The runtime's state file could not be read, so nothing was changed.");
    }
    if (state.migration !== undefined && state.migration.step !== "completed") {
      return refused("migration_pending", "A data migration has not finished; finish it before changing the local runtime.");
    }
    return { state };
  }

  /** Take the hold once nothing else runs, or say why not. */
  function take(): NativeRuntimeHold | Refused {
    const before = busy();
    if (before !== null) return before;
    const hold = deps.acquireHold();
    if (hold === null) {
      return refused("busy", "The local runtime is already starting, restarting or being reset.");
    }
    const after = busy();
    if (after !== null) {
      hold.release();
      return after;
    }
    return hold;
  }

  async function runRestart(): Promise<RuntimeRestartResult> {
    if (!deps.isNative()) return refused("not_native", "Vex is not running its bundled local runtime.");
    const checked = await checkState();
    if ("kind" in checked) return checked;
    const hold = take();
    if ("kind" in hold) return hold;
    const end = deps.beginLocalRuntimeOp();
    try {
      deps.log.info("[runtime:native] restart requested from Settings");
      const stop = await hold.stop();
      if (stop.kind === "failed") {
        // Whatever is still up, the start below adopts or replaces it.
        deps.log.warn(`[runtime:native] restart: stop failed (${stop.message}); starting anyway`);
      }
      const start = await hold.start();
      if (start.kind !== "running" && start.kind !== "reused") {
        deps.log.error(`[runtime:native] restart: start ${start.kind}: ${start.message}`);
        return { kind: "failed", message: start.message, status: deps.currentStatus() };
      }
      const reconnected = await deps.reconnectEngineDb();
      deps.log.info(`[runtime:native] restart complete; engine database ${reconnected ? "reconnected" : "not reconnected"}`);
      return { kind: "restarted", status: deps.currentStatus() };
    } finally {
      hold.release();
      end();
    }
  }

  /** Guard 2/7: the data directory is `<runtime dir>/pg18` itself, a real directory or absent. */
  async function checkDataDir(): Promise<{ readonly exists: boolean } | Refused> {
    const unsafe = (why: string): Refused => {
      deps.log.error(`[runtime:native] reset refused: ${dataDir} ${why}`);
      return refused("path_unsafe", "The local database folder is not where Vex keeps it, so nothing was deleted.");
    };
    if (!path.isAbsolute(deps.runtimeDir) || path.basename(dataDir) !== "pg18" || path.dirname(dataDir) !== deps.runtimeDir) {
      return unsafe("is not <runtime dir>/pg18");
    }
    let stat: Stats;
    try {
      stat = await deps.fs.lstat(dataDir);
    } catch (error: unknown) {
      if (errnoCode(error) === "ENOENT") return { exists: false };
      return unsafe(`could not be inspected (${String(error)})`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return unsafe("is not a real directory");
    try {
      const [realRuntime, realData] = await Promise.all([deps.fs.realpath(deps.runtimeDir), deps.fs.realpath(dataDir)]);
      if (realData !== path.join(realRuntime, "pg18")) return unsafe(`resolves to ${realData}, outside ${realRuntime}`);
    } catch (error: unknown) {
      return unsafe(`could not be resolved (${String(error)})`);
    }
    return { exists: true };
  }

  /** Guard 6: the PID postmaster.pid names, when that process is alive. */
  async function livePostmaster(): Promise<number | null> {
    let text: string;
    try {
      text = await deps.fs.readFile(path.join(dataDir, "postmaster.pid"));
    } catch {
      return null;
    }
    const pid = parsePostmasterPid(text)?.pid;
    return pid !== undefined && deps.processAlive(pid) ? pid : null;
  }

  async function runReset(): Promise<RuntimeResetResult> {
    if (!deps.isNative()) return refused("not_native", "Vex is not running its bundled local runtime.");
    const where = await checkDataDir();
    if ("kind" in where) return where;
    const checked = await checkState();
    if ("kind" in checked) return checked;
    const hold = take();
    if ("kind" in hold) return hold;
    const end = deps.beginLocalRuntimeOp();
    let keepHold = false;
    try {
      deps.log.info("[runtime:native] reset of local data requested from Settings");
      const stop = await hold.stop();
      if (stop.kind === "failed") {
        deps.log.error(`[runtime:native] reset refused: the runtime did not stop (${stop.message})`);
        void hold.start();
        return refused("still_running", "The local database did not stop, so nothing was deleted.");
      }
      const pid = await livePostmaster();
      if (pid !== null) {
        deps.log.error(`[runtime:native] reset refused: postmaster pid=${String(pid)} still holds ${dataDir}`);
        void hold.start();
        return refused("still_running", "A database process still holds the local data, so nothing was deleted.");
      }
      const again = await checkDataDir();
      if ("kind" in again) {
        void hold.start();
        return again;
      }

      const size = again.exists ? await deps.measure(dataDir) : { bytes: 0, files: 0, complete: true };
      try {
        if (again.exists) await deps.fs.rm(dataDir);
        await deps.fs.rm(`${dataDir}.initdb`);
        const identity = checked.state.pg?.systemIdentifier ?? "none";
        // Re-read, so a field written since the check (or by a newer build) is kept.
        await deps.writeState(statePath, { ...(await deps.readState(statePath)), pg: null });
        deps.log.info(
          `[runtime:native] reset local data: deleted ${dataDir} (${size.complete ? "" : "at least "}` +
            `${String(size.bytes)} bytes in ${String(size.files)} files) and cleared the cluster record ` +
            `(system_identifier=${identity}); ` +
            "kept wallets, the vault, the config and the embeddings model",
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.error(`[runtime:native] reset failed while deleting ${dataDir}: ${message}`);
        void hold.start();
        return { kind: "failed", message: `The local data could not be deleted: ${message}` };
      }
      keepHold = true;
      return { kind: "reset", deletedBytes: size.bytes, relaunching: true };
    } finally {
      if (!keepHold) hold.release();
      end();
    }
  }

  return {
    restart() {
      restarting ??= runRestart().finally(() => {
        restarting = null;
      });
      return restarting;
    },
    reset: () => runReset(),
  };
}
