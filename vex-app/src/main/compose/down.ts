/**
 * `composeDown`: stop a compose project without removing anything. It uses
 * `stop`, never `down --volumes` (skill §10). The primary path drives
 * compose via `cwd` (M11.5.4 — never `-f`). If the compose dir/YAML
 * vanished underneath us (uninstall path), it falls back to a label-based
 * `docker ps` + `docker stop` that needs no compose file at all.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { inspectDockerEndpointPolicy } from "../docker/endpoint-policy.js";
import { runSpawn, type SpawnRunnerResult } from "../docker/spawn-runner.js";
import { composeArgs, projectName, projectLabelFilter } from "./project.js";

export type ComposeDownKind = "stopped" | "not_running" | "failed";

export interface ComposeDownResult {
  readonly kind: ComposeDownKind;
  readonly message: string;
}

export interface DockerContainerCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AllRunningComposeProjectsQuery {
  readonly kind: "all-compose-projects";
}

function spawnOptions(
  input?: AbortSignal | DockerContainerCommandOptions,
): DockerContainerCommandOptions {
  if (input === undefined) return {};
  return input instanceof AbortSignal ? { signal: input } : input;
}

// Codex review turn 2 YELLOW #6: `compose stop` may fail with a
// "no compose file" error if the YAML disappeared while the dir
// still exists. In that case, fall through to the label-based path
// — it does not need a compose file.
export const COMPOSE_FILE_MISSING_RE =
  /no configuration file|no compose file|does not exist|compose\.ya?ml.*not found/i;

/**
 * `docker compose -p <project> stop` driven via `cwd: composeDir` so we
 * never feed a Windows absolute path through the buggy `-f` resolver.
 */
export async function composeStop(
  installId: string,
  composeDir: string,
  signal?: AbortSignal
): Promise<SpawnRunnerResult> {
  return runSpawn(
    "docker",
    composeArgs(["-p", projectName(installId), "stop"]),
    {
      cwd: composeDir,
      ...(signal !== undefined ? { signal } : {}),
    }
  );
}

/**
 * List the project's running container IDs via the compose project
 * label. `-a` would include exited init containers; we filter to
 * `status=running` because `docker stop` errors on already-exited
 * containers.
 */
export async function listRunningProjectContainers(
  installId: string,
  signal?: AbortSignal,
): Promise<SpawnRunnerResult>;
export async function listRunningProjectContainers(
  query: AllRunningComposeProjectsQuery,
  options?: DockerContainerCommandOptions,
): Promise<SpawnRunnerResult>;
export async function listRunningProjectContainers(
  installIdOrQuery: string | AllRunningComposeProjectsQuery,
  signalOrOptions?: AbortSignal | DockerContainerCommandOptions,
): Promise<SpawnRunnerResult> {
  const options = spawnOptions(signalOrOptions);
  if (typeof installIdOrQuery !== "string") {
    return runSpawn(
      "docker",
      [
        "ps",
        "--no-trunc",
        "--filter",
        "status=running",
        "--format",
        '{{.ID}}\t{{.Label "com.docker.compose.project"}}',
      ],
      options,
    );
  }
  return runSpawn(
    "docker",
    [
      "ps",
      "--filter",
      projectLabelFilter(installIdOrQuery),
      "--filter",
      "status=running",
      "--format",
      "{{.ID}}",
    ],
    options,
  );
}

/**
 * `docker stop <id…>` for the label-fallback path.
 */
export async function stopContainers(
  ids: readonly string[],
  signalOrOptions?: AbortSignal | DockerContainerCommandOptions,
): Promise<SpawnRunnerResult> {
  return runSpawn(
    "docker",
    ["stop", ...ids],
    spawnOptions(signalOrOptions),
  );
}

/**
 * Stop the project, keeping its containers and volumes. A vanished compose
 * dir or YAML falls back to stopping the project's labelled containers.
 */
export async function composeDown(
  composeOutPath: string,
  installId: string,
  signal?: AbortSignal
): Promise<ComposeDownResult> {
  const composeDir = path.dirname(composeOutPath);
  const endpoint = await inspectDockerEndpointPolicy(signal);
  if (!endpoint.accepted) {
    return {
      kind: "failed",
      message: endpoint.message ?? "Docker endpoint policy rejected this request.",
    };
  }

  // Codex turn 1 RED #1 / R7 — drive compose via cwd so we never feed
  // a Windows absolute path through the buggy `-f` resolver. If the
  // compose dir vanished underneath us (uninstall path), fall back to
  // a label-based `docker stop` of the project's containers — that
  // path does not require a compose file at all.
  let dirExists = true;
  try {
    await fs.access(composeDir);
  } catch {
    dirExists = false;
  }

  // Codex review turn 2 YELLOW #6: `compose stop` may fail with a
  // "no compose file" error if the YAML disappeared while the dir
  // still exists. In that case, fall through to the label-based path
  // — it does not need a compose file.
  if (dirExists) {
    const result = await composeStop(installId, composeDir, signal);
    if (result.code === 0) {
      return {
        kind: "stopped",
        message: `Stopped vex-${installId} compose project.`,
      };
    }
    if (/no such project|not found/i.test(result.stderr)) {
      return { kind: "not_running", message: "Project was not running." };
    }
    // YAML missing? Pretend dir is gone and try label fallback.
    if (!COMPOSE_FILE_MISSING_RE.test(result.stderr)) {
      return {
        kind: "failed",
        message: `\`docker compose stop\` exited with ${
          result.code ?? "unknown"
        }: ${result.stderr.split("\n").slice(-3).join(" ")}`,
      };
    }
  }

  // Compose dir gone OR YAML missing — list running containers via
  // the project label and stop them directly via the engine. `-a`
  // would include exited init containers; we filter to `status=running`
  // because `docker stop` errors on already-exited containers.
  const list = await listRunningProjectContainers(installId, signal);
  // Codex review turn 2 YELLOW #6: distinguish a docker ps failure
  // (engine down, permission denied) from "ps succeeded but no
  // containers matched the label". The former MUST be a failure
  // result; the latter is genuinely "not running".
  if (list.code !== 0) {
    return {
      kind: "failed",
      message: `\`docker ps\` exited with ${
        list.code ?? "unknown"
      } while looking for vex-${installId} containers: ${list.stderr
        .split("\n")
        .slice(-3)
        .join(" ")}`,
    };
  }
  const ids = list.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    return {
      kind: "not_running",
      message:
        "No running containers carry the project label; nothing to stop.",
    };
  }
  const stopResult = await stopContainers(ids, signal);
  if (stopResult.code === 0) {
    return {
      kind: "stopped",
      message: `Stopped ${ids.length} container(s) for vex-${installId} via label fallback.`,
    };
  }
  return {
    kind: "failed",
    message: `Label-based stop exited with ${
      stopResult.code ?? "unknown"
    }: ${stopResult.stderr.split("\n").slice(-3).join(" ")}`,
  };
}
