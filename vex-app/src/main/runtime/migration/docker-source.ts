/**
 * The previous release's Docker stack as the migration SOURCE (plan D11): the
 * only Docker use left once the native runtime ships. Everything here goes
 * through the existing compose code; nothing is reimplemented.
 *
 *   probe        is Docker answering, and does this install's Postgres volume
 *                exist? Read-only (`docker volume inspect`), never starts
 *                Docker Desktop.
 *   bringUpDb    the old stack's `db` service ALONE (`compose up -d db`),
 *                starting Docker Desktop if needed, then the same identity
 *                probe composeUp uses. Refuses when the volume is gone:
 *                `up` would create an empty one, and an empty database would
 *                "migrate" perfectly into nothing.
 *   stop         `compose stop` (composeDown). Never `down`, never `--volumes`.
 *   removeData   `compose down --volumes` for this project only: the Settings
 *                action, guarded by the caller (docker-to-native.ts).
 *
 * The volume is only ever read (pg_dump over TCP) by the migration.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { checkDockerDaemon } from "../../docker/daemon.js";
import { runSpawn } from "../../docker/spawn-runner.js";
import { composeDown } from "../../compose/lifecycle.js";
import { waitForHealth } from "../../compose/health.js";
import { checkComposeFloor, ensureDockerDaemonReady, inspectDockerEndpointPolicy } from "../../compose/preflight.js";
import { composeArgs, postgresVolumeName, projectName } from "../../compose/project.js";
import { recreateProjectNonDestructively } from "../../compose/recreate.js";
import { renderCompose, renderedComposePath, type RenderDeps } from "../../compose/render.js";
import { STALE_BIND_MOUNT_RE } from "../../compose/stale-secret-recovery.js";
import { composeUpDetached } from "../../compose/up.js";
import { resolvePgPort } from "../../paths/service-ports.js";
import { chooseFreePort } from "../native/free-port.js";

const DB_SERVICE = "db";
const VOLUME_INSPECT_TIMEOUT_MS = 15_000;
const DOWN_VOLUMES_TIMEOUT_MS = 120_000;
const NO_SUCH_VOLUME_RE = /no such volume/i;

export type DockerVolumeProbe =
  | { readonly kind: "volume_present" }
  | { readonly kind: "volume_absent" }
  | { readonly kind: "unreachable"; readonly detail: string };

export type DockerSourceUp =
  | {
      readonly kind: "ready";
      readonly pgPort: number;
      /** The readable pg_password file the stack mounts (main-process only). */
      readonly passwordPath: string;
    }
  | { readonly kind: "docker_unavailable"; readonly message: string }
  | { readonly kind: "no_volume"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export interface DockerSourceStop {
  readonly kind: "stopped" | "not_running" | "failed";
  readonly message: string;
}

export interface DockerDataRemoval {
  readonly kind: "removed" | "docker_unavailable" | "failed";
  readonly message: string;
}

export interface DockerSource {
  probe(installId: string, signal?: AbortSignal): Promise<DockerVolumeProbe>;
  bringUpDb(
    installId: string,
    options: { readonly signal?: AbortSignal; readonly onLogLine?: (stream: "stdout" | "stderr", line: string) => void },
  ): Promise<DockerSourceUp>;
  stop(installId: string, signal?: AbortSignal): Promise<DockerSourceStop>;
  removeData(installId: string, signal?: AbortSignal): Promise<DockerDataRemoval>;
}

function lastLines(text: string, n = 3): string {
  return text.trim().split("\n").slice(-n).join(" ");
}

async function inspectVolume(installId: string, signal: AbortSignal | undefined): Promise<DockerVolumeProbe> {
  const result = await runSpawn("docker", ["volume", "inspect", "--format", "{{.Name}}", postgresVolumeName(installId)], {
    timeoutMs: VOLUME_INSPECT_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.code === 0 && result.stdout.trim() === postgresVolumeName(installId)) return { kind: "volume_present" };
  if (result.code !== 0 && NO_SUCH_VOLUME_RE.test(result.stderr)) return { kind: "volume_absent" };
  return {
    kind: "unreachable",
    detail: result.timedOut ? "docker volume inspect timed out" : lastLines(result.stderr) || `docker volume inspect exited with ${String(result.code)}`,
  };
}

/** The endpoint policy and the daemon, without starting anything. */
async function dockerAnswers(signal: AbortSignal | undefined): Promise<string | null> {
  const endpoint = await inspectDockerEndpointPolicy(signal);
  if (!endpoint.accepted) return endpoint.message ?? "Docker endpoint policy rejected this request.";
  const daemon = await checkDockerDaemon(signal);
  return daemon.ok ? null : daemon.reason;
}

export function createDockerSource(options: {
  readonly renderDeps: RenderDeps;
  /**
   * The port to publish the old database on. Omitted: this install's
   * (VEX_PG_PORT, else 27432) when it is free, otherwise any free loopback
   * port. The migration only needs the database reachable, and the native
   * release has no other use for the fixed port, so a neighbour holding it
   * must not block the copy.
   */
  readonly pgPort?: number;
}): DockerSource {
  const { renderDeps } = options;
  const composePath = renderedComposePath(renderDeps.userDataDir);

  return {
    async probe(installId, signal) {
      const unavailable = await dockerAnswers(signal);
      if (unavailable !== null) return { kind: "unreachable", detail: unavailable };
      return inspectVolume(installId, signal);
    },

    async bringUpDb(installId, { signal, onLogLine }) {
      const endpoint = await inspectDockerEndpointPolicy(signal);
      if (!endpoint.accepted) {
        return { kind: "docker_unavailable", message: endpoint.message ?? "Docker endpoint policy rejected this request." };
      }
      const floor = await checkComposeFloor(signal);
      if (floor !== null) return { kind: "docker_unavailable", message: floor };
      const daemon = await ensureDockerDaemonReady({
        ...(signal !== undefined ? { signal } : {}),
        onStatus: (status) => onLogLine?.("stdout", status),
      });
      if (daemon.kind !== "ready" && daemon.kind !== "auto_started") {
        return { kind: "docker_unavailable", message: `Docker is not ready: ${daemon.message}` };
      }

      const volume = await inspectVolume(installId, signal);
      if (volume.kind === "volume_absent") {
        return { kind: "no_volume", message: `This install's database volume ${postgresVolumeName(installId)} does not exist.` };
      }
      if (volume.kind === "unreachable") return { kind: "docker_unavailable", message: volume.detail };

      // Re-rendered as composeUp does: same template, same install id, and on
      // Windows a fresh decrypted copy of the password for the stack to mount.
      // A changed port only recreates the container; the volume is the same.
      const pgPort = options.pgPort ?? (await chooseFreePort([resolvePgPort()]));
      const rendered = await renderCompose(renderDeps, { pgPort });
      if (rendered.installId !== installId) {
        return {
          kind: "failed",
          message: `This install's id changed (${rendered.installId}) since the migration began for ${installId}.`,
        };
      }
      const composeDir = path.dirname(rendered.outPath);
      onLogLine?.("stdout", `Starting the old database (${projectName(installId)}, service ${DB_SERVICE} only)…`);
      const services = [DB_SERVICE];
      let up = await composeUpDetached({
        composeDir,
        services,
        ...(signal !== undefined ? { signal } : {}),
        ...(onLogLine !== undefined ? { onLogLine } : {}),
      });
      if (up.code !== 0 && !up.timedOut && !up.aborted && STALE_BIND_MOUNT_RE.test(up.stderr)) {
        // Docker Desktop's stale bind-mount cache: recreate the containers
        // (no --volumes, secret untouched), as composeUp's reuse path does.
        up = (
          await recreateProjectNonDestructively({
            composeDir,
            installId,
            services,
            ...(signal !== undefined ? { signal } : {}),
            ...(onLogLine !== undefined ? { onLogLine } : {}),
          })
        ).upResult;
      }
      if (up.code !== 0) {
        return {
          kind: "failed",
          message: up.timedOut
            ? "Starting the old database timed out."
            : `Starting the old database failed (exit ${String(up.code)}): ${lastLines(up.stderr)}`,
        };
      }

      const health = await waitForHealth({
        pgPort,
        pgPasswordPath: rendered.pgPasswordComposePath,
        installId,
        ...(signal !== undefined ? { signal } : {}),
        ...(onLogLine !== undefined ? { onLogLine } : {}),
      });
      if (health.verdict !== "usable") return { kind: "failed", message: health.message };
      return { kind: "ready", pgPort, passwordPath: rendered.pgPasswordComposePath };
    },

    async stop(installId, signal) {
      return composeDown(composePath, installId, signal);
    },

    async removeData(installId, signal) {
      const unavailable = await dockerAnswers(signal);
      if (unavailable !== null) return { kind: "docker_unavailable", message: unavailable };
      // The project file names the volumes `down --volumes` removes; render it
      // if it is gone, from the same template, for the same install id.
      const present = await fs.access(composePath).then(
        () => true,
        () => false,
      );
      if (!present) {
        const rendered = await renderCompose(renderDeps, { pgPort: options.pgPort ?? resolvePgPort() });
        if (rendered.installId !== installId) {
          return { kind: "failed", message: `This install's id is ${rendered.installId}, not ${installId}.` };
        }
      }
      const down = await runSpawn("docker", composeArgs(["-p", projectName(installId), "down", "--volumes", "--remove-orphans"]), {
        cwd: path.dirname(composePath),
        timeoutMs: DOWN_VOLUMES_TIMEOUT_MS,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (down.code !== 0) {
        return { kind: "failed", message: `Removing the old Docker data failed (exit ${String(down.code)}): ${lastLines(down.stderr)}` };
      }
      const after = await inspectVolume(installId, signal);
      if (after.kind !== "volume_absent") {
        return { kind: "failed", message: `The volume ${postgresVolumeName(installId)} is still there after compose down --volumes.` };
      }
      return { kind: "removed", message: `Removed the old Docker data of ${projectName(installId)}.` };
    },
  };
}
