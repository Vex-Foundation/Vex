/**
 * Identity of whatever is listening on the Postgres port THIS install
 * published.
 *
 * Why this exists (measured, 2026-09-01, WSL2 mirrored networking):
 * `docker compose ls` reported project `vex-<installId>` as
 * `running(2)`, `docker inspect` reported the `db` container
 * `healthy` - and its `NetworkSettings.Ports` was `{}`. Meanwhile
 * `127.0.0.1:27432` WAS listening, owned by no process in this Linux
 * network namespace: the port belonged to a foreign (Windows-side)
 * Docker Desktop Postgres. Every connection the app opened landed on
 * another install's database. A reachability probe cannot see this:
 * `isPortFree` answers "busy" for our own listener and for a foreign
 * one alike, and Compose answers about ITS containers, not about who
 * owns the host port. The only authority is the app's own connection
 * path - connect with THIS install's credentials and check who
 * answered.
 *
 * Ownership split: this module owns the vocabulary and the
 * classification policy (pure, table-tested); `pg-health.ts` owns the
 * connection mechanics; `health.ts` owns the poll loop; `lifecycle.ts`
 * owns the declaration that a stack is usable to the app.
 */

import { runSpawn } from "../docker/spawn-runner.js";
import { projectLabelFilter, serviceLabelFilter } from "./project.js";

/** Container-internal path the compose template mounts the secret at. */
const IN_CONTAINER_SECRET_PATH = "/run/secrets/pg_password";
const DB_SERVICE_NAME = "db";
const CORROBORATION_TIMEOUT_MS = 10_000;

/**
 * What the published Postgres port turned out to be.
 *
 * The fifth outcome of the port vocabulary, "the port was already bound
 * by something else BEFORE we published it", is not produced here: it is
 * the pre-existing compose pre-flight outcome (`isPortFree` false with no
 * project of ours running) and is reported as `ComposeUpKind:
 * "port_collision"` by `lifecycle.composeUp`. This probe only ever runs
 * against a port we believe we published.
 *
 * - `usable`: authenticated with this install's secret and the server
 *   reports this install's database and role.
 * - `foreign_listener`: a Postgres answered on our port and is provably
 *   not this install's database.
 * - `stale_credentials`: our own container's Postgres rejects the same
 *   secret, so the stored password no longer matches the data volume.
 *   Not a foreign listener, and not fixable by waiting.
 * - `unreachable`: nothing usable answered - refused, timed out, closed,
 *   or the server reported a transient condition.
 */
export type PgIdentityVerdict =
  | "usable"
  | "foreign_listener"
  | "stale_credentials"
  | "unreachable";

/**
 * Raw evidence from one connection attempt, before corroboration.
 * `auth_rejected` is deliberately NOT a verdict on its own: our own
 * stack produces it too when the secret file was regenerated while the
 * data volume survived (see `stale-secret-recovery.ts`).
 */
export type PgConnectEvidence =
  | { readonly kind: "identity_ok" }
  | { readonly kind: "identity_mismatch"; readonly detail: string }
  | { readonly kind: "auth_rejected"; readonly sqlState: string }
  | { readonly kind: "server_transient"; readonly detail: string }
  | { readonly kind: "no_usable_answer"; readonly detail: string };

/**
 * SQLSTATEs that mean "this server will not serve this install's
 * database to this install's credentials". Measured live: a foreign Vex
 * Postgres on the shadowed port answers `28P01`.
 */
const IDENTITY_REJECTING_SQLSTATES: ReadonlySet<string> = new Set([
  "28000", // invalid_authorization_specification
  "28P01", // invalid_password
  "3D000", // invalid_catalog_name - the database is not on this server
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

function sqlState(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, severity } = err as { code?: unknown; severity?: unknown };
  // node-postgres puts the five-character SQLSTATE in `code` for server
  // errors and a libuv errno string (ECONNREFUSED, EPIPE, ...) in the
  // SAME field for socket errors, and `EPIPE` alone would satisfy the
  // SQLSTATE character class. `severity` ("FATAL", "ERROR", ...) is
  // present only on an error the server itself sent - measured live
  // against both a foreign Postgres and a plain closed port - so it is
  // the discriminator, with the character class as a second guard.
  if (typeof severity !== "string" || severity.length === 0) return null;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return null;
  return code;
}

/**
 * Classify one failed connection attempt. Pure: no I/O, no policy about
 * what the caller should do next.
 */
export function classifyPgConnectError(err: unknown): PgConnectEvidence {
  const state = sqlState(err);
  if (state !== null) {
    if (IDENTITY_REJECTING_SQLSTATES.has(state)) {
      return { kind: "auth_rejected", sqlState: state };
    }
    // A Postgres answered and said no for some other reason (starting
    // up, too many connections, shutting down, ...). Retryable within
    // the poll budget; the code travels in the message so the operator
    // is never told "unexpected error".
    return {
      kind: "server_transient",
      detail: `server reported SQLSTATE ${state}: ${errorMessage(err)}`,
    };
  }
  // Measured: a non-Postgres listener does not produce a protocol error.
  // It hangs until the connect timeout ("timeout expired", from an HTTP
  // or Redis server) or closes the socket ("Connection terminated
  // unexpectedly"). Our own Postgres mid-restart is indistinguishable
  // from that, so this branch stays retryable rather than accusing a
  // neighbour process.
  return { kind: "no_usable_answer", detail: errorMessage(err) };
}

/**
 * Second evidence source, consulted only when the published port
 * rejected our credentials: does our OWN db container accept the very
 * same secret from inside itself?
 */
export type PgOwnContainerEvidence =
  | { readonly kind: "authenticates" }
  | { readonly kind: "rejects" }
  | { readonly kind: "absent" }
  | { readonly kind: "inconclusive"; readonly detail: string };

/**
 * Resolve an authentication rejection on the published port into a
 * verdict. Pure; the corroboration is gathered by
 * `probeOwnDbContainerAuth`.
 *
 * - our container authenticates the same secret, or is not running at
 *   all: the rejecting listener on our port is not ours.
 * - our container rejects it too: our own cluster holds an older
 *   password than the secret file (the state
 *   `stale-secret-recovery.ts` documents). Accusing a foreign install
 *   here would send the operator hunting for a stack that does not
 *   exist.
 * - corroboration unavailable: report the honest, weaker outcome.
 */
export function verdictForAuthRejection(
  evidence: PgOwnContainerEvidence
): PgIdentityVerdict {
  switch (evidence.kind) {
    case "authenticates":
    case "absent":
      return "foreign_listener";
    case "rejects":
      return "stale_credentials";
    case "inconclusive":
      return "unreachable";
  }
}

const AUTH_FAILURE_RE = /authentication failed|no password supplied/i;

/**
 * Conservative Postgres identifier: an unquoted, already-folded name.
 * Lowercase letter or underscore first, then lowercase letters, digits
 * and underscores, bounded by Postgres' own NAMEDATALEN-1 of 63 bytes.
 *
 * Deliberately NARROWER than what Postgres would accept (no uppercase,
 * no quoting, no non-ASCII): the role and database names this probe is
 * given are produced by the compose template, and a name outside this
 * class is evidence that something other than the template chose it.
 */
const SAFE_PG_IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Whether a role or database name may be interpolated into the
 * container-side `sh -c` command below. Pure predicate, no I/O: the
 * shell is an unsafe sink, so the check belongs at the sink and not in
 * the trust the callers happen to deserve today.
 */
export function isSafePgIdentifier(value: string): boolean {
  return SAFE_PG_IDENTIFIER_RE.test(value);
}

/**
 * Ask this install's own `db` container whether it accepts the secret
 * it was started with, over TCP (so SCRAM is exercised, not the unix
 * socket's local trust path).
 *
 * The secret is read INSIDE the container from its mounted
 * `/run/secrets/pg_password`; it never appears in a host argv, a host
 * environment, or a log line. That is why the command is an `sh -c`
 * string, and why `database` and `user` - the only caller-supplied
 * values inside it - must clear `isSafePgIdentifier` before anything is
 * spawned. A name that does not clear it fails closed: `inconclusive`,
 * naming the refused FIELD and never echoing its value, which
 * `verdictForAuthRejection` resolves to `unreachable` rather than an
 * accusation.
 */
export async function probeOwnDbContainerAuth(args: {
  readonly installId: string;
  readonly database: string;
  readonly user: string;
  readonly signal?: AbortSignal;
}): Promise<PgOwnContainerEvidence> {
  const { installId, database, user, signal } = args;
  for (const [field, value] of [
    ["user", user],
    ["database", database],
  ] as const) {
    if (!isSafePgIdentifier(value)) {
      return {
        kind: "inconclusive",
        detail: `in-container auth check refused: the \`${field}\` argument is not a safe Postgres identifier`,
      };
    }
  }

  const ps = await runSpawn(
    "docker",
    [
      "ps",
      "--filter",
      projectLabelFilter(installId),
      "--filter",
      serviceLabelFilter(DB_SERVICE_NAME),
      "--filter",
      "status=running",
      "--format",
      "{{.ID}}",
    ],
    {
      timeoutMs: CORROBORATION_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (ps.code !== 0) {
    return {
      kind: "inconclusive",
      detail: `\`docker ps\` exited with ${ps.code ?? "unknown"} while looking for this install's db container`,
    };
  }
  const containerId = ps.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (containerId === undefined) {
    return { kind: "absent" };
  }

  const exec = await runSpawn(
    "docker",
    [
      "exec",
      containerId,
      "sh",
      "-c",
      `PGPASSWORD="$(cat ${IN_CONTAINER_SECRET_PATH})" psql -h 127.0.0.1 -U ${user} -d ${database} -tAc "select 1"`,
    ],
    {
      timeoutMs: CORROBORATION_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (exec.code === 0) return { kind: "authenticates" };
  if (AUTH_FAILURE_RE.test(exec.stderr)) return { kind: "rejects" };
  return {
    kind: "inconclusive",
    detail: `in-container auth check exited with ${exec.code ?? "unknown"}`,
  };
}
