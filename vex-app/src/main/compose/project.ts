/**
 * Project naming/labels + the cwd-based `docker compose` invocation
 * contract.
 *
 * M11.5.4 — every `docker compose` invocation runs with `cwd: composeDir`
 * and relies on Compose's auto-discovery of `docker-compose.yml`. The
 * `-f <path>` flag is intentionally NEVER passed: under Docker Desktop +
 * WSL2 backend the absolute Windows path gets concatenated through a bug
 * class (`docker/compose#12669`, `#7101`) that resulted in the silent
 * `getServiceState` failure of the M11.5.3 attempt. `composeArgs` is the
 * single source of truth for that contract — it prepends the `compose`
 * subcommand and never emits `-f`.
 */

/**
 * Builds a `docker` argv for a `docker compose <…>` invocation. Prepends
 * the `compose` subcommand to the caller-supplied parts. Per the
 * cwd-based contract, callers pass `cwd: composeDir` to `runSpawn` and
 * MUST NOT include a `-f <path>` flag here.
 */
export function composeArgs(parts: readonly string[]): string[] {
  return ["compose", ...parts];
}

/**
 * Canonical compose project name for an install. Used both as
 * `compose -p <project>` and as the `com.docker.compose.project` label
 * value for label-based reuse/stop detection.
 */
export function projectName(installId: string): string {
  return `vex-${installId}`;
}

/**
 * Label selector for `docker ps --filter` matching the project's
 * containers (label survives daemon restarts; less brittle than parsing
 * `docker compose ls` JSON).
 */
export function projectLabelFilter(installId: string): string {
  return `label=com.docker.compose.project=${projectName(installId)}`;
}

/**
 * Label selector narrowing a project match to one compose service
 * (`db`, `embeddings-runtime`, ...). Combined with `projectLabelFilter`
 * by callers that need a specific container of this install rather than
 * any of them.
 */
export function serviceLabelFilter(service: string): string {
  return `label=com.docker.compose.service=${service}`;
}
