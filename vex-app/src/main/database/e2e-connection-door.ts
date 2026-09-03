/**
 * The E2E database door: the ONE way an end-to-end run can hand the main
 * process a Postgres it did not start through Docker Compose.
 *
 * ## Why a door exists at all
 *
 * `connection-state.ts` has exactly one production writer - the compose
 * handler in `main/ipc/docker.ts`, which publishes after a `running` /
 * `reused` compose result. That is correct for the product and useless for a
 * test: `composeUp` renders a stack keyed by the config dir's install id and
 * refuses ports another stack already holds, so a per-run `composeUp` either
 * collides with the developer's live Vex stack or leaves a second Postgres
 * behind. An isolated e2e database therefore needs its own publication path,
 * and that path is this module.
 *
 * ## The authority this door takes, and the guards on it
 *
 * It publishes a database connection, which is real authority over where the
 * app's data goes. It is narrow on purpose:
 *
 *   - INERT in a packaged app (`app.isPackaged`). A shipped Vex has no door.
 *   - Requires BOTH `VEX_E2E_DB_PORT` and `VEX_E2E_DB_PASSWORD_FILE`. Exactly
 *     one of them is a refusal, never a partial guess.
 *   - Refuses {@link DEFAULT_PG_PORT}, the port the developer's own compose
 *     stack publishes. A door that could point at the real stack is not
 *     isolation. The constant is IMPORTED, never respelled here.
 *   - Refuses a password file that is missing, not a regular file, empty, or
 *     group/world-accessible (POSIX only - Windows mode bits carry no such
 *     meaning).
 *   - Refuses when a connection is already published, so the door can never
 *     displace a live compose stack.
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
 * bootstrap, long before the renderer can invoke `vex.docker.composeUp`. So in
 * practice the door is first and compose is second. The door does not - and
 * cannot from here - stop a later `composeUp` from replacing its connection;
 * `main/ipc/docker.ts` owns that write and is not this module's to change.
 * What the door does instead is OBSERVE: it subscribes to the connection state
 * for as long as it is open and logs a loud warning if its connection is ever
 * replaced or cleared. A later overwrite is therefore diagnosable in the run
 * log rather than silent, which is the property that actually matters when an
 * e2e assertion starts reading a database nobody expected.
 */

import { app } from "electron";
import { readFileSync, statSync } from "node:fs";
import { DEFAULT_PG_PORT } from "../../shared/local-service-ports.js";
import { log } from "../logger/index.js";
import {
  getDbConnection,
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

/** Everything the pure decision reads. */
export interface E2eDoorInput {
  readonly packaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly connectionAlreadyPublished: boolean;
  /** Returns `null` when the path cannot be inspected at all. */
  readonly inspectPasswordFile: (path: string) => E2ePasswordFileFacts | null;
}

/** The highest port a TCP listener can occupy. */
const MAX_TCP_PORT = 65_535;

/**
 * Decide, purely, whether this boot may open the door.
 *
 * Order matters: configuration completeness first, then the port (the guard
 * that protects the developer's own stack), then the secret file, then the
 * connection slot. The first failing check is the reported reason.
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
        `${E2E_DB_PORT_ENV}=${port} is the default compose Postgres port; ` +
        "an e2e run must not be pointed at the developer's own stack",
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
    connection: { pgPort: port, pgPasswordPath: rawPasswordFile },
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

/**
 * Evaluate the door for this boot and, when it opens, publish the connection.
 *
 * @returns an idempotent disposer that stops the overwrite watcher. Callers own
 * it for the lifetime of the process; a shut door returns a no-op.
 */
export function openE2eConnectionDoor(): () => void {
  const decision = decideE2eConnectionDoor({
    packaged: app.isPackaged,
    env: process.env,
    platform: process.platform,
    connectionAlreadyPublished: getDbConnection() !== null,
    inspectPasswordFile: inspectPasswordFileOnDisk,
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
    `[db:e2e-door] OPEN: published an e2e database connection on 127.0.0.1:${decision.connection.pgPort}. ` +
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
