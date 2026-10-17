/**
 * The native Postgres supervisor: creates the cluster, runs the postmaster,
 * proves it is ours, restarts it within a budget, and stops it without
 * leaking it. Plan 6.2 to 6.5, with the Phase 0 findings (15.4) applied.
 *
 * START, in order:
 *
 *   1. Refuse to run as root (Postgres refuses too, less legibly).
 *   2. Read runtime-state.json. A corrupt file is a failure, never a reset.
 *   3. Boot reaper (6.5 step 1). A postmaster.pid whose PID is alive is one of
 *      two things. A postgres whose cwd is THIS data dir (the postmaster
 *      chdirs there) is an orphan of an earlier session: fast-stop it. Any
 *      other process means the PID was reused: remove the stale file, which
 *      Postgres would otherwise refuse to start over. When the cwd cannot be
 *      read, leave the file to Postgres' own checks; deleting the lock of a
 *      live postmaster is how a data dir gets two (`judgeLivePostmaster`).
 *   4. ensureCluster: initdb exactly per 6.2 when there is no cluster, into a
 *      staging dir renamed into place on success (a crash mid-initdb leaves no
 *      half cluster where a whole one is expected); then the Vex conf block
 *      and pg_hba.conf, rewritten on every start.
 *   5. Port (D5): the last-used port if free, else one the OS hands out.
 *   6. macOS/Linux: spawn `postgres -D <pg18> -p <port>` directly. Windows:
 *      `pg_ctl start -w` (`postgres-win32.ts`, untested). Ready = postmaster.pid
 *      names the PID we spawned AND says `ready` (15.4 item 1). A failed
 *      start is classified from stderr plus the newest file in `log/`: port
 *      taken -> a fresh port (bounded); lock/shared memory still held by a
 *      just-crashed postmaster's children -> retry shortly (bounded); disk
 *      full -> `disk_full`; anything else -> `failed`.
 *   7. First start of a new cluster: CREATE DATABASE vex OWNER vex, then
 *      record system_identifier once `pg_controldata` and
 *      `pg_control_system()` agree. Recorded LAST, so a crash before it is
 *      retried rather than leaving an identity with no database behind it.
 *   8. Identity (D6) on every connect, `pg-identity.ts`. A mismatch stops the
 *      postmaster we started and reports `foreign_listener`.
 *
 * SUPERVISE. An unexpected exit restarts it, with the exact arithmetic of
 * `studio/pty-host-starter.ts`, `front-supervisor.ts` and
 * `llama-supervisor.ts`: `restarts <= PG_MAX_RESTARTS` from 0, six restarts
 * per session. The counter never resets: a reset on success lets a postmaster
 * that crashes every minute restart for ever. A failed restart attempt spends
 * budget too. Past the budget the health listeners hear `unhealthy`.
 *
 * STOP. SIGINT (fast shutdown) and wait for the process to exit and
 * postmaster.pid to go; past the deadline SIGQUIT (immediate: crash recovery
 * next start, no data loss); SIGKILL only if even that is ignored, because
 * on macOS a SIGKILLed postmaster leaks its SysV semaphores and segment until
 * the same data dir starts again (15.4 item 3).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LOOPBACK_DB_HOST, type DbConnection } from "../../database/connection-state.js";
import { AbortError, isAbortError } from "../../ipc/cancel-helpers.js";
import { log } from "../../logger/index.js";
import type { RuntimeStopKind } from "../provider.js";
import { pgDataDir, runtimeStatePath, type PostgresBinaries } from "../runtime-paths.js";
import {
  PG_MAJOR,
  readRuntimeState,
  RuntimeStateCorruptError,
  writeRuntimeState,
  type RuntimeState,
} from "../runtime-state.js";
import { chooseFreePort } from "./free-port.js";
import { checkPgIdentity, describePgError, withPgClient, type PgIdentityResult } from "./pg-identity.js";
import { VEX_PG_HBA, withVexConfBlock } from "./postgres-conf.js";
import {
  classifyStartFailure,
  firstFatalLine,
  isReadyFor,
  logLinesForPid,
  parseControldataSystemIdentifier,
  parsePostmasterPid,
  type StartFailureReason,
} from "./postgres-facts.js";
import { pgCtlStart, pgCtlStop, type PgCtlContext } from "./postgres-win32.js";

/**
 * The Studio helpers' arithmetic (and `llama-supervisor.ts`'s): a counter from
 * 0 restarts while `<= 5`, so SIX restarts per session, and it never resets.
 */
export const PG_MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 500;
export const PG_READY_TIMEOUT_MS = 60_000;
/** Fast-stop window when the caller does not name one (6.5: 15 s). */
export const PG_FAST_STOP_MS = 15_000;
export const PG_IMMEDIATE_GRACE_MS = 5_000;
export const PG_KILL_GRACE_MS = 2_000;
const INITDB_TIMEOUT_MS = 180_000;
const TOOL_TIMEOUT_MS = 30_000;
const PORT_ATTEMPTS = 3;
const BUSY_RETRY_WINDOW_MS = 30_000;
const BUSY_RETRY_DELAY_MS = 250;
const READY_POLL_MS = 25;
const CONNECT_WINDOW_MS = 10_000;
const CONNECT_RETRY_MS = 200;
/** The Windows postmaster is not our child; its liveness is polled (6.5). */
const WINDOWS_POLL_MS = 5_000;
const ORPHAN_POLL_MS = 50;
const STDERR_TAIL_CHARS = 16_384;
const LOG_TAIL_BYTES = 65_536;

/* ------------------------------------------------------------------ *
 * Seams. Production passes none of these.
 * ------------------------------------------------------------------ */

export interface PgChild {
  readonly pid: number | undefined;
  /** Settles once the process exited and its stderr ended (or shortly after exit). */
  readonly closed: Promise<void>;
  stderrTail(): string;
  kill(signal: NodeJS.Signals): void;
}

export type PgSpawn = (command: string, args: readonly string[], env: Readonly<Record<string, string>>) => PgChild;

export interface PgToolResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type PgRunTool = (
  command: string,
  args: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<PgToolResult>;

/** Facts about a process that is not necessarily ours. */
export interface ProcessProbe {
  alive(pid: number): boolean;
  /** Absolute path of the process image, or null when it cannot be read. */
  image(pid: number): Promise<string | null>;
  /** Working directory, or null when it cannot be read. */
  cwd(pid: number): Promise<string | null>;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export interface PostgresSupervisorOptions {
  readonly runtimeDir: string;
  readonly binaries: PostgresBinaries;
  /** This install's pg_password file, created by the existing generator if absent. */
  readonly ensurePasswordFile: () => Promise<string>;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: PgSpawn;
  readonly runTool?: PgRunTool;
  readonly processes?: ProcessProbe;
  readonly identity?: (port: number, password: string, recordedSystemIdentifier: string) => Promise<PgIdentityResult>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly getuid?: () => number | undefined;
}

/* ------------------------------------------------------------------ *
 * Results.
 * ------------------------------------------------------------------ */

export type PgStartKind =
  | "running"
  | "reused"
  | "port_collision"
  | "foreign_listener"
  | "unhealthy"
  | "failed"
  | "disk_full";

export interface PgStartResult {
  readonly kind: PgStartKind;
  /** Present exactly when `kind` is `running` or `reused`. */
  readonly connection: DbConnection | null;
  readonly message: string;
}

export type PgStopMode = "fast" | "immediate" | "killed";

export interface PgStopResult {
  readonly kind: RuntimeStopKind;
  readonly mode: PgStopMode | null;
  readonly message: string;
}

export type PgHealth =
  | { readonly kind: "restarting"; readonly attempt: number }
  | { readonly kind: "running"; readonly connection: DbConnection }
  | { readonly kind: "unhealthy"; readonly message: string };

export type EnsureClusterResult =
  | { readonly kind: "ready"; readonly initialized: boolean }
  | { readonly kind: "failed" | "disk_full"; readonly message: string };

export interface PostgresSupervisor {
  /** Idempotent; `start` runs it first. */
  ensureCluster(signal?: AbortSignal): Promise<EnsureClusterResult>;
  /** Rejects with AbortError when `signal` aborts before it settles. */
  start(signal?: AbortSignal): Promise<PgStartResult>;
  stop(options?: { readonly deadlineMs?: number }): Promise<PgStopResult>;
  /** Unexpected exits and what the restart budget made of them. */
  onHealthChange(listener: (health: PgHealth) => void): () => void;
}

/* ------------------------------------------------------------------ *
 * Production seams.
 * ------------------------------------------------------------------ */

/**
 * Postgres needs nothing from main's environment, and main's carries
 * credentials and `PG*` variables a child must not see; Windows needs what
 * its loader reads, and `COMSPEC` for the shell `pg_ctl start` runs through.
 */
const WINDOWS_ENV_ALLOW_LIST: readonly string[] = ["SystemRoot", "windir", "COMSPEC"];

export function postgresChildEnv(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  if (platform !== "win32") return out;
  for (const name of WINDOWS_ENV_ALLOW_LIST) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** How long `closed` waits for stderr to end after the process exited. */
const STDIO_DRAIN_AFTER_EXIT_MS = 2_000;

function spawnPostgres(command: string, args: readonly string[], env: Readonly<Record<string, string>>): PgChild {
  const child = nodeSpawn(command, args, {
    cwd: path.dirname(command),
    env: { ...env },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let tail = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  const closed = new Promise<void>((resolve) => {
    let drain: NodeJS.Timeout | undefined;
    child.once("exit", () => {
      drain = setTimeout(resolve, STDIO_DRAIN_AFTER_EXIT_MS);
    });
    child.once("close", () => {
      clearTimeout(drain);
      resolve();
    });
    child.once("error", (error) => {
      tail += `\n${error.message}`;
      resolve();
    });
  });
  return {
    pid: child.pid,
    closed,
    stderrTail: () => tail,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

const TOOL_OUTPUT_CAP = 1_048_576;

const runPgTool: PgRunTool = (command, args, options) =>
  new Promise((resolve) => {
    const child = nodeSpawn(command, args, {
      cwd: path.dirname(command),
      env: { ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < TOOL_OUTPUT_CAP) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < TOOL_OUTPUT_CAP) stderr += chunk;
    });
    const terminate = (): void => {
      child.kill("SIGTERM");
    };
    const timer = setTimeout(terminate, options.timeoutMs);
    options.signal?.addEventListener("abort", terminate, { once: true });
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", terminate);
      resolve({ code, stdout, stderr });
    };
    child.once("error", (error) => {
      stderr += error.message;
      settle(null);
    });
    child.once("close", (code) => settle(code));
  });

/**
 * macOS `ps` and `lsof` escape non-ASCII bytes (`\xc3\xab`) under the C locale
 * an empty environment implies, measured on a data dir under "vëx"; the
 * UTF-8 ctype prints them as they are. Output that still carries an escape is
 * treated as unreadable, never compared: a false "not our data dir" would
 * delete a live postmaster's lock.
 */
const DARWIN_TOOL_ENV: Readonly<Record<string, string>> = { LC_CTYPE: "UTF-8" };

function unescapedPath(value: string): string | null {
  return value.length > 0 && path.isAbsolute(value) && !/\\x[0-9a-fA-F]{2}/.test(value) ? value : null;
}

function nodeProcessProbe(platform: NodeJS.Platform, runTool: PgRunTool): ProcessProbe {
  const readlink = (p: string): Promise<string | null> => fs.readlink(p).catch(() => null);
  return {
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error: unknown) {
        // EPERM: it exists and belongs to someone else.
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    async image(pid) {
      if (platform === "linux") return readlink(`/proc/${String(pid)}/exe`);
      if (platform !== "darwin") return null;
      const result = await runTool("/bin/ps", ["-o", "comm=", "-p", String(pid)], {
        env: DARWIN_TOOL_ENV,
        timeoutMs: TOOL_TIMEOUT_MS,
      });
      return result.code === 0 ? unescapedPath(result.stdout.trim()) : null;
    },
    async cwd(pid) {
      if (platform === "linux") return readlink(`/proc/${String(pid)}/cwd`);
      if (platform !== "darwin") return null;
      const result = await runTool("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        env: DARWIN_TOOL_ENV,
        timeoutMs: TOOL_TIMEOUT_MS,
      });
      if (result.code !== 0) return null;
      const line = result.stdout.split("\n").find((l) => l.startsWith("n"));
      return line === undefined ? null : unescapedPath(line.slice(1));
    },
    signal(pid, signal) {
      process.kill(pid, signal);
    },
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Pure decisions, exported for the tests.
 * ------------------------------------------------------------------ */

export type LivePostmasterVerdict = "ours" | "foreign" | "unknown";

/**
 * Whose is the live PID a leftover postmaster.pid names?
 *
 * The deciding fact is the process's working directory: a postmaster chdirs
 * into its data dir, so a live process whose cwd IS our data dir is holding
 * it, and deleting its lock would let a second postmaster in. That is
 * stronger than the two facts 6.5 names. The file's data-dir line is only
 * what the postmaster was told (a renamed dir moves the cwd, not the line),
 * and the image path changes with every update or AppImage mount while an
 * orphan from the previous version is still ours to stop, so the image only
 * has to be a `postgres`. A process elsewhere, or one that is not a postgres,
 * is not holding our data dir: the file is stale. No cwd, no verdict.
 *
 * Paths arrive already resolved (realpath), so `/var` and `/private/var`
 * agree on macOS.
 */
export function judgeLivePostmaster(
  facts: { readonly image: string | null; readonly cwd: string | null },
  ourDataDir: string,
): LivePostmasterVerdict {
  if (facts.cwd === null) return "unknown";
  if (facts.cwd !== ourDataDir) return "foreign";
  if (facts.image !== null && !/^postgres(\.exe)?$/.test(path.basename(facts.image))) return "foreign";
  return "ours";
}

/* ------------------------------------------------------------------ *
 * The supervisor.
 * ------------------------------------------------------------------ */

/** A running postmaster, whichever way it was started. */
interface Postmaster {
  readonly pid: number;
  readonly port: number;
  readonly gone: Promise<void>;
  isGone(): boolean;
  /** Not used on Windows, where stop goes through pg_ctl. */
  signal(signal: NodeJS.Signals): void;
}

type LaunchResult =
  | { readonly kind: "ready"; readonly postmaster: Postmaster }
  | { readonly kind: "exited"; readonly reason: StartFailureReason; readonly text: string }
  | { readonly kind: "timeout"; readonly text: string };

class StartFailure extends Error {
  constructor(readonly result: PgStartResult) {
    super(result.message);
  }
}

function fail(kind: Exclude<PgStartKind, "running" | "reused">, message: string): StartFailure {
  return new StartFailure({ kind, connection: null, message });
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function realpathOrSelf(p: string): Promise<string> {
  return fs.realpath(p).catch(() => p);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${String(process.pid)}`;
  await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

export function createPostgresSupervisor(options: PostgresSupervisorOptions): PostgresSupervisor {
  const platform = options.platform ?? process.platform;
  const { binaries, runtimeDir } = options;
  const dataDir = pgDataDir(runtimeDir);
  const statePath = runtimeStatePath(runtimeDir);
  const pidFilePath = path.join(dataDir, "postmaster.pid");
  const logDir = path.join(dataDir, "log");
  const env = postgresChildEnv(platform);
  const spawnPg = options.spawn ?? spawnPostgres;
  const runTool = options.runTool ?? runPgTool;
  const processes = options.processes ?? nodeProcessProbe(platform, runTool);
  const identity = options.identity ?? checkPgIdentity;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const getuid = options.getuid ?? (() => process.getuid?.());
  const pgCtl: PgCtlContext = {
    pgCtl: binaries.pgCtl,
    dataDir,
    startupLog: path.join(runtimeDir, "pg_ctl-start.log"),
    env,
    runTool,
  };

  let current: Postmaster | null = null;
  let connection: DbConnection | null = null;
  let restarts = 0;
  let stopRequested = false;
  let inFlight: Promise<unknown> | null = null;
  const listeners = new Set<(health: PgHealth) => void>();

  const emit = (health: PgHealth): void => {
    for (const listener of listeners) {
      try {
        listener(health);
      } catch {
        // An observer's failure must not break supervision.
      }
    }
  };

  const throwIfCancelled = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted === true) throw new AbortError("postgres start cancelled");
  };

  async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
    return Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
  }

  async function pollUntilGone(pid: number, intervalMs: number): Promise<void> {
    while (processes.alive(pid)) await sleep(intervalMs);
  }

  /** A postmaster known only by PID: an orphan, or Windows' pg_ctl-started one. */
  function postmasterByPid(pid: number, port: number, intervalMs: number): Postmaster {
    let goneFlag = false;
    const gone = pollUntilGone(pid, intervalMs).then(() => {
      goneFlag = true;
    });
    return { pid, port, gone, isGone: () => goneFlag, signal: (s) => processes.signal(pid, s) };
  }

  async function readPassword(): Promise<{ readonly path: string; readonly value: string }> {
    const passwordPath = await options.ensurePasswordFile();
    const value = (await fs.readFile(passwordPath, "utf8")).trim();
    if (value.length === 0) throw fail("failed", `This install's database password file is empty (${passwordPath}).`);
    return { path: passwordPath, value };
  }

  /* -------------------------- cluster ---------------------------- */

  async function initCluster(signal: AbortSignal | undefined): Promise<void> {
    const staging = `${dataDir}.initdb`;
    const pwfile = path.join(runtimeDir, ".initdb-pwfile");
    await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await fs.rm(staging, { recursive: true, force: true });
    const password = await readPassword();
    // Beside the data dir, not in TMPDIR: initdb mishandles a non-ASCII
    // %TEMP% on Windows (6.2). Exclusive create, owner-only, deleted after.
    await fs.rm(pwfile, { force: true });
    await fs.writeFile(pwfile, `${password.value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    let result: PgToolResult;
    try {
      log.info(`[runtime:pg] initdb ${staging}`);
      result = await runTool(
        binaries.initdb,
        [
          "-D", staging, "-U", "vex", `--pwfile=${pwfile}`, "-E", "UTF8",
          "--locale=C", "--locale-provider=builtin", "--builtin-locale=C.UTF-8",
          "--auth-local=scram-sha-256", "--auth-host=scram-sha-256",
        ],
        { env, timeoutMs: INITDB_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) },
      );
    } finally {
      await fs.rm(pwfile, { force: true });
    }
    if (result.code !== 0) await fs.rm(staging, { recursive: true, force: true });
    throwIfCancelled(signal);
    if (result.code !== 0) {
      const output = `${result.stdout}\n${result.stderr}`;
      log.warn(`[runtime:pg] initdb failed code=${String(result.code)}: ${output.trim().slice(-2_000)}`);
      throw classifyStartFailure(output) === "disk_full"
        ? fail("disk_full", "The disk is full, so the local database could not be created.")
        : fail("failed", `Creating the local database failed: ${output.trim().split("\n").at(-1) ?? "initdb failed"}`);
    }
    // An empty pg18 left by hand would block the rename; rmdir removes only
    // an empty directory.
    await fs.rmdir(dataDir).catch(() => {});
    await fs.rename(staging, dataDir);
  }

  async function ensureClusterOrThrow(signal: AbortSignal | undefined): Promise<boolean> {
    const version = await readText(path.join(dataDir, "PG_VERSION"));
    let initialized = false;
    if (version === null) {
      await initCluster(signal);
      initialized = true;
    } else if (version.trim() !== String(PG_MAJOR)) {
      throw fail(
        "failed",
        `The local database at ${dataDir} was created by Postgres ${version.trim()}; this build runs Postgres ${String(PG_MAJOR)}.`,
      );
    }
    const confPath = path.join(dataDir, "postgresql.conf");
    const conf = await fs.readFile(confPath, "utf8");
    const nextConf = withVexConfBlock(conf, platform);
    if (nextConf !== conf) await writeFileAtomic(confPath, nextConf);
    const hbaPath = path.join(dataDir, "pg_hba.conf");
    if ((await readText(hbaPath)) !== VEX_PG_HBA) await writeFileAtomic(hbaPath, VEX_PG_HBA);
    return initialized;
  }

  /* -------------------------- reaper ----------------------------- */

  async function reapLeftoverPostmaster(): Promise<void> {
    const text = await readText(pidFilePath);
    if (text === null) return;
    const file = parsePostmasterPid(text);
    // Unparseable or dead: Postgres' own lock-file checks handle both.
    if (file === null || !processes.alive(file.pid)) return;
    if (platform === "win32") {
      // pg_ctl signals through the postmaster's own named pipe, so a PID
      // reused by another program just fails to stop; Postgres' lock-file
      // check probes that same pipe and treats such a file as stale itself.
      log.warn(`[runtime:pg] postmaster.pid names live pid ${String(file.pid)}; asking pg_ctl to stop it`);
      await pgCtlStop(pgCtl, PG_FAST_STOP_MS);
      return;
    }
    const [image, cwd, ourDir] = await Promise.all([
      processes.image(file.pid),
      processes.cwd(file.pid).then((p) => (p === null ? null : realpathOrSelf(p))),
      realpathOrSelf(dataDir),
    ]);
    const verdict = judgeLivePostmaster({ image, cwd }, ourDir);
    if (verdict === "ours") {
      log.warn(`[runtime:pg] stopping an orphaned postmaster from an earlier session pid=${String(file.pid)}`);
      const orphan = postmasterByPid(file.pid, file.port ?? 0, ORPHAN_POLL_MS);
      await stopPostmaster(orphan, PG_FAST_STOP_MS);
    } else if (verdict === "foreign") {
      log.warn(`[runtime:pg] postmaster.pid names pid ${String(file.pid)}, now another program; removing the stale file`);
      await fs.rm(pidFilePath, { force: true });
    } else {
      log.warn(`[runtime:pg] postmaster.pid names live pid ${String(file.pid)} that could not be identified; leaving it`);
    }
  }

  /* -------------------------- launch ----------------------------- */

  async function newestLogTail(): Promise<string> {
    try {
      const names = await fs.readdir(logDir);
      let newest: { readonly file: string; readonly mtime: number } | null = null;
      for (const name of names) {
        const file = path.join(logDir, name);
        const stat = await fs.stat(file);
        if (stat.isFile() && (newest === null || stat.mtimeMs > newest.mtime)) newest = { file, mtime: stat.mtimeMs };
      }
      if (newest === null) return "";
      const handle = await fs.open(newest.file, "r");
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        return buffer.toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return "";
    }
  }

  /** stderr first (pre-collector failures), then this PID's lines in log/. */
  async function failureText(child: PgChild, pid: number): Promise<string> {
    const stderr = child.stderrTail();
    if (firstFatalLine(stderr) !== null) return stderr;
    // The collector may flush the postmaster's last lines just after it exits.
    let lines: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      lines = logLinesForPid(await newestLogTail(), pid);
      if (firstFatalLine(lines.join("\n")) !== null) break;
      await sleep(100);
    }
    return [stderr, ...lines].join("\n");
  }

  async function launchPosix(port: number, signal: AbortSignal | undefined): Promise<LaunchResult> {
    const child = spawnPg(binaries.postgres, ["-D", dataDir, "-p", String(port)], env);
    let closed = false;
    void child.closed.then(() => {
      closed = true;
    });
    const pid = child.pid;
    if (pid === undefined) {
      await child.closed;
      return { kind: "exited", reason: "other", text: child.stderrTail() };
    }
    const postmaster: Postmaster = {
      pid,
      port,
      gone: child.closed,
      isGone: () => closed,
      signal: (s) => child.kill(s),
    };
    const deadline = now() + PG_READY_TIMEOUT_MS;
    for (;;) {
      if (closed) {
        const text = await failureText(child, pid);
        return { kind: "exited", reason: classifyStartFailure(text), text };
      }
      let ready: boolean;
      try {
        ready = isReadyFor(await readText(pidFilePath), pid);
      } catch (error: unknown) {
        // An unreadable lock file must not strand the child we started.
        await stopPostmaster(postmaster, PG_FAST_STOP_MS);
        throw error;
      }
      if (ready) return { kind: "ready", postmaster };
      if (signal?.aborted === true || stopRequested || now() > deadline) {
        await stopPostmaster(postmaster, PG_FAST_STOP_MS);
        throwIfCancelled(signal);
        return { kind: "timeout", text: stopRequested ? "stop requested" : child.stderrTail() };
      }
      await sleep(READY_POLL_MS);
    }
  }

  /** UNTESTED (no Windows machine): see `postgres-win32.ts`. */
  async function launchWindows(port: number, signal: AbortSignal | undefined): Promise<LaunchResult> {
    await fs.writeFile(pgCtl.startupLog, "", "utf8");
    const started = await pgCtlStart(pgCtl, port);
    const file = parsePostmasterPid((await readText(pidFilePath)) ?? "");
    if (started.ok && file !== null && file.status === "ready" && processes.alive(file.pid)) {
      const postmaster = postmasterByPid(file.pid, port, WINDOWS_POLL_MS);
      if (signal?.aborted === true || stopRequested) {
        await stopPostmaster(postmaster, PG_FAST_STOP_MS);
        throwIfCancelled(signal);
        return { kind: "timeout", text: "stop requested" };
      }
      return { kind: "ready", postmaster };
    }
    const text = [started.output, (await readText(pgCtl.startupLog)) ?? "", await newestLogTail()].join("\n");
    return { kind: "exited", reason: classifyStartFailure(text), text };
  }

  async function launchWithRetries(
    preferredPort: number | null,
    signal: AbortSignal | undefined,
  ): Promise<Postmaster> {
    const tried = new Set<number>();
    let portFailures = 0;
    const busyUntil = now() + BUSY_RETRY_WINDOW_MS;
    for (;;) {
      throwIfCancelled(signal);
      if (stopRequested) throw fail("failed", "The database was stopped while it was starting.");
      const preferred = preferredPort !== null && !tried.has(preferredPort) ? [preferredPort] : [];
      const port = await chooseFreePort(preferred);
      tried.add(port);
      const launched = platform === "win32" ? await launchWindows(port, signal) : await launchPosix(port, signal);
      if (launched.kind === "ready") return launched.postmaster;
      if (stopRequested) throw fail("failed", "The database was stopped while it was starting.");
      if (launched.kind === "timeout") {
        throw fail("unhealthy", `The local database did not become ready within ${String(PG_READY_TIMEOUT_MS / 1_000)} s.`);
      }
      const fatal = firstFatalLine(launched.text) ?? "postgres exited before it was ready";
      log.warn(`[runtime:pg] start on port ${String(port)} failed (${launched.reason}): ${fatal}`);
      switch (launched.reason) {
        case "port_in_use":
          portFailures += 1;
          if (portFailures < PORT_ATTEMPTS) continue;
          throw fail("port_collision", `No free port on ${LOOPBACK_DB_HOST} after ${String(PORT_ATTEMPTS)} attempts.`);
        case "data_dir_busy":
          if (now() < busyUntil) {
            tried.delete(port);
            await sleep(BUSY_RETRY_DELAY_MS);
            continue;
          }
          throw fail("failed", `The local database is still held by an earlier server: ${fatal}`);
        case "disk_full":
          throw fail("disk_full", "The disk is full, so the local database could not start.");
        case "other":
          throw fail("failed", `The local database could not start: ${fatal}`);
      }
    }
  }

  /* -------------------------- identity --------------------------- */

  /** Retry what is retryable for a short window; the rest is an answer. */
  async function untilAnswered<T extends { readonly kind: string }>(attempt: () => Promise<T>): Promise<T> {
    const deadline = now() + CONNECT_WINDOW_MS;
    for (;;) {
      const result = await attempt();
      if (result.kind !== "unreachable" || now() > deadline || stopRequested) return result;
      await sleep(CONNECT_RETRY_MS);
    }
  }

  /** CREATE DATABASE vex, then the identity both sources must agree on. */
  async function bootstrapIdentity(port: number, password: string): Promise<string> {
    const answer = await untilAnswered(async () => {
      const result = await withPgClient({ port, password, database: "postgres" }, async (client) => {
        const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'vex'");
        if (exists.rowCount === 0) await client.query("CREATE DATABASE vex OWNER vex");
        const row = await client.query<{ id: string }>("SELECT system_identifier::text AS id FROM pg_control_system()");
        return row.rows[0]?.id ?? null;
      });
      return result.ok ? { kind: "answered" as const, id: result.value } : describePgError(result.error);
    });
    if (answer.kind !== "answered") {
      throw fail(answer.kind === "foreign_listener" ? "foreign_listener" : "failed", `Setting up the local database failed: ${answer.detail}`);
    }
    const controldata = await runTool(binaries.pgControldata, ["-D", dataDir], { env, timeoutMs: TOOL_TIMEOUT_MS });
    const fromControl = parseControldataSystemIdentifier(controldata.stdout);
    if (answer.id === null || fromControl === null || answer.id !== fromControl) {
      throw fail(
        "foreign_listener",
        `The server on port ${String(port)} reports system_identifier ${String(answer.id)}, but this data directory's is ${String(fromControl)}.`,
      );
    }
    return fromControl;
  }

  async function verifyIdentity(port: number, password: string, recorded: string): Promise<void> {
    const verdict = await untilAnswered(() => identity(port, password, recorded));
    switch (verdict.kind) {
      case "usable":
        return;
      case "foreign_listener":
        throw fail("foreign_listener", `The database on port ${String(port)} is not this install's: ${verdict.detail}.`);
      case "auth_rejected":
        throw fail("failed", `The local database rejected this install's password: ${verdict.detail}.`);
      case "unreachable":
        throw fail("unhealthy", `The local database did not answer: ${verdict.detail}.`);
    }
  }

  /* -------------------------- lifecycle -------------------------- */

  function watch(postmaster: Postmaster): void {
    void postmaster.gone.then(() => {
      if (current !== postmaster || stopRequested) return;
      current = null;
      connection = null;
      log.error(`[runtime:pg] postmaster pid=${String(postmaster.pid)} exited unexpectedly`);
      const run = superviseRestarts();
      inFlight = run;
      void run.finally(() => {
        if (inFlight === run) inFlight = null;
      });
    });
  }

  async function superviseRestarts(): Promise<void> {
    let lastMessage = "the postmaster exited";
    while (!stopRequested && restarts <= PG_MAX_RESTARTS) {
      restarts += 1;
      log.warn(`[runtime:pg] restarting (attempt ${String(restarts)})`);
      emit({ kind: "restarting", attempt: restarts });
      // Grows, so a crash loop does not spend the budget in a second.
      await sleep(RESTART_DELAY_MS * restarts);
      if (stopRequested) return;
      const result = await bringUp(undefined).catch((error: unknown): PgStartResult => ({
        kind: "failed",
        connection: null,
        message: error instanceof Error ? error.message : String(error),
      }));
      if (result.connection !== null) {
        emit({ kind: "running", connection: result.connection });
        return;
      }
      lastMessage = result.message;
    }
    if (stopRequested) return;
    log.error(`[runtime:pg] giving up after ${String(restarts)} restarts: ${lastMessage}`);
    emit({ kind: "unhealthy", message: `The local database stopped and did not recover: ${lastMessage}` });
  }

  async function bringUp(signal: AbortSignal | undefined): Promise<PgStartResult> {
    try {
      if (platform !== "win32" && getuid() === 0) {
        throw fail("failed", "Vex cannot run its local database as root. Start Vex as a regular user.");
      }
      let state: RuntimeState = await readRuntimeState(statePath);
      await reapLeftoverPostmaster();
      throwIfCancelled(signal);
      if ((await ensureClusterOrThrow(signal)) && state.pg !== null) {
        // A new cluster: the recorded identity belonged to one that is gone.
        // Persisted now, so a failed bootstrap is retried rather than judged
        // against the old identity next launch.
        state = { ...state, pg: null };
        await writeRuntimeState(statePath, state);
      }
      const password = await readPassword();
      const postmaster = await launchWithRetries(state.pg?.lastPort ?? null, signal);
      try {
        throwIfCancelled(signal);
        let pg = state.pg;
        if (pg === null) {
          const systemIdentifier = await bootstrapIdentity(postmaster.port, password.value);
          pg = { systemIdentifier, lastPort: postmaster.port, major: PG_MAJOR };
          await writeRuntimeState(statePath, { ...state, pg });
          log.info(`[runtime:pg] cluster bootstrapped system_identifier=${systemIdentifier}`);
        }
        await verifyIdentity(postmaster.port, password.value, pg.systemIdentifier);
        throwIfCancelled(signal);
        if (pg.lastPort !== postmaster.port) {
          await writeRuntimeState(statePath, { ...state, pg: { ...pg, lastPort: postmaster.port } });
        }
      } catch (error: unknown) {
        await stopPostmaster(postmaster, PG_FAST_STOP_MS);
        throw error;
      }
      current = postmaster;
      connection = { host: LOOPBACK_DB_HOST, pgPort: postmaster.port, pgPasswordPath: password.path };
      watch(postmaster);
      log.info(`[runtime:pg] ready pid=${String(postmaster.pid)} port=${String(postmaster.port)}`);
      return { kind: "running", connection, message: "The local database is running." };
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      if (error instanceof StartFailure) return error.result;
      if (error instanceof RuntimeStateCorruptError) return { kind: "failed", connection: null, message: error.message };
      if (errnoCode(error) === "ENOSPC") {
        return { kind: "disk_full", connection: null, message: "The disk is full, so the local database could not start." };
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[runtime:pg] start failed: ${message}`);
      return { kind: "failed", connection: null, message: `The local database could not start: ${message}` };
    }
  }

  async function stopPostmaster(postmaster: Postmaster, deadlineMs: number): Promise<PgStopResult> {
    let mode: PgStopMode | null;
    if (platform === "win32") {
      mode = (await pgCtlStop(pgCtl, deadlineMs)).mode;
      if (mode === null || processes.alive(postmaster.pid)) {
        return { kind: "failed", mode: null, message: "pg_ctl could not stop the local database." };
      }
    } else {
      postmaster.signal("SIGINT");
      if (await settlesWithin(postmaster.gone, deadlineMs)) {
        mode = "fast";
      } else {
        log.warn(`[runtime:pg] fast shutdown exceeded ${String(deadlineMs)} ms; immediate shutdown`);
        postmaster.signal("SIGQUIT");
        if (await settlesWithin(postmaster.gone, PG_IMMEDIATE_GRACE_MS)) {
          mode = "immediate";
        } else {
          // Last resort: on macOS this leaks SysV IPC until the next start.
          log.error(`[runtime:pg] postmaster pid=${String(postmaster.pid)} ignored SIGQUIT; SIGKILL`);
          postmaster.signal("SIGKILL");
          if (!(await settlesWithin(postmaster.gone, PG_KILL_GRACE_MS))) {
            return { kind: "failed", mode: null, message: "The local database did not stop." };
          }
          mode = "killed";
        }
      }
    }
    // Fast and immediate shutdowns remove postmaster.pid on the way out.
    const pidFile = parsePostmasterPid((await readText(pidFilePath)) ?? "");
    const pidFileRemoved = pidFile === null || pidFile.pid !== postmaster.pid;
    return {
      kind: "stopped",
      mode,
      message: pidFileRemoved
        ? `The local database stopped (${mode}).`
        : `The local database stopped (${mode}); its postmaster.pid remains for the next start to clear.`,
    };
  }

  return {
    async ensureCluster(signal) {
      try {
        return { kind: "ready", initialized: await ensureClusterOrThrow(signal) };
      } catch (error: unknown) {
        if (isAbortError(error)) throw error;
        if (error instanceof StartFailure && error.result.kind === "disk_full") {
          return { kind: "disk_full", message: error.result.message };
        }
        if (errnoCode(error) === "ENOSPC") return { kind: "disk_full", message: "The disk is full." };
        return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    },

    async start(signal) {
      if (inFlight !== null) await inFlight.catch(() => {});
      stopRequested = false;
      const live = current;
      if (live !== null && !live.isGone() && connection !== null) {
        const reused = connection;
        try {
          const state = await readRuntimeState(statePath);
          const recorded = state.pg?.systemIdentifier;
          if (recorded === undefined) throw fail("failed", "The runtime state lost the cluster's identity.");
          await verifyIdentity(live.port, (await readPassword()).value, recorded);
          return { kind: "reused", connection: reused, message: "The local database is already running." };
        } catch (error: unknown) {
          if (error instanceof StartFailure) return error.result;
          if (error instanceof RuntimeStateCorruptError) return { kind: "failed", connection: null, message: error.message };
          throw error;
        }
      }
      const run = bringUp(signal);
      inFlight = run;
      try {
        return await run;
      } finally {
        if (inFlight === run) inFlight = null;
      }
    },

    async stop(stopOptions) {
      stopRequested = true;
      if (inFlight !== null) await inFlight.catch(() => {});
      const postmaster = current;
      if (postmaster === null || postmaster.isGone()) {
        current = null;
        connection = null;
        return { kind: "not_running", mode: null, message: "The local database is not running." };
      }
      const result = await stopPostmaster(postmaster, stopOptions?.deadlineMs ?? PG_FAST_STOP_MS);
      if (result.kind === "stopped") {
        current = null;
        connection = null;
      }
      return result;
    },

    onHealthChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
