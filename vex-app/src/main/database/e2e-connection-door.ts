/**
 * The E2E database door: the ONE way an end-to-end run can hand the main
 * process a Postgres the app did not start itself.
 *
 * ## Why a door exists at all
 *
 * `connection-state.ts` has exactly one production writer - the runtime host
 * (`main/runtime/runtime-host.ts`), which publishes the bundled native
 * Postgres once its start settles `running` / `reused`. That is correct for
 * the product and useless for a test: the native runtime keeps its cluster,
 * its recorded identity and its last port in the profile's runtime dir, so an
 * e2e run that let it start would initialise a cluster per profile and fetch
 * the embeddings model before the first assertion. An e2e run therefore
 * brings its own throwaway Postgres (`e2e/fixtures/vex-stack.ts`, on the same
 * bundled binaries) and publishes it here. When the door publishes, the
 * runtime mode is `e2e_door` (`main/runtime/runtime-mode.ts`) and nothing
 * native starts, so the door's database is never displaced.
 *
 * ## The authority this door takes, and the guards on it
 *
 * It publishes a database connection, which is real authority over where the
 * app's data goes. It is narrow on purpose:
 *
 *   - INERT in a packaged app (`app.isPackaged`). A shipped Vex has no door.
 *   - Requires BOTH `VEX_E2E_DB_PORT` and `VEX_E2E_DB_PASSWORD_FILE`. Exactly
 *     one of them is a refusal, never a partial guess.
 *   - Refuses {@link DEFAULT_PG_PORT}, the port the previous release's Docker
 *     stack publishes (an install that has not migrated yet still runs it).
 *     The constant is IMPORTED, never respelled here.
 *   - Refuses the port of the developer's own native runtime while it runs.
 *     That runtime picks its port at launch (the last one when free, else
 *     one the OS hands out), so there is no constant to refuse: the live
 *     port is read from the `postmaster.pid` of the developer's install's
 *     cluster (its runtime dir resolved WITHOUT `VEX_CONFIG_DIR`), and a
 *     postmaster that is alive but has not written its port yet is a refusal
 *     too, since the port cannot be ruled out.
 *   - Refuses while a native cluster is running for THIS run's own config dir
 *     (`VEX_CONFIG_DIR`, or the default one when it is unset). A door run
 *     needs a profile no runtime is serving; one that is being served is
 *     somebody's real install.
 *   - Refuses a password file that is missing, not a regular file, empty, or
 *     group/world-accessible (POSIX only - Windows mode bits carry no such
 *     meaning).
 *   - Refuses when a connection is already published, so the door can never
 *     displace a live runtime.
 *   - Publishes ONCE, through the existing {@link setDbConnection} seam. It
 *     invents no second source of truth, and nothing here crosses the preload
 *     boundary: there is no renderer or IPC surface for this module.
 *
 * Every refusal is loud and typed. Failing closed silently would let a green
 * e2e run mean nothing at all.
 *
 * ## Precedence, as implemented
 *
 * The door publishes only into an EMPTY connection slot, and it runs at
 * bootstrap, before main decides the runtime mode. A published door makes the
 * mode `e2e_door`, and every path that would start the native runtime asks
 * that mode first. The door cannot - from here - stop some later writer from
 * replacing its connection; what it does instead is OBSERVE: it subscribes to
 * the connection state for as long as it is open and logs a loud warning if
 * its connection is ever replaced or cleared. A later overwrite is therefore
 * diagnosable in the run log rather than silent, which is the property that
 * actually matters when an e2e assertion starts reading a database nobody
 * expected.
 */

import { app } from "electron";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_PG_PORT } from "../../shared/local-service-ports.js";
import { log } from "../logger/index.js";
import { resolveConfigDir } from "../paths/config-dir.js";
import { parsePostmasterPid } from "../runtime/native/postgres-facts.js";
import { pgDataDir, resolveRuntimeDir } from "../runtime/runtime-paths.js";
import {
  getDbConnection,
  LOOPBACK_DB_HOST,
  setDbConnection,
  subscribeDbConnection,
  type DbConnection,
} from "./connection-state.js";

/** Environment variable naming the loopback port of the e2e Postgres. */
export const E2E_DB_PORT_ENV = "VEX_E2E_DB_PORT";
/** Environment variable naming the file holding that Postgres's password. */
export const E2E_DB_PASSWORD_FILE_ENV = "VEX_E2E_DB_PASSWORD_FILE";

/** Why the door stayed shut without anyone having asked it to open. */
export type E2eDoorInertReason = "packaged" | "not_requested";

/** Why the door REFUSED a request that was actually made. */
export type E2eDoorRefusal =
  | "partial_configuration"
  | "invalid_port"
  | "dev_port_collision"
  | "dev_runtime_port_unknown"
  | "config_dir_runtime_running"
  | "password_file_missing"
  | "password_file_not_regular"
  | "password_file_mode"
  | "password_file_empty"
  | "connection_already_published";

/** The door's decision for one boot. */
export type E2eDoorDecision =
  | { readonly kind: "inert"; readonly reason: E2eDoorInertReason }
  | { readonly kind: "refused"; readonly reason: E2eDoorRefusal; readonly detail: string }
  | { readonly kind: "publish"; readonly connection: DbConnection };

/**
 * What the door needs to know about the password file. Deliberately NOT the
 * password: the door validates the file and hands the PATH to
 * `db-config.ts`, which is the only reader of the secret itself.
 */
export interface E2ePasswordFileFacts {
  /** Whether the path resolves to a regular file. */
  readonly isRegularFile: boolean;
  /** POSIX mode bits, as reported by `stat`. */
  readonly mode: number;
  /** Length of the file content after trimming; 0 means an empty secret. */
  readonly trimmedLength: number;
}

/**
 * A native cluster that is running now, as its data dir's `postmaster.pid`
 * says (a file naming a live process).
 */
export interface RunningNativeCluster {
  /**
   * `developer_install`: the runtime dir of the developer's own install (the
   * default config dir). `this_run`: the runtime dir of the config dir this
   * boot runs on. When the two are the same directory, it is `this_run`.
   */
  readonly owner: "developer_install" | "this_run";
  readonly runtimeDir: string;
  readonly pid: number;
  /** Null while the postmaster has not written its port yet. */
  readonly port: number | null;
}

/** Everything the pure decision reads. */
export interface E2eDoorInput {
  readonly packaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly connectionAlreadyPublished: boolean;
  /** Returns `null` when the path cannot be inspected at all. */
  readonly inspectPasswordFile: (path: string) => E2ePasswordFileFacts | null;
  /** The native clusters running now for the developer's install and this run. */
  readonly runningNativeClusters: readonly RunningNativeCluster[];
}

/** The highest port a TCP listener can occupy. */
const MAX_TCP_PORT = 65_535;

/**
 * Decide, purely, whether this boot may open the door.
 *
 * Order matters: configuration completeness first, then the port (the guards
 * that protect the developer's own databases: the previous release's Docker
 * port, then the live native runtime), then this run's own runtime, then the
 * secret file, then the connection slot. The first failing check is the
 * reported reason.
 */
export function decideE2eConnectionDoor(input: E2eDoorInput): E2eDoorDecision {
  if (input.packaged) return { kind: "inert", reason: "packaged" };

  const rawPort = input.env[E2E_DB_PORT_ENV];
  const rawPasswordFile = input.env[E2E_DB_PASSWORD_FILE_ENV];
  const hasPort = typeof rawPort === "string" && rawPort.length > 0;
  const hasPasswordFile = typeof rawPasswordFile === "string" && rawPasswordFile.length > 0;

  if (!hasPort && !hasPasswordFile) return { kind: "inert", reason: "not_requested" };
  if (!hasPort || !hasPasswordFile) {
    return {
      kind: "refused",
      reason: "partial_configuration",
      detail:
        `${E2E_DB_PORT_ENV}=${hasPort ? "set" : "unset"} ` +
        `${E2E_DB_PASSWORD_FILE_ENV}=${hasPasswordFile ? "set" : "unset"}; both are required`,
    };
  }

  // `Number` on a non-numeric string is NaN, and on "5432 " / "0x15" it is
  // permissive in ways a port must not be. Require an exact decimal spelling.
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > MAX_TCP_PORT) {
    return {
      kind: "refused",
      reason: "invalid_port",
      detail: `${E2E_DB_PORT_ENV}=${JSON.stringify(rawPort)} is not a TCP port in 1..${MAX_TCP_PORT}`,
    };
  }
  if (port === DEFAULT_PG_PORT) {
    return {
      kind: "refused",
      reason: "dev_port_collision",
      detail:
        `${E2E_DB_PORT_ENV}=${port} is the previous release's Docker Postgres port; ` +
        "an e2e run must not be pointed at the developer's own database",
    };
  }

  for (const cluster of input.runningNativeClusters) {
    if (cluster.owner !== "developer_install") continue;
    if (cluster.port === null) {
      return {
        kind: "refused",
        reason: "dev_runtime_port_unknown",
        detail:
          `the developer's own native runtime (${cluster.runtimeDir}, postmaster pid ${cluster.pid}) ` +
          "is running but has not written its port yet, so it cannot be ruled out; retry once it is up",
      };
    }
    if (cluster.port === port) {
      return {
        kind: "refused",
        reason: "dev_port_collision",
        detail:
          `${E2E_DB_PORT_ENV}=${port} is the port of the developer's own native runtime ` +
          `(${cluster.runtimeDir}, postmaster pid ${cluster.pid}); ` +
          "an e2e run must not be pointed at the developer's own database",
      };
    }
  }

  const ownCluster = input.runningNativeClusters.find((cluster) => cluster.owner === "this_run");
  if (ownCluster !== undefined) {
    return {
      kind: "refused",
      reason: "config_dir_runtime_running",
      detail:
        `the native runtime of this run's own config dir (${ownCluster.runtimeDir}) is running ` +
        `(postmaster pid ${ownCluster.pid}); a door run needs a profile no runtime is serving`,
    };
  }

  const facts = input.inspectPasswordFile(rawPasswordFile);
  if (facts === null) {
    return {
      kind: "refused",
      reason: "password_file_missing",
      detail: `${E2E_DB_PASSWORD_FILE_ENV} does not name a readable file`,
    };
  }
  if (!facts.isRegularFile) {
    return {
      kind: "refused",
      reason: "password_file_not_regular",
      detail: `${E2E_DB_PASSWORD_FILE_ENV} does not name a regular file`,
    };
  }
  // Windows mode bits do not express POSIX group/world access, so the check
  // would reject every valid Windows run for a property it cannot observe.
  if (input.platform !== "win32" && (facts.mode & 0o077) !== 0) {
    return {
      kind: "refused",
      reason: "password_file_mode",
      detail:
        `${E2E_DB_PASSWORD_FILE_ENV} is group/world-accessible ` +
        `(mode ${(facts.mode & 0o777).toString(8).padStart(3, "0")}); expected 0600`,
    };
  }
  if (facts.trimmedLength === 0) {
    return {
      kind: "refused",
      reason: "password_file_empty",
      detail: `${E2E_DB_PASSWORD_FILE_ENV} names an empty file`,
    };
  }

  if (input.connectionAlreadyPublished) {
    return {
      kind: "refused",
      reason: "connection_already_published",
      detail: "a database connection is already published; the door never displaces one",
    };
  }

  return {
    kind: "publish",
    connection: { host: LOOPBACK_DB_HOST, pgPort: port, pgPasswordPath: rawPasswordFile },
  };
}

/** Inspect the password file through the real filesystem. */
export function inspectPasswordFileOnDisk(path: string): E2ePasswordFileFacts | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return { isRegularFile: false, mode: stat.mode, trimmedLength: 0 };
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return { isRegularFile: true, mode: stat.mode, trimmedLength: content.trim().length };
}

/** Whether `pid` names a live process (EPERM: alive, someone else's). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The cluster running in `runtimeDir` now, or null. Postgres removes its
 * `postmaster.pid` on a clean stop; a file left by a crash names a dead
 * process and does not count. A file that does not parse is not a running
 * cluster either: Postgres itself refuses to start over one it cannot read.
 */
export function inspectRunningNativeCluster(
  runtimeDir: string,
  isAlive: (pid: number) => boolean = processAlive,
): { readonly pid: number; readonly port: number | null } | null {
  let text: string;
  try {
    text = readFileSync(path.join(pgDataDir(runtimeDir), "postmaster.pid"), "utf8");
  } catch {
    return null;
  }
  const file = parsePostmasterPid(text);
  if (file === null || !isAlive(file.pid)) return null;
  return { pid: file.pid, port: file.port };
}

/** The two runtime dirs the door must look at. */
export interface E2eDoorRuntimeDirs {
  /** The developer's own install: the default config dir's runtime dir. */
  readonly developerInstall: string;
  /** The config dir this boot runs on (`VEX_CONFIG_DIR` honoured). */
  readonly thisRun: string;
}

/**
 * Resolve both runtime dirs with the same resolvers `runtime-paths.ts` uses
 * for `RUNTIME_DIR`, once with the environment as it is and once without
 * `VEX_CONFIG_DIR`, so they cannot drift from where the runtime really is.
 */
export function resolveE2eDoorRuntimeDirs(deps: {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: NodeJS.ProcessEnv;
}): E2eDoorRuntimeDirs {
  const runtimeDirFor = (env: NodeJS.ProcessEnv): string =>
    resolveRuntimeDir({
      platform: deps.platform,
      homedir: deps.homedir,
      env,
      configDir: resolveConfigDir({ platform: deps.platform, homedir: deps.homedir, env }),
    });
  const withoutOverride: NodeJS.ProcessEnv = { ...deps.env };
  delete withoutOverride["VEX_CONFIG_DIR"];
  return { developerInstall: runtimeDirFor(withoutOverride), thisRun: runtimeDirFor(deps.env) };
}

/** The running clusters of both dirs, for the decision. */
export function runningNativeClustersIn(
  dirs: E2eDoorRuntimeDirs,
  isAlive: (pid: number) => boolean = processAlive,
): RunningNativeCluster[] {
  const clusters: RunningNativeCluster[] = [];
  const own = inspectRunningNativeCluster(dirs.thisRun, isAlive);
  if (own !== null) clusters.push({ owner: "this_run", runtimeDir: dirs.thisRun, ...own });
  if (path.resolve(dirs.developerInstall) !== path.resolve(dirs.thisRun)) {
    const developer = inspectRunningNativeCluster(dirs.developerInstall, isAlive);
    if (developer !== null) {
      clusters.push({ owner: "developer_install", runtimeDir: dirs.developerInstall, ...developer });
    }
  }
  return clusters;
}

/**
 * Evaluate the door for this boot and, when it opens, publish the connection.
 *
 * `options.runtimeDirs` is a test seam; production callers pass nothing and
 * get the dirs of this machine.
 *
 * @returns an idempotent disposer that stops the overwrite watcher. Callers own
 * it for the lifetime of the process; a shut door returns a no-op.
 */
export function openE2eConnectionDoor(options: { readonly runtimeDirs?: E2eDoorRuntimeDirs } = {}): () => void {
  const packaged = app.isPackaged;
  const decision = decideE2eConnectionDoor({
    packaged,
    env: process.env,
    platform: process.platform,
    connectionAlreadyPublished: getDbConnection() !== null,
    inspectPasswordFile: inspectPasswordFileOnDisk,
    // Read only when the door can open at all: a packaged boot touches no
    // runtime dir on the door's behalf.
    runningNativeClusters: packaged
      ? []
      : runningNativeClustersIn(
          options.runtimeDirs ??
            resolveE2eDoorRuntimeDirs({ platform: process.platform, homedir: homedir(), env: process.env }),
        ),
  });

  if (decision.kind === "inert") {
    // `not_requested` is the ordinary dev boot; saying so on every launch is
    // noise. `packaged` is worth one line: it is the guard that must hold.
    if (decision.reason === "packaged") {
      log.debug("[db:e2e-door] inert: packaged build");
    }
    return () => {};
  }

  if (decision.kind === "refused") {
    log.error(
      `[db:e2e-door] REFUSED (${decision.reason}): ${decision.detail}. ` +
        "No database connection was published.",
    );
    return () => {};
  }

  setDbConnection(decision.connection);
  log.warn(
    `[db:e2e-door] OPEN: published an e2e database connection on ${decision.connection.host}:${decision.connection.pgPort}. ` +
      "This path exists only for end-to-end tests and is inert in a packaged build.",
  );

  const published = decision.connection;
  return subscribeDbConnection((value) => {
    if (value === published) return;
    log.warn(
      `[db:e2e-door] the e2e connection on port ${published.pgPort} was replaced by ` +
        `${value === null ? "null" : `port ${value.pgPort}`}. ` +
        "Subsequent database work does NOT run against the e2e stack.",
    );
  });
}
