/**
 * Compose up/down lifecycle. Pre-flight port check + label-based reuse
 * detection (codex turn 4 YELLOW #6 — `docker ps --filter label=...`,
 * NOT `docker compose ls`). composeDown uses `stop`, never
 * `down --volumes` (skill §10).
 *
 * M11.5.4 — all `docker compose` invocations run with `cwd: composeDir`
 * and rely on Compose's auto-discovery of `docker-compose.yml`. The
 * `-f <path>` flag is intentionally never passed: under Docker Desktop
 * + WSL2 backend the absolute Windows path gets concatenated through
 * a bug class (`docker/compose#12669`, `#7101`) that resulted in the
 * silent `getServiceState` failure of the M11.5.3 attempt.
 *
 * Structural note: this file is the public façade. The pre-flight,
 * project-contract, pull/up, health, stale-secret recovery, and down
 * internals live in dedicated sibling modules; `composeUp`/`composeDown`
 * stay here as the orchestrators that wire them together.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_EMBED_PORT } from "../onboarding/embedding-defaults.js";
import { DEFAULT_PG_PORT } from "@shared/local-service-ports.js";
import {
  waitForEmbeddingsRuntimeReady,
  type EmbeddingsReadinessKind,
} from "./embeddings-health.js";
import { renderCompose, type RenderDeps } from "./render.js";
import {
  checkComposeFloor,
  ensureDockerDaemonReady,
  inspectDockerEndpointPolicy,
  isPortFree,
} from "./preflight.js";
import { isOurProjectActive, waitForHealth } from "./health.js";
import {
  clearStaleSecretCache,
  STALE_BIND_MOUNT_RE,
} from "./stale-secret-recovery.js";
import {
  PULL_TIMEOUT_MS,
  UP_TIMEOUT_MS,
  composePull,
  composeUpDetached,
} from "./up.js";
import { recreateProjectNonDestructively } from "./recreate.js";
import {
  COMPOSE_FILE_MISSING_RE,
  composeStop,
  listRunningProjectContainers,
  stopContainers,
} from "./down.js";
import { findPreviousInstallContainersHoldingPorts } from "./orphan-stacks.js";

export type ComposeUpKind =
  | "running"
  | "reused"
  | "port_collision"
  | "foreign_listener"
  | "unhealthy"
  | "failed";

export interface ComposeUpResult {
  readonly kind: ComposeUpKind;
  readonly composeOutPath: string;
  readonly installId: string;
  readonly message: string;
  readonly previousInstallHoldingPorts: boolean;
  /** Main-only occupied ports used to reauthorize a previous-stack stop. */
  readonly conflictPorts: ReadonlyArray<number>;
  /**
   * Port the published Postgres bound to on the loopback interface.
   * Always populated (even on failure paths) so the database handler
   * can derive a connection config without re-rendering compose.
   */
  readonly pgPort: number;
  /**
   * Port the published embeddings-runtime bound to. Always populated
   * for the same reason as `pgPort` — the wizard's auto-write defaults
   * step needs the published value, not a hardcoded constant.
   */
  readonly embedPort: number;
  /**
   * Absolute path to the secret file the compose stack mounts as
   * `/run/secrets/pg_password`. Same content (after read) is the
   * Postgres password. Main-process-internal — IPC handler MUST strip
   * before returning to renderer (the public schema is `.strict()`).
   */
  readonly pgPasswordPath: string;
  /**
   * Outcome of the host-side embeddings-runtime readiness probe.
   * `null` means the probe was not reached (failure earlier in the
   * pipeline). Surfaced for diagnostics; the renderer reads `kind`
   * primarily.
   */
  readonly embeddingsReadiness: EmbeddingsReadinessKind | null;
}

export type ComposeDownKind = "stopped" | "not_running" | "failed";

export interface ComposeDownResult {
  readonly kind: ComposeDownKind;
  readonly message: string;
}

export interface ComposeUpOptions {
  readonly pgPort?: number;
  readonly embedPort?: number;
  readonly signal?: AbortSignal;
  readonly onLogLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export async function composeUp(
  deps: RenderDeps,
  options: ComposeUpOptions = {}
): Promise<ComposeUpResult> {
  const {
    signal,
    onLogLine,
    pgPort = DEFAULT_PG_PORT,
    embedPort = DEFAULT_EMBED_PORT,
  } = options;
  const renderOptions = { pgPort, embedPort };

  const endpoint = await inspectDockerEndpointPolicy(signal);
  if (!endpoint.accepted) {
    const rendered = await renderCompose(deps, renderOptions);
    return {
      kind: "failed",
      composeOutPath: rendered.outPath,
      installId: rendered.installId,
      message: endpoint.message ?? "Docker endpoint policy rejected this request.",
      pgPort,
      embedPort: rendered.embedPort,
      pgPasswordPath: rendered.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }

  // Compose-floor pre-check. Inline `configs.content:` is parsed only
  // by Compose ≥ 2.23.1; below that, `compose up` fails with a cryptic
  // "unknown field: content" error from the YAML loader. We surface a
  // direct upgrade hint instead.
  const floorErr = await checkComposeFloor(signal);
  if (floorErr !== null) {
    const rendered = await renderCompose(deps, renderOptions);
    return {
      kind: "failed",
      composeOutPath: rendered.outPath,
      installId: rendered.installId,
      message: floorErr,
      pgPort,
      embedPort: rendered.embedPort,
      pgPasswordPath: rendered.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }

  // Daemon preflight + auto-start. The user can have closed Docker
  // Desktop between System Check and ComposeBootstrap, so we re-probe
  // and (if needed) kick `performStart()` via the daemon helper.
  const daemon = await ensureDockerDaemonReady({
    signal,
    onStatus: (status) => onLogLine?.("stdout", status),
  });
  if (daemon.kind !== "ready" && daemon.kind !== "auto_started") {
    // Render so the renderer can display where the file would have landed,
    // even though we never made it to compose.
    const rendered = await renderCompose(deps, renderOptions);
    return {
      kind: "failed",
      composeOutPath: rendered.outPath,
      installId: rendered.installId,
      message: `Docker daemon is not ready: ${daemon.message}`,
      pgPort,
      embedPort: rendered.embedPort,
      pgPasswordPath: rendered.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }

  const rendered = await renderCompose(deps, renderOptions);
  const composeDir = path.dirname(rendered.outPath);

  // Pre-flight: are BOTH host ports free? Codex turn 1 RED #5 — we
  // never trusted the embed port preflight before, so a collision with
  // another LLM tool on 27134 would surface as the embeddings runtime
  // failing health rather than a clean port_collision message.
  const [pgFree, embedFree] = await Promise.all([
    isPortFree("127.0.0.1", pgPort, signal),
    isPortFree("127.0.0.1", rendered.embedPort, signal),
  ]);
  if (!pgFree || !embedFree) {
    const ourStack = await isOurProjectActive(rendered.installId, signal);
    if (ourStack) {
      // Re-run `compose up -d` against the existing project. Idempotent
      // when every service is already running; restarts any container
      // that previously exited (e.g. an `embeddings-model-init` that
      // hit a transient HF download error on the first try). Without
      // this kick, a partial stack from a prior failed up would trap
      // the user in an "unhealthy" loop with no path to recovery.
      onLogLine?.(
        "stdout",
        `Detected existing vex-${rendered.installId} stack — re-running compose up to converge service state…`
      );
      const reuseUp = await composeUpDetached({
        composeDir,
        ...(signal !== undefined ? { signal } : {}),
        ...(onLogLine !== undefined ? { onLogLine } : {}),
      });
      // Failure here is non-fatal for the reuse path: we still try to
      // poll health and let the user see service-by-service what's
      // wrong. A hard `compose up` failure (e.g. init script still
      // failing post-fix) surfaces via the embeddings probe message.
      if (reuseUp.code !== 0 && !reuseUp.timedOut) {
        if (STALE_BIND_MOUNT_RE.test(reuseUp.stderr)) {
          // Same stale Docker Desktop bind-mount cache symptom as the
          // primary up path below — the signature match MUST be applied
          // here too, BEFORE falling through to health probes, or the
          // non-destructive recreate helper is unreachable on this branch
          // (issue #26). One recreate attempt; if it still fails we fall
          // through exactly like the generic failure below and let the
          // health probes report the specific service that's unhealthy.
          onLogLine?.(
            "stdout",
            "[reuse] Detected stale Docker Desktop bind-mount cache; attempting non-destructive recreate…"
          );
          const recreate = await recreateProjectNonDestructively({
            composeDir,
            installId: rendered.installId,
            ...(signal !== undefined ? { signal } : {}),
            ...(onLogLine !== undefined ? { onLogLine } : {}),
          });
          if (recreate.upResult.code !== 0 && !recreate.upResult.timedOut) {
            onLogLine?.(
              "stderr",
              `[reuse] recreate retry exited ${recreate.upResult.code ?? "?"}; falling through to health probes`
            );
          }
        } else {
          onLogLine?.(
            "stderr",
            `[reuse] compose up exited ${reuseUp.code ?? "?"}; falling through to health probes`
          );
        }
      }

      const dbHealth = await waitForHealth({
        pgPort,
        pgPasswordPath: rendered.pgPasswordComposePath,
        installId: rendered.installId,
        ...(signal !== undefined ? { signal } : {}),
        ...(onLogLine !== undefined ? { onLogLine } : {}),
      });
      if (dbHealth.verdict === "foreign_listener") {
        // Terminal. Never probe further and never let this stack be
        // reported reusable: the app would migrate and write into
        // another install's database.
        return {
          kind: "foreign_listener",
          composeOutPath: rendered.outPath,
          installId: rendered.installId,
          message: dbHealth.message,
          pgPort,
          embedPort: rendered.embedPort,
          pgPasswordPath: rendered.pgPasswordComposePath,
          embeddingsReadiness: null,
          previousInstallHoldingPorts: false,
          conflictPorts: [],
        };
      }
      const dbHealthy = dbHealth.verdict === "usable";
      const embedReady = dbHealthy
        ? await waitForEmbeddingsRuntimeReady({
            embedPort: rendered.embedPort,
            ...(signal !== undefined ? { signal } : {}),
            ...(onLogLine !== undefined ? { onLogLine } : {}),
          })
        : null;
      const reusable = dbHealthy && embedReady?.kind === "ready";
      return {
        kind: reusable ? "reused" : "unhealthy",
        composeOutPath: rendered.outPath,
        installId: rendered.installId,
        message: reusable
          ? `Reusing existing vex-${rendered.installId} compose project (pg :${pgPort}, embeddings :${rendered.embedPort}).`
          : `Existing vex stack found but a service is not yet healthy. ${
              embedReady?.message ?? dbHealth.message
            }`,
        pgPort,
        embedPort: rendered.embedPort,
        pgPasswordPath: rendered.pgPasswordComposePath,
        embeddingsReadiness: embedReady?.kind ?? null,
        previousInstallHoldingPorts: false,
        conflictPorts: [],
      };
    }
    const conflicts: string[] = [];
    const occupiedPorts: number[] = [];
    if (!pgFree) {
      conflicts.push(`Postgres port ${pgPort}`);
      occupiedPorts.push(pgPort);
    }
    if (!embedFree) {
      conflicts.push(`embeddings port ${rendered.embedPort}`);
      occupiedPorts.push(rendered.embedPort);
    }
    // Codex review round 2 YELLOW #5 + round 3 YELLOW — keep the
    // message honest (Settings → Advanced does not expose embedPort)
    // AND specific about which port(s) are actually conflicting.
    const lsofExample = occupiedPorts.map((p) => `-i :${p}`).join(" ");
    const previousInstall =
      await findPreviousInstallContainersHoldingPorts({
        currentInstallId: rendered.installId,
        conflictPorts: occupiedPorts,
        ...(signal !== undefined ? { signal } : {}),
      });
    const previousInstallHoldingPorts =
      previousInstall.ok && previousInstall.containerIds.length > 0;
    return {
      kind: "port_collision",
      composeOutPath: rendered.outPath,
      installId: rendered.installId,
      message: previousInstallHoldingPorts
        ? "Containers from a previous Vex installation are holding the required ports. Stop those previous Vex services and retry."
        : `${conflicts.join(
            " and ",
          )} occupied by a different process. Stop the conflicting service (e.g. \`docker ps\`, \`lsof ${lsofExample}\`) and retry.`,
      pgPort,
      embedPort: rendered.embedPort,
      pgPasswordPath: rendered.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts,
      conflictPorts: occupiedPorts,
    };
  }

  // Pull every image up-front. Implicit pull inside `up -d` blocks
  // without progress; `compose pull` lets us bound the call and stream
  // pull progress to the renderer log buffer. Pulls all services so
  // the embeddings stack's two images (llama.cpp:server + curlimages)
  // surface progress here too.
  onLogLine?.(
    "stdout",
    "Pulling images (first run can take several minutes)…"
  );
  const pullResult = await composePull({
    composeDir,
    ...(signal !== undefined ? { signal } : {}),
    ...(onLogLine !== undefined ? { onLogLine } : {}),
  });
  if (pullResult.timedOut) {
    return {
      kind: "failed",
      composeOutPath: rendered.outPath,
      installId: rendered.installId,
      message: `Image pull timed out after ${
        PULL_TIMEOUT_MS / 60_000
      } min. Check your network or retry.`,
      pgPort,
      embedPort: rendered.embedPort,
      pgPasswordPath: rendered.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }
  if (pullResult.code !== 0) {
    return {
      kind: "failed",
      composeOutPath: rendered.outPath,
      installId: rendered.installId,
      message: `\`docker compose pull\` exited with ${
        pullResult.code ?? "unknown"
      }: ${pullResult.stderr.split("\n").slice(-3).join(" ")}`,
      pgPort,
      embedPort: rendered.embedPort,
      pgPasswordPath: rendered.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }

  onLogLine?.(
    "stdout",
    "Starting Vex stack (first run downloads the embeddings model, ~333 MB)…"
  );
  let upResult = await composeUpDetached({
    composeDir,
    ...(signal !== undefined ? { signal } : {}),
    ...(onLogLine !== undefined ? { onLogLine } : {}),
  });

  // Detect Docker Desktop's stale bind-mount cache failure. After a
  // Docker Desktop restart the cache directory under
  // `/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/<distro>/<hash>`
  // is wiped; the daemon still references the old hash, mount fails with
  // "no such file or directory". Recovery: tear the project down,
  // regenerate the password file (new content → new bind-mount hash),
  // re-render the compose, and retry up-d ONCE.
  let renderedAfterRecovery = rendered;
  let composeDirAfterRecovery = composeDir;
  if (
    upResult.code !== 0 &&
    !upResult.timedOut &&
    STALE_BIND_MOUNT_RE.test(upResult.stderr)
  ) {
    onLogLine?.(
      "stdout",
      "[recovery] Detected stale Docker Desktop bind-mount cache; refreshing secret + retrying…"
    );
    const cleared = await clearStaleSecretCache(
      deps,
      rendered.outPath,
      rendered.installId,
      onLogLine,
      signal
    );
    if (!cleared.wiped) {
      // Setup gate refused the destructive wipe (codex round 3 RED #2) —
      // try the NON-destructive recreate first (issue #26): project-scoped
      // `compose down --remove-orphans` (no `--volumes`, secret file
      // untouched) + ONE `up -d` retry. Recreating the containers rebuilds
      // Docker Desktop's bind-mount cache for the unchanged secret, which
      // clears the stale-hash symptom without touching user data.
      onLogLine?.(
        "stdout",
        "[recovery] Destructive wipe refused (setup complete); attempting non-destructive recreate…"
      );
      const recreate = await recreateProjectNonDestructively({
        composeDir,
        installId: rendered.installId,
        ...(signal !== undefined ? { signal } : {}),
        ...(onLogLine !== undefined ? { onLogLine } : {}),
      });
      if (recreate.upResult.code === 0 && !recreate.upResult.timedOut) {
        // Recovered — continue below with the SAME rendered/composeDir
        // (the secret never changed, so no re-render is needed) and let
        // the existing timedOut/code checks + health probes take over.
        upResult = recreate.upResult;
      } else {
        // Non-destructive recreate ALSO failed — surface failure without
        // destructive instructions and without the "contact support to
        // recover your keys" phrasing (issue #26 secondary UX note: that
        // reads like a phishing script). A safe automatic recovery was
        // already attempted; support-guided recovery is the last resort.
        return {
          kind: "failed",
          composeOutPath: rendered.outPath,
          installId: rendered.installId,
          message:
            "Docker Desktop has a stale bind-mount cache pointing at this install's Postgres password secret. Vex automatically attempted a safe recovery (recreating the containers without touching your data or password), but it did not resolve the issue. Try fully quitting Docker Desktop and restarting it, then retry. If the issue persists, contact support — support will never ask you for your seed phrase or private key.",
          pgPort,
          embedPort: rendered.embedPort,
          pgPasswordPath: rendered.pgPasswordComposePath,
          embeddingsReadiness: null,
          previousInstallHoldingPorts: false,
          conflictPorts: [],
        };
      }
    } else {
      renderedAfterRecovery = await renderCompose(deps, renderOptions);
      composeDirAfterRecovery = path.dirname(renderedAfterRecovery.outPath);
      upResult = await composeUpDetached({
        composeDir: composeDirAfterRecovery,
        ...(signal !== undefined ? { signal } : {}),
        ...(onLogLine !== undefined ? { onLogLine } : {}),
      });
    }
  }

  if (upResult.timedOut) {
    return {
      kind: "failed",
      composeOutPath: renderedAfterRecovery.outPath,
      installId: renderedAfterRecovery.installId,
      message: `\`docker compose up -d\` timed out after ${
        UP_TIMEOUT_MS / 60_000
      } min.`,
      pgPort,
      embedPort: renderedAfterRecovery.embedPort,
      pgPasswordPath: renderedAfterRecovery.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }
  if (upResult.code !== 0) {
    return {
      kind: "failed",
      composeOutPath: renderedAfterRecovery.outPath,
      installId: renderedAfterRecovery.installId,
      message: `\`docker compose up -d\` exited with ${
        upResult.code ?? "unknown"
      }: ${upResult.stderr.split("\n").slice(-3).join(" ")}`,
      pgPort,
      embedPort: renderedAfterRecovery.embedPort,
      pgPasswordPath: renderedAfterRecovery.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }

  onLogLine?.("stdout", "Waiting for Postgres to accept connections…");
  const dbHealth = await waitForHealth({
    pgPort,
    pgPasswordPath: renderedAfterRecovery.pgPasswordComposePath,
    installId: renderedAfterRecovery.installId,
    ...(signal !== undefined ? { signal } : {}),
    ...(onLogLine !== undefined ? { onLogLine } : {}),
  });
  if (dbHealth.verdict === "foreign_listener") {
    // Terminal, and never `running`: the stack we started is not what
    // answers on the port the app would connect to.
    return {
      kind: "foreign_listener",
      composeOutPath: renderedAfterRecovery.outPath,
      installId: renderedAfterRecovery.installId,
      message: dbHealth.message,
      pgPort,
      embedPort: renderedAfterRecovery.embedPort,
      pgPasswordPath: renderedAfterRecovery.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }
  if (dbHealth.verdict !== "usable") {
    return {
      kind: "unhealthy",
      composeOutPath: renderedAfterRecovery.outPath,
      installId: renderedAfterRecovery.installId,
      message: dbHealth.message,
      pgPort,
      embedPort: renderedAfterRecovery.embedPort,
      pgPasswordPath: renderedAfterRecovery.pgPasswordComposePath,
      embeddingsReadiness: null,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }

  onLogLine?.(
    "stdout",
    "Postgres ready. Probing embeddings runtime (cold start includes model load)…"
  );
  const embedReady = await waitForEmbeddingsRuntimeReady({
    embedPort: renderedAfterRecovery.embedPort,
    ...(signal !== undefined ? { signal } : {}),
    ...(onLogLine !== undefined ? { onLogLine } : {}),
  });
  if (embedReady.kind !== "ready") {
    return {
      kind: "unhealthy",
      composeOutPath: renderedAfterRecovery.outPath,
      installId: renderedAfterRecovery.installId,
      message: embedReady.message,
      pgPort,
      embedPort: renderedAfterRecovery.embedPort,
      pgPasswordPath: renderedAfterRecovery.pgPasswordComposePath,
      embeddingsReadiness: embedReady.kind,
      previousInstallHoldingPorts: false,
      conflictPorts: [],
    };
  }

  return {
    kind: "running",
    composeOutPath: renderedAfterRecovery.outPath,
    installId: renderedAfterRecovery.installId,
    message: `Vex stack vex-${renderedAfterRecovery.installId} is running (pg :${pgPort}, embeddings :${renderedAfterRecovery.embedPort}, dim=${embedReady.observedDim}).`,
    pgPort,
    embedPort: renderedAfterRecovery.embedPort,
    pgPasswordPath: renderedAfterRecovery.pgPasswordComposePath,
    embeddingsReadiness: "ready",
    previousInstallHoldingPorts: false,
    conflictPorts: [],
  };
}

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
