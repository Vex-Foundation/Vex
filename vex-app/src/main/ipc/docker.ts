/**
 * The container runtime's IPC surface: detection, install, engine start and
 * the compose lifecycle (behind the runtime seam), plus the install-progress
 * and compose-log broadcasts.
 *
 * NATIVE RUNTIME GUARD. On the native runtime nothing may touch the
 * container engine, so every handler here refuses before it reaches the CLI,
 * the engine socket or the Model Runner port (`registerContainerHandler`).
 * The renderer never asks there (System Check, the setup gate and the setup
 * tour read the runtime mode first); this is the defence in depth.
 */

import { z } from "zod";
import { CH, EV } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  composeDownResultSchema,
  composeUpResultSchema,
  dockerStatusSchema,
  installMethodSchema,
  installResultSchema,
  startResultSchema,
  stopPreviousInstallStacksResultSchema,
  type ComposeDownResult,
  type ComposeUpResult,
  type DockerStatus,
  type InstallResult,
  type StartResult,
  type StopPreviousInstallStacksResult,
} from "@shared/schemas/docker.js";
import { probeDocker } from "../docker/probe.js";
import { performInstall } from "../docker/install.js";
import { performStart } from "../docker/start.js";
import { composeLogBus, dockerProgressBus } from "../docker/progress-bus.js";
import type { ComposeUpResult as InternalComposeUpResult } from "../compose/lifecycle.js";
import { log } from "../logger/index.js";
import { CONFIG_DIR } from "../paths/config-dir.js";
import { resolvePgPort } from "../paths/service-ports.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { CRITICAL_OP, trackCriticalOp } from "../updates/critical-ops.js";
import { createDockerProvider } from "../runtime/docker/docker-provider.js";
import { createRuntimeHost } from "../runtime/runtime-host.js";
import { getRuntimeMode } from "../runtime/runtime-mode.js";
import { registerHandler, type HandlerArgs } from "./register-handler.js";
import { cancelledError, isAbortError } from "./cancel-helpers.js";

const empty = z.object({}).strict();
const installInputSchema = z
  .object({ method: installMethodSchema })
  .strict();
const composeUpInputSchema = z
  .object({ pgPort: z.number().int().min(1).max(65535).optional() })
  .strict();

const DEFAULT_MODEL_RUNNER_BASE_URL = "http://127.0.0.1:12434/engines/llama.cpp/v1";

function broadcastProgress(): () => void {
  return dockerProgressBus.subscribe((payload) =>
    broadcastToAllWindows(EV.docker.installProgress, payload)
  );
}

function broadcastComposeLogs(): () => void {
  return composeLogBus.subscribe((payload) =>
    broadcastToAllWindows(EV.docker.composeLogs, payload)
  );
}

/**
 * `registerHandler`, refusing on the native runtime. The mode is read per
 * call: it is decided at boot, after the handlers are registered.
 */
function registerContainerHandler<I, O>(args: HandlerArgs<I, O>): () => void {
  return registerHandler({
    ...args,
    handle: async (input, ctx): Promise<Result<O>> => {
      if (getRuntimeMode() === "native") {
        log.warn(`[ipc:${args.channel}] refused: this process runs the native runtime`);
        return err({
          code: "services.docker_unavailable",
          domain: args.domain,
          message: "This install runs its bundled local runtime; this request does not apply to it.",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }
      return args.handle(input, ctx);
    },
  });
}

export function registerDockerHandlers(): Array<() => void> {
  const teardowns: Array<() => void> = [];

  teardowns.push(
    registerContainerHandler({
      channel: CH.docker.detect,
      domain: "docker",
      inputSchema: empty,
      outputSchema: dockerStatusSchema,
      handle: async (): Promise<Result<DockerStatus>> => {
        const status = await probeDocker({
          pgPort: resolvePgPort(),
          modelRunnerBaseUrl: DEFAULT_MODEL_RUNNER_BASE_URL,
          diskTarget: CONFIG_DIR,
        });
        return ok(status);
      },
    })
  );

  teardowns.push(
    registerContainerHandler({
      channel: CH.docker.install,
      domain: "docker",
      inputSchema: installInputSchema,
      outputSchema: installResultSchema,
      handle: trackCriticalOp(
        CRITICAL_OP.dockerLifecycle,
        async (input): Promise<Result<InstallResult>> => {
          const result = await performInstall(input.method);
          return ok(result);
        },
      ),
    })
  );

  teardowns.push(
    registerContainerHandler({
      channel: CH.docker.start,
      domain: "docker",
      inputSchema: empty,
      outputSchema: startResultSchema,
      handle: trackCriticalOp(
        CRITICAL_OP.dockerLifecycle,
        async (): Promise<Result<StartResult>> => {
          const result = await performStart();
          return ok(result);
        },
      ),
    })
  );

  // The compose lifecycle runs behind the runtime seam: the provider holds
  // the session state (last project, previous-install conflict) and the host
  // owns single flight and the database connection.
  const provider = createDockerProvider();
  const runtimeHost = createRuntimeHost(provider);

  // Strip the main-only fields so the payload survives
  // composeUpResultSchema's `.strict()` validation. Applied to EVERY
  // caller, initiator and joined alike — returning the un-stripped
  // internal result to a joiner once regressed the StrictMode dedup fix
  // to `internal.contract_violation` (codex turn 2 must-fix #1).
  function shapeForRenderer(internal: InternalComposeUpResult): ComposeUpResult {
    const {
      pgPort: _pgPort,
      pgPasswordPath: _pgPasswordPath,
      embedPort: _embedPort,
      embeddingsReadiness: _embeddingsReadiness,
      conflictPorts: _conflictPorts,
      ...publicResult
    } = internal;
    return publicResult;
  }

  teardowns.push(
    registerContainerHandler({
      channel: CH.docker.composeUp,
      domain: "docker",
      inputSchema: composeUpInputSchema,
      outputSchema: composeUpResultSchema,
      handle: trackCriticalOp(
        CRITICAL_OP.dockerLifecycle,
        async (input, ctx): Promise<Result<ComposeUpResult>> => {
          // React StrictMode dev double-mount + HMR can fire composeUp
          // twice in quick succession; the host makes the second call JOIN
          // the first (a joiner's cancel detaches only that joiner; only the
          // initiator's signal reaches the compose spawn).
          const key = `pgPort=${input.pgPort ?? "default"}`;
          const startedAt = Date.now();
          log.info(`[ipc:vex:docker:composeUp] starting or joining (key=${key})`);
          try {
            const { outcome, joined } = await runtimeHost.start(
              input.pgPort !== undefined ? { pgPort: input.pgPort } : {},
              key,
              {
                signal: ctx.signal,
                onLogLine: (stream, line) =>
                  composeLogBus.emit({ stream, line, ts: Date.now() }),
              },
            );
            if (!joined) {
              log.info(
                `[ipc:vex:docker:composeUp] completed kind=${outcome.kind} elapsed=${Date.now() - startedAt}ms`
              );
              // Initiator only, so joined callers don't double-log the outcome.
              composeLogBus.emit({
                stream:
                  outcome.kind === "running" || outcome.kind === "reused"
                    ? "stdout"
                    : "stderr",
                line: `Compose bootstrap completed: ${outcome.kind}.`,
                ts: Date.now(),
              });
            }
            return ok(shapeForRenderer(outcome.detail));
          } catch (cause) {
            if (isAbortError(cause)) {
              return err(cancelledError("docker", ctx.requestId));
            }
            throw cause;
          }
        },
      ),
    })
  );

  teardowns.push(
    registerContainerHandler({
      channel: CH.docker.stopPreviousInstallStacks,
      domain: "docker",
      inputSchema: empty,
      outputSchema: stopPreviousInstallStacksResultSchema,
      handle: trackCriticalOp(
        CRITICAL_OP.dockerLifecycle,
        async (_input, ctx): Promise<
          Result<StopPreviousInstallStacksResult>
        > => {
          const result = await provider.stopPreviousInstallStacks(ctx.signal);
          if (result.kind === "none_eligible") {
            return ok({
              stoppedCount: 0,
              message: "No previous Vex services are eligible to stop.",
            });
          }
          if (result.kind === "failed") {
            return err({
              code: "services.compose_failed",
              domain: "docker",
              message: "Previous Vex services could not be stopped completely.",
              retryable: true,
              userActionable: true,
              redacted: true,
              correlationId: ctx.requestId,
            });
          }
          return ok({
            stoppedCount: result.stoppedCount,
            message: result.message,
          });
        },
      ),
    }),
  );

  teardowns.push(
    registerContainerHandler({
      channel: CH.docker.composeDown,
      domain: "docker",
      inputSchema: empty,
      outputSchema: composeDownResultSchema,
      handle: trackCriticalOp(
        CRITICAL_OP.dockerLifecycle,
        async (): Promise<Result<ComposeDownResult>> => {
          // The host clears the database connection only on a confirmed
          // stop: a failed down may have left the stack running with the
          // same credentials (codex turn 2 should-fix on lifecycle hygiene).
          const { detail } = await runtimeHost.stop();
          return ok(detail);
        },
      ),
    })
  );

  // Subscribe the progress + compose log buses to all renderers — runs
  // for the lifetime of the main process, torn down when handlers are
  // removed.
  teardowns.push(broadcastProgress());
  teardowns.push(broadcastComposeLogs());

  return teardowns;
}
