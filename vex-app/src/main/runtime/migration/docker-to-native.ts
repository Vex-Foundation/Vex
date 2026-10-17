/**
 * Moves an existing install's data from the previous release's Docker
 * Postgres volume into the bundled native cluster, once (plan section 10, D11).
 *
 * There is no fallback: from the native release the app does not run on
 * Docker, so this migration must never be the reason data is lost. The rules,
 * and where each is enforced:
 *
 *   - The Docker volume is only READ, by `pg_dump` over TCP with the bundled
 *     client. Nothing here writes to it, `compose stop` is the strongest
 *     command the migration runs against it, and `down --volumes` exists only
 *     in `removeOldData`, which refuses unless a migration completed.
 *   - The native cluster is trusted only after VERIFY (`database-facts.ts`):
 *     same schema_version, every table's exact row count and row digest, every
 *     vector byte-equal, sequences, indexes, constraints. Only then is
 *     `provider` flipped to native.
 *   - Resumable by step. runtime-state.json records the last step that
 *     COMPLETED (`migration.step`), written only after that step's output is
 *     durable, so a crash, quit or update at any point resumes there:
 *
 *       started   the migration is bound to this install id; the native
 *                 cluster, if any, belongs to it
 *       dumped    vex.dump (fsynced, sha256 recorded) and the facts of the
 *                 snapshot it was taken from (source-facts.json) are on disk;
 *                 Docker is no longer needed except for the final stop
 *       restored  pg_restore --single-transaction committed into a fresh cluster
 *       verified  the cluster matched every fact
 *       completed provider = native, the old stack stopped (best effort)
 *
 *     Resuming at `dumped` discards whatever cluster a crashed restore left and
 *     restores again; `restored` re-verifies; `verified` only finishes.
 *   - A FAILURE drops what the migration made (the native cluster and the
 *     dump), leaves the volume untouched, and returns the install to `started`
 *     with the reason recorded, so Retry starts clean. A CANCEL (quit) keeps
 *     the durable steps for the next launch.
 *   - While a migration is in progress it owns the native cluster: nothing
 *     else may start the native runtime until `detect()` stops saying pending
 *     (the boot wiring's job; this module never starts it on its own).
 *
 * Wallet keystores are files in CONFIG_DIR, not rows, so none of this touches
 * keys.
 */

import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DbConnection } from "../../database/connection-state.js";
import { AbortError, isAbortError } from "../../ipc/cancel-helpers.js";
import { log } from "../../logger/index.js";
import { beginCriticalOp, CRITICAL_OP } from "../../updates/critical-ops.js";
import { buildRenderDeps } from "../../compose/deps-factory.js";
import { readInstallId, renderedComposePath } from "../../compose/render.js";
import { CONFIG_DIR } from "../../paths/config-dir.js";
import {
  createPostgresSupervisor,
  postgresChildEnv,
  runPgTool,
  type PgRunTool,
  type PgToolResult,
  type PostgresSupervisor,
} from "../native/postgres-supervisor.js";
import { parsePostmasterPid } from "../native/postgres-facts.js";
import {
  locatePostgresBinaries,
  locatePostgresClientTools,
  migrationDir,
  pgDataDir,
  RUNTIME_DIR,
  runtimeStatePath,
  type PostgresClientToolsLocation,
} from "../runtime-paths.js";
import { getPgPassword } from "../secrets/pg-password.js";
import { productionPgPasswordDeps } from "../secrets/production-deps.js";
import {
  readRuntimeState,
  RuntimeStateCorruptError,
  writeRuntimeState,
  type MigrationFailureRecord,
  type MigrationState,
  type MigrationStep,
  type RuntimeState,
} from "../runtime-state.js";
import {
  compareDatabaseFacts,
  databaseFactsSchema,
  pgDatabaseFactsReader,
  type DatabaseFacts,
  type DatabaseFactsReader,
  type SourceSnapshot,
  type VerifyReport,
} from "./database-facts.js";
import { createDockerSource, type DockerSource } from "./docker-source.js";

/* ------------------------------------------------------------------ *
 * The API the setup flow and Settings call.
 * ------------------------------------------------------------------ */

export type DockerMigrationStatus =
  | {
      readonly kind: "not_needed";
      readonly reason: "native_install" | "migrated" | "started_fresh" | "no_docker_install" | "no_docker_volume";
    }
  /** Blocking: the app may not open until the user migrates or starts fresh. */
  | {
      readonly kind: "pending";
      readonly installId: string;
      /** The last completed step of an earlier attempt; null when none began. */
      readonly resumeStep: Exclude<MigrationStep, "completed"> | null;
      readonly lastFailure: MigrationFailureRecord | null;
    }
  /** Pending, and Docker does not answer: start it once, or start fresh. */
  | {
      readonly kind: "pending_docker_unavailable";
      readonly installId: string;
      readonly detail: string;
      readonly resumeStep: Exclude<MigrationStep, "completed"> | null;
      readonly lastFailure: MigrationFailureRecord | null;
    }
  /** runtime-state.json does not parse or cannot be read; it was left untouched. */
  | { readonly kind: "state_unreadable"; readonly message: string };

export type MigrationPhase = "preparing" | "starting_source" | "dumping" | "restoring" | "verifying" | "finishing";

export type MigrationProgress =
  | { readonly phase: "dumping"; readonly bytesWritten: number; readonly estimatedBytes: number }
  | { readonly phase: Exclude<MigrationPhase, "dumping"> };

export type MigrationFailureKind =
  /** Docker is not installed, not running, or not a local engine. */
  | "docker_unavailable"
  /** This install's Postgres volume does not exist. */
  | "no_docker_volume"
  /** The old database did not come up or did not answer as this install's. */
  | "source_unavailable"
  /** The old database has no schema_version: setup never finished there. */
  | "source_empty"
  | "disk_full"
  | "dump_failed"
  /** The dump or its facts changed on disk between steps. */
  | "dump_corrupt"
  /** The bundled Postgres tree is missing (packaging or dev build). */
  | "native_unavailable"
  | "native_start_failed"
  /** A postmaster nobody could stop still holds the native data dir. */
  | "native_cluster_busy"
  | "restore_failed"
  | "verify_failed"
  | "state_unreadable"
  /** Another migration operation is running. */
  | "busy"
  /** Nothing to migrate: native already, or no Docker install. */
  | "not_pending"
  | "unexpected";

export interface MigrationFailed {
  readonly kind: "failed";
  readonly reason: MigrationFailureKind;
  readonly message: string;
  /** The verify report, for the failure screen and a support bundle. */
  readonly report: VerifyReport | null;
  readonly requiredBytes: number | null;
  readonly availableBytes: number | null;
}

export type MigrateResult =
  | {
      readonly kind: "migrated";
      /** null when this run resumed after verification already passed. */
      readonly report: VerifyReport | null;
      readonly oldStackStopped: boolean;
      readonly message: string;
    }
  | { readonly kind: "already_completed"; readonly outcome: "migrated" | "fresh" }
  /** Aborted (quit): the durable steps are kept and the next launch resumes. */
  | { readonly kind: "cancelled"; readonly resumeStep: MigrationStep }
  | MigrationFailed;

export type StartFreshResult = { readonly kind: "started_fresh" } | MigrationFailed;

export type RemoveOldDataResult =
  | { readonly kind: "removed"; readonly message: string }
  | {
      readonly kind: "refused";
      /** No completed migration, or the user started fresh and did not acknowledge it. */
      readonly reason: "not_completed" | "not_imported" | "install_changed" | "busy";
      readonly message: string;
    }
  | { readonly kind: "failed"; readonly reason: "docker_unavailable" | "failed"; readonly message: string };

export interface DockerMigration {
  /** Never starts Docker; answers from runtime-state alone when it can. */
  detect(options?: { readonly signal?: AbortSignal }): Promise<DockerMigrationStatus>;
  /** Start or resume. Joins a migration already in flight. Never rejects. */
  migrate(options?: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MigrationProgress) => void;
  }): Promise<MigrateResult>;
  /** A fresh native cluster in place of the migration; the volume is kept. */
  startFresh(options?: { readonly signal?: AbortSignal }): Promise<StartFreshResult>;
  /**
   * `compose down --volumes` for this install's project only. Refuses unless
   * a migration completed; after "start fresh" also unless
   * `allowWithoutImport` (the volume is then the only copy of that history).
   */
  removeOldData(options?: {
    readonly signal?: AbortSignal;
    readonly allowWithoutImport?: boolean;
  }): Promise<RemoveOldDataResult>;
}

/* ------------------------------------------------------------------ *
 * Seams. Production passes the defaults (createProductionDockerMigration).
 * ------------------------------------------------------------------ */

export interface DockerMigrationDeps {
  readonly configDir: string;
  readonly runtimeDir: string;
  readonly source: DockerSource;
  readonly locateClientTools: () => Promise<PostgresClientToolsLocation>;
  /** A supervisor for the cluster under `runtimeDir`, or why there is none. */
  readonly createSupervisor: () => Promise<PostgresSupervisor | { readonly unavailable: string }>;
  readonly runTool: PgRunTool;
  readonly facts?: DatabaseFactsReader;
  readonly platform?: NodeJS.Platform;
  readonly freeBytes?: (dir: string) => Promise<number>;
  readonly processAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

const DUMP_FILE = "vex.dump";
const FACTS_FILE = "source-facts.json";
const REPORT_FILE = "verify-report.json";
const PGPASS_FILE = ".pgpass";
/** Beyond twice the database size: the dump, then the restored cluster. */
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 6 * 60 * 60_000;
const DUMP_PROGRESS_MS = 500;
const SOURCE_STOP_BUDGET_MS = 30_000;
const STDERR_TAIL_LINES = 6;

class MigrationFailure extends Error {
  constructor(
    readonly reason: MigrationFailureKind,
    message: string,
    readonly extra: {
      readonly report?: VerifyReport;
      readonly requiredBytes?: number;
      readonly availableBytes?: number;
    } = {},
  ) {
    super(message);
    this.name = "MigrationFailure";
  }
}

function failed(failure: MigrationFailure): MigrationFailed {
  return {
    kind: "failed",
    reason: failure.reason,
    message: failure.message,
    report: failure.extra.report ?? null,
    requiredBytes: failure.extra.requiredBytes ?? null,
    availableBytes: failure.extra.availableBytes ?? null,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stderrTail(text: string): string {
  return text.trim().split("\n").slice(-STDERR_TAIL_LINES).join(" | ");
}

const DISK_FULL_RE = /no space left on device|could not extend file|disk full/i;

const storedFactsSchema = z.object({ dumpSha256: z.string(), facts: databaseFactsSchema });

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function readTextOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hashFile(file: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** POSIX only; Windows cannot open a directory for fsync. */
async function fsyncDir(dir: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  const handle = await fs.open(dir, "r").catch(() => null);
  if (handle === null) return;
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(file: string, value: unknown, platform: NodeJS.Platform): Promise<void> {
  const temp = `${file}.tmp-${String(process.pid)}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsyncFile(temp);
  await fs.rename(temp, file);
  await fsyncDir(path.dirname(file), platform);
}

function pgpassField(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await fs.statfs(dir);
  return s.bavail * s.bsize;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/* ------------------------------------------------------------------ *
 * The engine.
 * ------------------------------------------------------------------ */

export function createDockerMigration(deps: DockerMigrationDeps): DockerMigration {
  const platform = deps.platform ?? process.platform;
  const facts = deps.facts ?? pgDatabaseFactsReader;
  const freeBytes = deps.freeBytes ?? defaultFreeBytes;
  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const now = deps.now ?? ((): Date => new Date());
  const statePath = runtimeStatePath(deps.runtimeDir);
  const dataDir = pgDataDir(deps.runtimeDir);
  const workDir = migrationDir(deps.runtimeDir);
  const dumpPath = path.join(workDir, DUMP_FILE);
  const partialDumpPath = `${dumpPath}.partial`;
  const factsPath = path.join(workDir, FACTS_FILE);
  const reportPath = path.join(workDir, REPORT_FILE);
  const pgpassPath = path.join(workDir, PGPASS_FILE);

  let inFlight: { readonly op: "migrate" | "fresh" | "remove"; readonly promise: Promise<unknown> } | null = null;

  /* ---------------------------- state ----------------------------- */

  async function updateState(change: (state: RuntimeState) => RuntimeState): Promise<RuntimeState> {
    const next = change(await readRuntimeState(statePath));
    await writeRuntimeState(statePath, next);
    return next;
  }

  async function updateMigration(patch: Partial<MigrationState>): Promise<MigrationState> {
    const next = await updateState((state) => {
      if (state.migration === undefined) throw new MigrationFailure("unexpected", "The migration record disappeared.");
      return { ...state, migration: { ...state.migration, ...patch, updatedAt: now().toISOString() } };
    });
    // Present: the closure above threw otherwise.
    return next.migration as MigrationState;
  }

  /* ----------------------- one run's context ---------------------- */

  interface Run {
    readonly signal: AbortSignal | undefined;
    progress(p: MigrationProgress): void;
    supervisor(): Promise<PostgresSupervisor>;
    /** Our postmaster, started by this run; null when none is. */
    running: DbConnection | null;
    sourceStarted: boolean;
  }

  function newRun(signal: AbortSignal | undefined, onProgress?: (p: MigrationProgress) => void): Run {
    let supervisor: PostgresSupervisor | null = null;
    return {
      signal,
      progress(p) {
        try {
          onProgress?.(p);
        } catch {
          // An observer must not break the migration.
        }
      },
      async supervisor() {
        if (supervisor !== null) return supervisor;
        const created = await deps.createSupervisor();
        if ("unavailable" in created) throw new MigrationFailure("native_unavailable", created.unavailable);
        supervisor = created;
        return created;
      },
      running: null,
      sourceStarted: false,
    };
  }

  function throwIfAborted(run: Run): void {
    if (run.signal?.aborted === true) throw new AbortError("migration cancelled");
  }

  async function startNative(run: Run): Promise<DbConnection> {
    if (run.running !== null) return run.running;
    const supervisor = await run.supervisor();
    const started = await supervisor.start(run.signal);
    if (started.connection === null) {
      throw new MigrationFailure(
        started.kind === "disk_full" ? "disk_full" : "native_start_failed",
        `The built-in database did not start: ${started.message}`,
      );
    }
    run.running = started.connection;
    return started.connection;
  }

  async function stopNative(run: Run): Promise<void> {
    if (run.running === null) return;
    const supervisor = await run.supervisor();
    const stopped = await supervisor.stop();
    if (stopped.kind === "failed") log.warn(`[runtime:migration] stopping the built-in database: ${stopped.message}`);
    run.running = null;
  }

  async function readSecret(file: string): Promise<string> {
    const value = (await fs.readFile(file, "utf8")).trim();
    if (value.length === 0) throw new MigrationFailure("unexpected", `This install's database password file is empty (${file}).`);
    return value;
  }

  /** The tools' environment: nothing of main's, and the password by file, never argv or env. */
  async function toolEnv(port: number, password: string): Promise<Record<string, string>> {
    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(pgpassPath, `127.0.0.1:${String(port)}:vex:vex:${pgpassField(password)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { ...postgresChildEnv(platform), PGPASSFILE: pgpassPath, PGCONNECT_TIMEOUT: "10" };
  }

  async function removeWorkFiles(): Promise<void> {
    for (const file of [dumpPath, partialDumpPath, factsPath, reportPath, pgpassPath]) {
      await fs.rm(file, { force: true });
    }
  }

  /** A postmaster.pid naming a live process, or null. */
  async function livePostmasterPid(): Promise<number | null> {
    const text = await readTextOrNull(path.join(dataDir, "postmaster.pid"));
    const parsed = text === null ? null : parsePostmasterPid(text);
    return parsed !== null && processAlive(parsed.pid) ? parsed.pid : null;
  }

  /**
   * Drop the native cluster the migration made. Only ever called while the
   * record says the migration is in progress, which is what makes the
   * cluster the migration's to drop: `begin` set aside anything that was
   * there before, and nothing else may run on it meanwhile.
   */
  async function discardNativeCluster(run: Run): Promise<void> {
    const state = await readRuntimeState(statePath);
    if (state.migration === undefined || state.migration.step === "completed") {
      throw new MigrationFailure("unexpected", "Refusing to drop a built-in database the migration does not own.");
    }
    await stopNative(run);
    if ((await livePostmasterPid()) !== null) {
      // An orphan of a crashed session: the supervisor's boot reaper stops a
      // postgres whose working directory is this data dir.
      const supervisor = await run.supervisor();
      await supervisor.start(run.signal).catch((error: unknown) => {
        if (isAbortError(error)) throw error;
      });
      await supervisor.stop();
      const still = await livePostmasterPid();
      if (still !== null) {
        throw new MigrationFailure(
          "native_cluster_busy",
          `A database server (pid ${String(still)}) still holds ${dataDir}; quit it and retry.`,
        );
      }
    }
    await fs.rm(`${dataDir}.initdb`, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
    // Re-read: reaping may have started (and recorded) the cluster meanwhile.
    await updateState((s) => (s.pg === null ? s : { ...s, pg: null }));
  }

  /**
   * A data dir with no recorded cluster predates the migration (a dev run, a
   * deleted state file). It is not ours to drop and not safe to reuse: moved
   * aside, never deleted.
   */
  async function setAsideUnclaimedCluster(): Promise<void> {
    await fs.rm(`${dataDir}.initdb`, { recursive: true, force: true });
    if (!(await exists(dataDir))) return;
    const pid = await livePostmasterPid();
    if (pid !== null) {
      throw new MigrationFailure("native_cluster_busy", `A database server (pid ${String(pid)}) is running on ${dataDir}.`);
    }
    const aside = `${dataDir}.set-aside-${now().toISOString().replaceAll(/[:.]/g, "-")}`;
    log.warn(`[runtime:migration] moving an unrecorded data dir aside: ${aside}`);
    await fs.rename(dataDir, aside);
  }

  /** Bind the migration to this install. Refuses an install that is native already. */
  async function begin(): Promise<MigrationState> {
    const state = await readRuntimeState(statePath);
    if (state.migration !== undefined) return state.migration;
    if (state.pg !== null || state.provider === "native") {
      throw new MigrationFailure("not_pending", "This install already runs on the built-in database.");
    }
    const installId = await readInstallId(deps.configDir);
    if (installId === null) throw new MigrationFailure("not_pending", "This install never ran the Docker stack.");
    // A volume Docker says is not there means there is nothing to migrate; a
    // record written now would turn a new install into a pending one. Docker
    // not answering is not that answer: the migration starts it.
    if ((await deps.source.probe(installId)).kind === "volume_absent") {
      throw new MigrationFailure("not_pending", "This install's Docker database volume does not exist.");
    }
    await setAsideUnclaimedCluster();
    const at = now().toISOString();
    const migration: MigrationState = {
      installId,
      step: "started",
      outcome: null,
      dump: null,
      attempts: 0,
      lastFailure: null,
      oldStackStopped: null,
      startedAt: at,
      updatedAt: at,
    };
    await updateState((s) => ({ ...s, migration }));
    log.info(`[runtime:migration] started for install ${installId}`);
    return migration;
  }

  /* ---------------------------- steps ----------------------------- */

  async function dumpStep(run: Run, migration: MigrationState, pgDump: string): Promise<void> {
    run.progress({ phase: "starting_source" });
    run.sourceStarted = true;
    const up = await deps.source.bringUpDb(migration.installId, {
      ...(run.signal !== undefined ? { signal: run.signal } : {}),
      onLogLine: (_stream, line) => log.info(`[runtime:migration] ${line}`),
    });
    throwIfAborted(run);
    if (up.kind === "docker_unavailable") throw new MigrationFailure("docker_unavailable", up.message);
    if (up.kind === "no_volume") throw new MigrationFailure("no_docker_volume", up.message);
    if (up.kind === "failed") throw new MigrationFailure("source_unavailable", up.message);
    const password = await readSecret(up.passwordPath);

    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
    await removeWorkFiles();
    let snapshot: SourceSnapshot;
    try {
      snapshot = await facts.openSource({ port: up.pgPort, password });
    } catch (error: unknown) {
      throw new MigrationFailure("source_unavailable", `The old database did not answer: ${messageOf(error)}`);
    }

    let sourceFacts: DatabaseFacts;
    try {
      const required = snapshot.databaseBytes * 2 + DISK_MARGIN_BYTES;
      const available = await freeBytes(workDir);
      if (available < required) {
        throw new MigrationFailure(
          "disk_full",
          `Copying the data needs ${String(required)} bytes free; ${String(available)} are.`,
          { requiredBytes: required, availableBytes: available },
        );
      }
      run.progress({ phase: "dumping", bytesWritten: 0, estimatedBytes: snapshot.databaseBytes });
      const env = await toolEnv(up.pgPort, password);
      const abortDump = new AbortController();
      const onAbort = (): void => abortDump.abort();
      run.signal?.addEventListener("abort", onAbort, { once: true });
      const estimated = snapshot.databaseBytes;
      const timer = setInterval(() => {
        void fs.stat(partialDumpPath).then(
          (s) => run.progress({ phase: "dumping", bytesWritten: s.size, estimatedBytes: estimated }),
          () => {},
        );
      }, DUMP_PROGRESS_MS);
      try {
        log.info(`[runtime:migration] pg_dump from 127.0.0.1:${String(up.pgPort)} (${String(estimated)} bytes live)`);
        const dump = deps.runTool(
          pgDump,
          [
            "-h", "127.0.0.1", "-p", String(up.pgPort), "-U", "vex", "-d", "vex", "--no-password",
            "-Fc", `--snapshot=${snapshot.snapshotId}`, "-f", partialDumpPath,
          ],
          { env, timeoutMs: TOOL_TIMEOUT_MS, signal: abortDump.signal },
        );
        try {
          sourceFacts = await snapshot.readFacts();
        } catch (error: unknown) {
          abortDump.abort();
          await dump;
          throwIfAborted(run);
          throw new MigrationFailure("source_unavailable", `Reading the old database failed: ${messageOf(error)}`);
        }
        const result = await dump;
        throwIfAborted(run);
        if (result.code !== 0) {
          const tail = stderrTail(result.stderr);
          throw new MigrationFailure(DISK_FULL_RE.test(result.stderr) ? "disk_full" : "dump_failed", `pg_dump failed: ${tail}`);
        }
      } finally {
        clearInterval(timer);
        run.signal?.removeEventListener("abort", onAbort);
        await fs.rm(pgpassPath, { force: true });
      }
    } finally {
      await snapshot.close();
    }

    if (sourceFacts.schemaVersion === null) {
      throw new MigrationFailure("source_empty", "The old database has no schema_version: Vex setup never finished there.");
    }
    await fsyncFile(partialDumpPath);
    const { sha256, bytes } = await hashFile(partialDumpPath);
    await fs.rename(partialDumpPath, dumpPath);
    await fsyncDir(workDir, platform);
    await writeJsonAtomic(factsPath, { dumpSha256: sha256, facts: sourceFacts }, platform);
    await updateMigration({ step: "dumped", dump: { sha256, bytes } });
    log.info(
      `[runtime:migration] dumped ${String(bytes)} bytes, schema_version ${String(sourceFacts.schemaVersion)}, ` +
        `${String(Object.keys(sourceFacts.tables).length)} tables`,
    );
  }

  async function readStoredFacts(migration: MigrationState): Promise<DatabaseFacts> {
    const text = await readTextOrNull(factsPath);
    let parsed: z.infer<typeof storedFactsSchema> | null = null;
    try {
      parsed = text === null ? null : storedFactsSchema.parse(JSON.parse(text));
    } catch {
      parsed = null;
    }
    if (parsed === null || migration.dump === null || parsed.dumpSha256 !== migration.dump.sha256) {
      throw new MigrationFailure("dump_corrupt", "The facts recorded with the dump are missing or do not match it.");
    }
    return parsed.facts;
  }

  async function restoreStep(run: Run, migration: MigrationState, pgRestore: string): Promise<void> {
    run.progress({ phase: "restoring" });
    const recorded = migration.dump;
    const onDisk = (await exists(dumpPath)) ? await hashFile(dumpPath) : null;
    if (recorded === null || onDisk === null || onDisk.sha256 !== recorded.sha256 || onDisk.bytes !== recorded.bytes) {
      throw new MigrationFailure("dump_corrupt", "The dump is missing or changed since it was written.");
    }
    await readStoredFacts(migration);
    // Whatever an interrupted restore left (it is single-transaction, but a
    // crash after its commit and before `restored` was recorded leaves a
    // full database) is dropped: restore always lands in a fresh cluster.
    await discardNativeCluster(run);
    throwIfAborted(run);
    const native = await startNative(run);
    const env = await toolEnv(native.pgPort, await readSecret(native.pgPasswordPath));
    let result: PgToolResult;
    try {
      log.info(`[runtime:migration] pg_restore into 127.0.0.1:${String(native.pgPort)}`);
      result = await deps.runTool(
        pgRestore,
        [
          "-h", "127.0.0.1", "-p", String(native.pgPort), "-U", "vex", "-d", "vex", "--no-password",
          "--exit-on-error", "--single-transaction", dumpPath,
        ],
        { env, timeoutMs: TOOL_TIMEOUT_MS, ...(run.signal !== undefined ? { signal: run.signal } : {}) },
      );
    } finally {
      await fs.rm(pgpassPath, { force: true });
    }
    throwIfAborted(run);
    if (result.code !== 0) {
      const tail = stderrTail(result.stderr);
      throw new MigrationFailure(DISK_FULL_RE.test(result.stderr) ? "disk_full" : "restore_failed", `pg_restore failed: ${tail}`);
    }
    await updateMigration({ step: "restored" });
    log.info("[runtime:migration] restored");
  }

  async function verifyStep(run: Run, migration: MigrationState): Promise<VerifyReport> {
    run.progress({ phase: "verifying" });
    const sourceFacts = await readStoredFacts(migration);
    const native = await startNative(run);
    let targetFacts: DatabaseFacts;
    try {
      targetFacts = await facts.readTarget(
        { port: native.pgPort, password: await readSecret(native.pgPasswordPath) },
        Object.keys(sourceFacts.vectorSample),
      );
    } catch (error: unknown) {
      throw new MigrationFailure("verify_failed", `Reading the built-in database failed: ${messageOf(error)}`);
    }
    throwIfAborted(run);
    const report = compareDatabaseFacts(sourceFacts, targetFacts);
    if (!report.ok) {
      log.error(`[runtime:migration] verification failed: ${report.mismatches.join("; ")}`);
      throw new MigrationFailure(
        "verify_failed",
        `The copy does not match the old database (${String(report.mismatches.length)} difference(s)).`,
        { report },
      );
    }
    await writeJsonAtomic(reportPath, report, platform);
    await stopNative(run);
    await updateMigration({ step: "verified" });
    log.info(
      `[runtime:migration] verified: schema_version ${String(report.schemaVersion)}, ${String(report.tables)} tables, ` +
        `${String(report.rows)} rows, ${String(report.vectors)} vectors (${String(report.sampledVectors)} sampled byte by byte)`,
    );
    return report;
  }

  async function finishStep(run: Run, migration: MigrationState, report: VerifyReport | null): Promise<MigrateResult> {
    run.progress({ phase: "finishing" });
    await stopNative(run);
    let stopped = false;
    try {
      const stop = await deps.source.stop(migration.installId, run.signal);
      stopped = stop.kind === "stopped" || stop.kind === "not_running";
      if (!stopped) log.warn(`[runtime:migration] the old stack was not stopped: ${stop.message}`);
    } catch (error: unknown) {
      log.warn(`[runtime:migration] the old stack was not stopped: ${messageOf(error)}`);
    }
    let finalReport = report;
    if (finalReport === null) {
      const text = await readTextOrNull(reportPath);
      try {
        finalReport = text === null ? null : (JSON.parse(text) as VerifyReport);
      } catch {
        finalReport = null;
      }
    }
    // The verified cluster is the copy now; the Docker volume stays as the
    // backup until the user removes it in Settings.
    await removeWorkFiles();
    await updateState((s) => ({
      ...s,
      provider: "native",
      migration: {
        ...migration,
        step: "completed",
        outcome: "migrated",
        dump: null,
        lastFailure: null,
        oldStackStopped: stopped,
        updatedAt: now().toISOString(),
      },
    }));
    log.info(`[runtime:migration] completed; old stack stopped: ${String(stopped)}`);
    return {
      kind: "migrated",
      report: finalReport,
      oldStackStopped: stopped,
      message: stopped
        ? "Your data was copied into Vex's built-in database and verified."
        : "Your data was copied into Vex's built-in database and verified. The old Docker stack could not be stopped.",
    };
  }

  /** Drop what this attempt made; the volume is never touched. */
  async function cleanUpAfterFailure(run: Run, failure: MigrationFailure): Promise<void> {
    try {
      await discardNativeCluster(run);
    } catch (error: unknown) {
      log.error(`[runtime:migration] could not drop the built-in database after a failure: ${messageOf(error)}`);
      await stopNative(run).catch(() => {});
    }
    await removeWorkFiles().catch((error: unknown) => log.error(`[runtime:migration] removing the dump: ${messageOf(error)}`));
    if (run.sourceStarted) {
      await deps.source.stop((await readRuntimeState(statePath)).migration?.installId ?? "", run.signal).catch(() => {});
    }
    const lastFailure: MigrationFailureRecord = { kind: failure.reason, message: failure.message, at: now().toISOString() };
    await updateMigration({ step: "started", dump: null, lastFailure });
  }

  async function runMigration(signal: AbortSignal | undefined, onProgress?: (p: MigrationProgress) => void): Promise<MigrateResult> {
    const end = beginCriticalOp(CRITICAL_OP.localRuntime);
    const run = newRun(signal, onProgress);
    try {
      let state: RuntimeState;
      try {
        state = await readRuntimeState(statePath);
      } catch (error: unknown) {
        if (error instanceof RuntimeStateCorruptError) throw new MigrationFailure("state_unreadable", error.message);
        throw error;
      }
      if (state.migration?.step === "completed") {
        return { kind: "already_completed", outcome: state.migration.outcome ?? "migrated" };
      }
      run.progress({ phase: "preparing" });
      let migration = await begin();
      migration = await updateMigration({ attempts: migration.attempts + 1 });
      const tools = await deps.locateClientTools();
      if (tools.kind === "unavailable") throw new MigrationFailure("native_unavailable", tools.detail);
      await run.supervisor();

      let report: VerifyReport | null = null;
      if (migration.step === "started") {
        await dumpStep(run, migration, tools.tools.pgDump);
        migration = (await readRuntimeState(statePath)).migration ?? migration;
      }
      if (migration.step === "dumped") {
        await restoreStep(run, migration, tools.tools.pgRestore);
        migration = (await readRuntimeState(statePath)).migration ?? migration;
      }
      if (migration.step === "restored") {
        report = await verifyStep(run, migration);
        migration = (await readRuntimeState(statePath)).migration ?? migration;
      }
      return await finishStep(run, migration, report);
    } catch (error: unknown) {
      if (isAbortError(error) || run.signal?.aborted === true) {
        await stopNative(run).catch(() => {});
        await fs.rm(partialDumpPath, { force: true }).catch(() => {});
        await fs.rm(pgpassPath, { force: true }).catch(() => {});
        const step = (await readRuntimeState(statePath).catch(() => null))?.migration?.step ?? "started";
        log.info(`[runtime:migration] cancelled; resumes after ${step}`);
        return { kind: "cancelled", resumeStep: step };
      }
      const failure =
        error instanceof MigrationFailure
          ? error
          : error instanceof RuntimeStateCorruptError
            ? new MigrationFailure("state_unreadable", error.message)
            : (error as NodeJS.ErrnoException | null)?.code === "ENOSPC"
              ? new MigrationFailure("disk_full", "The disk is full.")
              : new MigrationFailure("unexpected", messageOf(error));
      log.error(`[runtime:migration] failed (${failure.reason}): ${failure.message}`);
      const owned = await readRuntimeState(statePath).then(
        (s) => s.migration !== undefined && s.migration.step !== "completed",
        () => false,
      );
      if (owned && failure.reason !== "state_unreadable") {
        await cleanUpAfterFailure(run, failure).catch((cleanupError: unknown) =>
          log.error(`[runtime:migration] cleanup after the failure failed: ${messageOf(cleanupError)}`),
        );
      } else {
        await stopNative(run).catch(() => {});
      }
      return failed(failure);
    } finally {
      end();
    }
  }

  async function runStartFresh(signal: AbortSignal | undefined): Promise<StartFreshResult> {
    const end = beginCriticalOp(CRITICAL_OP.localRuntime);
    const run = newRun(signal);
    try {
      const state = await readRuntimeState(statePath);
      if (state.migration?.step === "completed") {
        if (state.migration.outcome === "fresh") return { kind: "started_fresh" };
        throw new MigrationFailure("not_pending", "This install's data was already migrated.");
      }
      let migration = state.migration ?? (await begin());
      if (state.migration !== undefined) {
        // An earlier attempt's cluster and dump go; the volume stays. A stack
        // that attempt started (and a quit left running) is stopped, best
        // effort: start fresh must work with Docker gone.
        await discardNativeCluster(run);
        await removeWorkFiles();
        await deps.source.stop(migration.installId, AbortSignal.timeout(SOURCE_STOP_BUDGET_MS)).catch(() => {});
      }
      await startNative(run);
      await stopNative(run);
      migration = (await readRuntimeState(statePath)).migration ?? migration;
      await updateState((s) => ({
        ...s,
        provider: "native",
        migration: {
          ...migration,
          step: "completed",
          outcome: "fresh",
          dump: null,
          oldStackStopped: null,
          updatedAt: now().toISOString(),
        },
      }));
      log.info(`[runtime:migration] started fresh; the volume of install ${migration.installId} is kept`);
      return { kind: "started_fresh" };
    } catch (error: unknown) {
      await stopNative(run).catch(() => {});
      if (isAbortError(error)) return failed(new MigrationFailure("unexpected", "Starting fresh was cancelled."));
      const failure =
        error instanceof MigrationFailure
          ? error
          : error instanceof RuntimeStateCorruptError
            ? new MigrationFailure("state_unreadable", error.message)
            : new MigrationFailure("unexpected", messageOf(error));
      log.error(`[runtime:migration] start fresh failed (${failure.reason}): ${failure.message}`);
      return failed(failure);
    } finally {
      end();
    }
  }

  async function runRemoveOldData(
    signal: AbortSignal | undefined,
    allowWithoutImport: boolean,
  ): Promise<RemoveOldDataResult> {
    const end = beginCriticalOp(CRITICAL_OP.localRuntime);
    try {
      const state = await readRuntimeState(statePath);
      const migration = state.migration;
      if (migration === undefined || migration.step !== "completed") {
        return { kind: "refused", reason: "not_completed", message: "The old data is kept until the migration completed." };
      }
      if (migration.outcome === "fresh" && !allowWithoutImport) {
        return {
          kind: "refused",
          reason: "not_imported",
          message: "This install started fresh: the old Docker data was never imported and is its only copy.",
        };
      }
      const current = await readInstallId(deps.configDir);
      if (current !== migration.installId) {
        return {
          kind: "refused",
          reason: "install_changed",
          message: `The migration was for install ${migration.installId}; this install is ${String(current)}.`,
        };
      }
      const removed = await deps.source.removeData(migration.installId, signal);
      if (removed.kind === "removed") {
        log.info(`[runtime:migration] removed the old data of install ${migration.installId}`);
        // Recorded so Settings stops offering a removal there is nothing left for.
        // Best effort: the data is gone either way, and a second removal is harmless.
        try {
          const latest = await readRuntimeState(statePath);
          if (latest.migration !== undefined) {
            await writeRuntimeState(statePath, {
              ...latest,
              migration: { ...latest.migration, oldDataRemovedAt: new Date().toISOString() },
            });
          }
        } catch (error: unknown) {
          log.warn(`[runtime:migration] could not record the removal: ${messageOf(error)}`);
        }
        return { kind: "removed", message: removed.message };
      }
      return { kind: "failed", reason: removed.kind === "docker_unavailable" ? "docker_unavailable" : "failed", message: removed.message };
    } catch (error: unknown) {
      return { kind: "failed", reason: "failed", message: messageOf(error) };
    } finally {
      end();
    }
  }

  function exclusive<T>(op: "migrate" | "fresh" | "remove", start: () => Promise<T>, busy: () => T): Promise<T> {
    if (inFlight !== null) {
      return inFlight.op === op && op === "migrate" ? (inFlight.promise as Promise<T>) : Promise.resolve(busy());
    }
    const promise = start();
    inFlight = { op, promise };
    void promise.finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    return promise;
  }

  const busyFailure = (): MigrationFailed => failed(new MigrationFailure("busy", "Another migration step is already running."));

  return {
    async detect(options) {
      let state: RuntimeState;
      try {
        state = await readRuntimeState(statePath);
      } catch (error: unknown) {
        // Corrupt, or unreadable (permissions, I/O): either way nothing may
        // be decided from it, and the boot screen needs an answer, not a throw.
        return { kind: "state_unreadable", message: messageOf(error) };
      }
      const migration = state.migration;
      if (migration?.step === "completed") {
        return { kind: "not_needed", reason: migration.outcome === "fresh" ? "started_fresh" : "migrated" };
      }
      if (migration !== undefined) {
        const resumeStep = migration.step;
        // Past the dump, Docker is needed only for the final, best-effort stop.
        if (resumeStep !== "started") {
          return { kind: "pending", installId: migration.installId, resumeStep, lastFailure: migration.lastFailure };
        }
        const probe = await deps.source.probe(migration.installId, options?.signal);
        return probe.kind === "unreachable"
          ? {
              kind: "pending_docker_unavailable",
              installId: migration.installId,
              detail: probe.detail,
              resumeStep,
              lastFailure: migration.lastFailure,
            }
          : { kind: "pending", installId: migration.installId, resumeStep, lastFailure: migration.lastFailure };
      }
      if (state.pg !== null || state.provider === "native") return { kind: "not_needed", reason: "native_install" };
      const installId = await readInstallId(deps.configDir);
      if (installId === null) return { kind: "not_needed", reason: "no_docker_install" };
      const rendered = await exists(renderedComposePath(deps.configDir));
      const probe = await deps.source.probe(installId, options?.signal);
      switch (probe.kind) {
        case "volume_present":
          return { kind: "pending", installId, resumeStep: null, lastFailure: null };
        case "volume_absent":
          return { kind: "not_needed", reason: "no_docker_volume" };
        case "unreachable":
          // Without the rendered project, an id alone does not say the stack
          // ever ran; with it, the data may be there and must not be skipped.
          return rendered
            ? { kind: "pending_docker_unavailable", installId, detail: probe.detail, resumeStep: null, lastFailure: null }
            : { kind: "not_needed", reason: "no_docker_install" };
      }
    },

    migrate(options) {
      return exclusive("migrate", () => runMigration(options?.signal, options?.onProgress), busyFailure);
    },

    startFresh(options) {
      return exclusive("fresh", () => runStartFresh(options?.signal), busyFailure);
    },

    removeOldData(options) {
      return exclusive(
        "remove",
        () => runRemoveOldData(options?.signal, options?.allowWithoutImport === true),
        (): RemoveOldDataResult => ({ kind: "refused", reason: "busy", message: "Another migration step is already running." }),
      );
    },
  };
}

/* ------------------------------------------------------------------ *
 * Production: this install's CONFIG_DIR and RUNTIME_DIR, the bundled tree,
 * the shared pg_password, the existing compose code.
 * ------------------------------------------------------------------ */

let production: DockerMigration | null = null;

/** This install's migration, process-wide; the boot gate (`native-start-gate.ts`) drives it. */
export function productionMigration(): DockerMigration {
  production ??= createDockerMigration({
    configDir: CONFIG_DIR,
    runtimeDir: RUNTIME_DIR,
    source: createDockerSource({ renderDeps: buildRenderDeps() }),
    locateClientTools: () => locatePostgresClientTools(),
    createSupervisor: async () => {
      const pg = await locatePostgresBinaries();
      if (pg.kind === "unavailable") return { unavailable: pg.detail };
      return createPostgresSupervisor({
        runtimeDir: RUNTIME_DIR,
        binaries: pg.binaries,
        ensurePasswordFile: async () => (await getPgPassword(productionPgPasswordDeps())).composePath,
      });
    },
    runTool: runPgTool,
  });
  return production;
}

/** At boot, before the native runtime starts: must the user migrate first? */
export function detectDockerMigration(options?: { readonly signal?: AbortSignal }): Promise<DockerMigrationStatus> {
  return productionMigration().detect(options);
}

/** "Migrate now" and "Retry". */
export function migrateFromDocker(options?: {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MigrationProgress) => void;
}): Promise<MigrateResult> {
  return productionMigration().migrate(options);
}

/** "Start fresh", after the UI's typed confirmation. */
export function startFresh(options?: { readonly signal?: AbortSignal }): Promise<StartFreshResult> {
  return productionMigration().startFresh(options);
}

/** Settings: "Remove old Docker data", after the UI's typed confirmation. */
export function removeOldDockerData(options?: {
  readonly signal?: AbortSignal;
  readonly allowWithoutImport?: boolean;
}): Promise<RemoveOldDataResult> {
  return productionMigration().removeOldData(options);
}
