/**
 * vex.docker.* — Docker subsystem detection (M2 surface).
 *
 * `detect()` runs the async probe runner in `../docker/probe.ts`. M4 will
 * expand this domain with `install`, `start`, `composeUp`, `composeDown`
 * + domain-namespaced event subscriptions; for M2 we only ship detection.
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
import {
  composeDown,
  composeUp,
  type ComposeUpResult as InternalComposeUpResult,
} from "../compose/lifecycle.js";
import { buildRenderDeps } from "../compose/deps-factory.js";
import { log } from "../logger/index.js";
import { CONFIG_DIR } from "../paths/config-dir.js";
import { resolvePgPort } from "../paths/service-ports.js";
import { setDbConnection } from "../database/connection-state.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { CRITICAL_OP, trackCriticalOp } from "../updates/critical-ops.js";
import { stopStacksHoldingPorts } from "../compose/orphan-stacks.js";
import { registerHandler } from "./register-handler.js";
import {
  cancelledError,
  isAbortError,
  raceWithAbort,
} from "./cancel-helpers.js";

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

export function registerDockerHandlers(): Array<() => void> {
  const teardowns: Array<() => void> = [];

  teardowns.push(
    registerHandler({
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
    registerHandler({
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
    registerHandler({
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

  let lastComposeOutPath: string | null = null;
  let lastInstallId: string | null = null;
  let lastPreviousInstallConflict: {
    readonly currentInstallId: string;
    readonly conflictPorts: ReadonlyArray<number>;
  } | null = null;

  // Single-flight deduplication for composeUp. React StrictMode dev
  // double-mount + HMR can fire `vex.docker.composeUp` twice in quick
  // succession; without dedup the second invocation runs concurrently
  // and stays `isPending` long after the first emitted "ready",
  // freezing the renderer mutation hook (codex turn 8 diagnosis).
  let composeUpInFlight: Promise<InternalComposeUpResult> | null = null;
  let composeUpInFlightKey: string | null = null;

  // Idempotent finalize: persist main-only side-effects (last paths, DB
  // connection) and strip pgPort/pgPasswordPath so the payload survives
  // composeUpResultSchema's `.strict()` validation. Called from BOTH
  // the fresh path AND the joined single-flight path — the latter
  // previously returned the un-stripped internal result, regressing
  // the StrictMode dedup fix to `internal.contract_violation`
  // (codex turn 2 must-fix #1).
  function finalizeAndShape(
    internal: InternalComposeUpResult
  ): ComposeUpResult {
    lastComposeOutPath = internal.composeOutPath;
    lastInstallId = internal.installId;
    lastPreviousInstallConflict =
      internal.kind === "port_collision" &&
      internal.previousInstallHoldingPorts
        ? {
            currentInstallId: internal.installId,
            conflictPorts: internal.conflictPorts,
          }
        : null;
    // Persist DB connection only when the stack is actually usable.
    // Failure paths still carry pgPort/pgPasswordPath but consumers
    // (the migration runner) must NOT see a connection that points
    // at a degraded stack.
    if (internal.kind === "running" || internal.kind === "reused") {
      setDbConnection({
        pgPort: internal.pgPort,
        pgPasswordPath: internal.pgPasswordPath,
      });
    }
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
    registerHandler({
      channel: CH.docker.composeUp,
      domain: "docker",
      inputSchema: composeUpInputSchema,
      outputSchema: composeUpResultSchema,
      handle: trackCriticalOp(
        CRITICAL_OP.dockerLifecycle,
        async (input, ctx): Promise<Result<ComposeUpResult>> => {
        const key = `pgPort=${input.pgPort ?? "default"}`;
        if (composeUpInFlight !== null && composeUpInFlightKey === key) {
          log.info(
            `[ipc:vex:docker:composeUp] joining in-flight invocation (key=${key})`
          );
          // Joined-caller detach semantics: race the shared promise
          // against THIS caller's abort signal. If MY signal aborts I
          // return cancelled WITHOUT touching `composeUpInFlight`;
          // the shared work continues for the initiator (and any
          // joiners that did NOT cancel). Codex turn 11 + turn 13
          // locked this contract — a joiner must not be able to
          // abort the shared `runSpawn`.
          try {
            const reused = await raceWithAbort(composeUpInFlight, ctx.signal);
            return ok(finalizeAndShape(reused));
          } catch (cause) {
            if (isAbortError(cause)) {
              return err(cancelledError("docker", ctx.requestId));
            }
            throw cause;
          }
        }

        log.info(
          `[ipc:vex:docker:composeUp] starting (key=${key})`
        );
        const startedAt = Date.now();
        const deps = buildRenderDeps();
        // Initiator plumbs ITS OWN signal into composeUp → runSpawn.
        // Codex turn 14 RED #1: runSpawn resolves with `{aborted:
        // true}` on signal abort rather than throwing, and
        // lifecycle.composeUp converts that into a normal
        // `ok({kind: "failed"})` outcome. To get a clean cancellation
        // contract for BOTH the initiator and any joined callers, the
        // shared promise must reject with AbortError when the
        // initiator's signal aborted. We wrap the composeUp call in
        // an async IIFE that re-promotes the silent abort: this means
        //   - initiator's catch below catches AbortError → cancelled
        //   - joiners' raceWithAbort sees the shared rejection →
        //     they catch AbortError → cancelled
        const run: Promise<InternalComposeUpResult> = (async () => {
          const innerResult = await composeUp(deps, {
            ...(input.pgPort !== undefined ? { pgPort: input.pgPort } : {}),
            signal: ctx.signal,
            onLogLine: (stream, line) =>
              composeLogBus.emit({ stream, line, ts: Date.now() }),
          });
          if (ctx.signal.aborted) {
            const abortErr = new Error("composeUp cancelled by user");
            abortErr.name = "AbortError";
            throw abortErr;
          }
          return innerResult;
        })();
        composeUpInFlight = run;
        composeUpInFlightKey = key;
        try {
          const result = await run;
          log.info(
            `[ipc:vex:docker:composeUp] completed kind=${result.kind} elapsed=${Date.now() - startedAt}ms`
          );
          // The "completed" log emit lives ONLY on the fresh path so
          // joined callers don't double-log the same outcome.
          composeLogBus.emit({
            stream:
              result.kind === "running" || result.kind === "reused"
                ? "stdout"
                : "stderr",
            line: `Compose bootstrap completed: ${result.kind}.`,
            ts: Date.now(),
          });
          return ok(finalizeAndShape(result));
        } catch (cause) {
          if (isAbortError(cause)) {
            return err(cancelledError("docker", ctx.requestId));
          }
          throw cause;
        } finally {
          if (composeUpInFlight === run) {
            composeUpInFlight = null;
            composeUpInFlightKey = null;
          }
        }
      },
      ),
    })
  );

  teardowns.push(
    registerHandler({
      channel: CH.docker.stopPreviousInstallStacks,
      domain: "docker",
      inputSchema: empty,
      outputSchema: stopPreviousInstallStacksResultSchema,
      handle: trackCriticalOp(
        CRITICAL_OP.dockerLifecycle,
        async (_input, ctx): Promise<
          Result<StopPreviousInstallStacksResult>
        > => {
          const conflict = lastPreviousInstallConflict;
          if (conflict === null) {
            return ok({
              stoppedCount: 0,
              message: "No previous Vex services are eligible to stop.",
            });
          }
          const result = await stopStacksHoldingPorts({
            currentInstallId: conflict.currentInstallId,
            conflictPorts: conflict.conflictPorts,
            signal: ctx.signal,
          });
          if (!result.ok) {
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
          lastPreviousInstallConflict = null;
          return ok({
            stoppedCount: result.stoppedCount,
            message: result.message,
          });
        },
      ),
    }),
  );

  teardowns.push(
    registerHandler({
      channel: CH.docker.composeDown,
      domain: "docker",
      inputSchema: empty,
      outputSchema: composeDownResultSchema,
      handle: trackCriticalOp(
        CRITICAL_OP.dockerLifecycle,
        async (): Promise<Result<ComposeDownResult>> => {
        if (!lastComposeOutPath || !lastInstallId) {
          return ok({
            kind: "not_running",
            message: "No compose project has been started in this session.",
          });
        }
        const result = await composeDown(lastComposeOutPath, lastInstallId);
        // Clear the DB connection handoff only on a confirmed stop —
        // a failed down may have left the stack running with the same
        // credentials, so we keep the state so the migration runner
        // can still talk to it (codex turn 2 should-fix on lifecycle
        // hygiene). `not_running` is short-circuited above.
        if (result.kind === "stopped") {
          setDbConnection(null);
        }
        return ok(result);
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
