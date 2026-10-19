/**
 * Compose pre-flight checks for the migration from the previous release:
 * compose version floor and Docker endpoint policy / daemon readiness. They
 * gate bringing that release's stack up before any compose call runs.
 *
 * The endpoint-policy and daemon-readiness probes are re-exported here so
 * the migration imports its pre-flight surface from one place.
 */

import { runSpawn } from "../docker/spawn-runner.js";
import { parseComposeVersion } from "../docker/probe/parsers.js";
import { COMPOSE_VERSION_FLOOR, semverGte } from "../docker/probe/version.js";
import { ensureDockerDaemonReady } from "../docker/daemon.js";
import { inspectDockerEndpointPolicy } from "../docker/endpoint-policy.js";
import { composeArgs } from "./project.js";

export { ensureDockerDaemonReady, inspectDockerEndpointPolicy };

/**
 * Pre-flight that `docker compose` is at the inline-`configs.content:`
 * floor (`COMPOSE_VERSION_FLOOR`). Returning a non-null message means
 * we MUST abort the compose start — the template would otherwise error with
 * "unknown field: content" deep into the call. Codex turn 1 YELLOW —
 * use a real semver comparison so `v2.23.1-desktop.1` is accepted.
 */
export async function checkComposeFloor(
  signal?: AbortSignal
): Promise<string | null> {
  const result = await runSpawn(
    "docker",
    composeArgs(["version"]),
    signal !== undefined ? { signal } : {}
  );
  if (result.code !== 0) {
    return "Docker Compose is not installed or not on PATH.";
  }
  const version = parseComposeVersion(result.stdout);
  if (!semverGte(version, COMPOSE_VERSION_FLOOR)) {
    return `Docker Compose ${
      version ?? "(unknown)"
    } is below the minimum supported version ${COMPOSE_VERSION_FLOOR}. Update Docker Desktop or the standalone compose plugin and retry.`;
  }
  return null;
}
