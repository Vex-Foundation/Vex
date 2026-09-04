/**
 * Service health: label-based project liveness detection + the poll loop
 * that decides whether the published Postgres port is THIS install's
 * database.
 *
 * `isOurProjectActive` powers the reuse path. `waitForHealth` polls
 * `pgConnectProbe` and returns a `PgIdentityVerdict`, not a boolean:
 * "did not answer" and "answered, but it is not our database" are
 * different facts with different remedies, and only the first one is
 * worth waiting out. See `pg-listener-identity.ts` for why a
 * reachability answer cannot stand in for an identity answer.
 */

import { runSpawn } from "../docker/spawn-runner.js";
import { pgConnectProbe, DEFAULT_PG_DATABASE, DEFAULT_PG_USER } from "./pg-health.js";
import {
  probeOwnDbContainerAuth,
  verdictForAuthRejection,
  type PgIdentityVerdict,
} from "./pg-listener-identity.js";
import { projectLabelFilter } from "./project.js";

export const HEALTH_POLL_INTERVAL_MS = 2_000;
export const HEALTH_TIMEOUT_MS = 60_000;

export async function isOurProjectActive(
  installId: string,
  signal?: AbortSignal
): Promise<boolean> {
  // `docker ps --filter label=com.docker.compose.project=...` is the
  // skill-recommended detection (label survives daemon restarts; less
  // brittle than parsing `docker compose ls` JSON).
  const result = await runSpawn(
    "docker",
    [
      "ps",
      "--filter",
      projectLabelFilter(installId),
      "--format",
      "{{.ID}}",
    ],
    { signal }
  );
  if (result.code !== 0) return false;
  return result.stdout.trim().length > 0;
}

/** Verdict plus the sanitized sentence explaining how it was reached. */
export interface PgListenerHealth {
  readonly verdict: PgIdentityVerdict;
  readonly message: string;
}

interface HealthProbeArgs {
  readonly pgPort: number;
  readonly pgPasswordPath: string;
  readonly installId: string;
  readonly attempt: number;
  readonly signal?: AbortSignal;
  readonly onLogLine?: (stream: "stdout" | "stderr", line: string) => void;
}

/**
 * One probe's outcome plus whether polling should stop.
 *
 * `terminal` is not derivable from the verdict alone: a credential
 * rejection ends the loop even when the corroboration was inconclusive
 * and the honest verdict stays `unreachable`. The stored password
 * cannot change while we poll, and re-running the container
 * corroboration every interval would spawn a `docker exec` per attempt.
 */
interface ProbeOutcome extends PgListenerHealth {
  readonly terminal: boolean;
}

async function probeListenerIdentity(
  args: HealthProbeArgs
): Promise<ProbeOutcome> {
  args.onLogLine?.(
    "stdout",
    `Postgres identity probe #${args.attempt}: connecting on 127.0.0.1:${args.pgPort}…`
  );
  const evidence = await pgConnectProbe({
    host: "127.0.0.1",
    port: args.pgPort,
    database: DEFAULT_PG_DATABASE,
    user: DEFAULT_PG_USER,
    pgPasswordPath: args.pgPasswordPath,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });

  switch (evidence.kind) {
    case "identity_ok":
      return {
        verdict: "usable",
        terminal: true,
        message: `Postgres on 127.0.0.1:${args.pgPort} is this install's database.`,
      };
    case "identity_mismatch":
      return {
        verdict: "foreign_listener",
        terminal: true,
        message: `127.0.0.1:${args.pgPort} is served by a different database: ${evidence.detail}.`,
      };
    case "auth_rejected": {
      // Our own container produces this too when the secret file was
      // regenerated while the data volume survived. Ask the container
      // itself before naming a foreign owner.
      const own = await probeOwnDbContainerAuth({
        installId: args.installId,
        database: DEFAULT_PG_DATABASE,
        user: DEFAULT_PG_USER,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
      const verdict = verdictForAuthRejection(own);
      if (verdict === "foreign_listener") {
        return {
          verdict,
          terminal: true,
          message:
            own.kind === "absent"
              ? `127.0.0.1:${args.pgPort} is held by a Postgres that rejects this install's credentials, and this install's own database container is not running. Another Vex install or another Postgres owns that port.`
              : `127.0.0.1:${args.pgPort} rejects this install's credentials while this install's own database container accepts them, so the port is served by a different Postgres. On Windows with WSL2 mirrored networking a Docker Desktop stack on the other side of the boundary takes the loopback port this way.`,
        };
      }
      if (verdict === "stale_credentials") {
        return {
          verdict,
          terminal: true,
          message: `This install's stored Postgres password no longer matches its database volume - the database container rejects it too. The port is not being shadowed by another install.`,
        };
      }
      return {
        // Terminal despite the weaker verdict: a rejected password is
        // not going to be accepted on the next poll, and each retry
        // would spawn another corroboration `docker exec`.
        verdict,
        terminal: true,
        message: `127.0.0.1:${args.pgPort} rejected this install's credentials (SQLSTATE ${evidence.sqlState}) and the owning container could not be checked: ${
          own.kind === "inconclusive" ? own.detail : "no detail"
        }.`,
      };
    }
    case "server_transient":
      return {
        verdict: "unreachable",
        terminal: false,
        message: `Postgres on 127.0.0.1:${args.pgPort} is not serving yet: ${evidence.detail}.`,
      };
    case "no_usable_answer":
      return {
        verdict: "unreachable",
        terminal: false,
        message: `127.0.0.1:${args.pgPort} did not answer usably: ${evidence.detail}.`,
      };
  }
}

interface WaitForHealthArgs {
  readonly pgPort: number;
  readonly pgPasswordPath: string;
  readonly installId: string;
  readonly signal?: AbortSignal;
  readonly onLogLine?: (stream: "stdout" | "stderr", line: string) => void;
}

/**
 * Poll until the published port proves it is this install's database, a
 * terminal verdict lands, or the budget expires. A terminal verdict
 * (`foreign_listener`, `stale_credentials`) stops the loop immediately:
 * the credentials behind it cannot change while we wait, and reporting
 * "not healthy yet" for 60s would hide the real cause.
 */
export async function waitForHealth(
  args: WaitForHealthArgs
): Promise<PgListenerHealth> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let attempt = 0;
  let last: ProbeOutcome = {
    verdict: "unreachable",
    terminal: false,
    message: `Postgres on 127.0.0.1:${args.pgPort} was not probed.`,
  };
  while (Date.now() < deadline) {
    if (args.signal?.aborted) {
      return {
        verdict: "unreachable",
        message: "Postgres identity probe aborted.",
      };
    }
    attempt += 1;
    last = await probeListenerIdentity({
      pgPort: args.pgPort,
      pgPasswordPath: args.pgPasswordPath,
      installId: args.installId,
      attempt,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
      ...(args.onLogLine !== undefined ? { onLogLine: args.onLogLine } : {}),
    });
    if (last.verdict === "usable") {
      args.onLogLine?.(
        "stdout",
        `Postgres identity probe #${attempt}: ready.`
      );
      return { verdict: last.verdict, message: last.message };
    }
    args.onLogLine?.(
      "stderr",
      `Postgres identity probe #${attempt}: ${last.message}`
    );
    if (last.terminal) return { verdict: last.verdict, message: last.message };
    await new Promise<void>((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return {
    verdict: "unreachable",
    message: `Postgres on 127.0.0.1:${args.pgPort} did not accept a connection from this install within ${
      HEALTH_TIMEOUT_MS / 1000
    }s. Last probe: ${last.message}`,
  };
}
