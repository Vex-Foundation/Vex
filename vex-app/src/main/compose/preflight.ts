/**
 * Compose up/down pre-flight checks: compose version floor, Docker
 * endpoint policy / daemon readiness, and host port availability. These
 * gate `composeUp` before any image pull or `up -d` runs.
 *
 * The endpoint-policy and daemon-readiness probes and the `isPortFree`
 * host-port check are re-exported here so the lifecycle orchestrator
 * imports its pre-flight surface from one place.
 */

import { runSpawn } from "../docker/spawn-runner.js";
import { parseComposeVersion } from "../docker/probe/parsers.js";
import { isPortFree } from "../docker/probe/ports.js";
import { COMPOSE_VERSION_FLOOR, semverGte } from "../docker/probe/version.js";
import { ensureDockerDaemonReady } from "../docker/daemon.js";
import { inspectDockerEndpointPolicy } from "../docker/endpoint-policy.js";
import { composeArgs } from "./project.js";

export { isPortFree, ensureDockerDaemonReady, inspectDockerEndpointPolicy };

/**
 * Pre-flight that `docker compose` is at the inline-`configs.content:`
 * floor (`COMPOSE_VERSION_FLOOR`). Returning a non-null message means
 * we MUST abort `composeUp` — the template would otherwise error with
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
