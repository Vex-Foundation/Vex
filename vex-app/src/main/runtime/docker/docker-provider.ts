/**
 * The Docker Compose provider: today's compose lifecycle behind the
 * `LocalRuntimeProvider` seam. No compose logic lives here - it calls
 * `compose/lifecycle.ts` exactly as the IPC handler did - only the session
 * state that used to sit in the handler's closure:
 *
 *   - the last started project (out path + install id), which `stop()` and
 *     the previous-install stop need;
 *   - the port conflict a previous install caused, which authorizes
 *     `stopPreviousInstallStacks()` to stop exactly those stacks.
 */

import { buildEmbeddingBaseUrl } from "@shared/embedding-defaults.js";
import {
  composeDown,
  composeUp,
  type ComposeDownResult,
  type ComposeUpResult,
} from "../../compose/lifecycle.js";
import { buildRenderDeps } from "../../compose/deps-factory.js";
import { stopStacksHoldingPorts } from "../../compose/orphan-stacks.js";
import { LOOPBACK_DB_HOST } from "../../database/connection-state.js";
import { AbortError } from "../../ipc/cancel-helpers.js";
import { isUsableStart, type LocalRuntimeProvider } from "../provider.js";

export interface DockerStartInput {
  /** Overrides the published Postgres port (dev and tests only). */
  readonly pgPort?: number;
}

export type StopPreviousInstallStacksOutcome =
  | { readonly kind: "none_eligible" }
  | { readonly kind: "stopped"; readonly stoppedCount: number; readonly message: string }
  | { readonly kind: "failed" };

export interface DockerProvider
  extends LocalRuntimeProvider<DockerStartInput, ComposeUpResult, ComposeDownResult> {
  readonly id: "docker";
  /** Stop the previous install's stacks that blocked the last start's ports. */
  stopPreviousInstallStacks(signal: AbortSignal): Promise<StopPreviousInstallStacksOutcome>;
}

export function createDockerProvider(): DockerProvider {
  let lastComposeOutPath: string | null = null;
  let lastInstallId: string | null = null;
  let lastPreviousInstallConflict: {
    readonly currentInstallId: string;
    readonly conflictPorts: ReadonlyArray<number>;
  } | null = null;

  return {
    id: "docker",

    async start(input, options) {
      const result = await composeUp(buildRenderDeps(), {
        ...(input.pgPort !== undefined ? { pgPort: input.pgPort } : {}),
        signal: options.signal,
        ...(options.onLogLine !== undefined ? { onLogLine: options.onLogLine } : {}),
      });
      // composeUp settles an aborted spawn as an ordinary `failed` outcome.
      // Promote it to the provider contract's AbortError, so the initiator
      // and every joined caller see a cancellation, not a failure.
      if (options.signal.aborted) throw new AbortError("composeUp cancelled by user");

      lastComposeOutPath = result.composeOutPath;
      lastInstallId = result.installId;
      lastPreviousInstallConflict =
        result.kind === "port_collision" && result.previousInstallHoldingPorts
          ? { currentInstallId: result.installId, conflictPorts: result.conflictPorts }
          : null;

      // Failure paths still carry pgPort/pgPasswordPath, but only a usable
      // stack yields endpoints (provider contract).
      const endpoints = isUsableStart(result.kind)
        ? {
            db: {
              // The compose template publishes Postgres on 127.0.0.1 only.
              host: LOOPBACK_DB_HOST,
              pgPort: result.pgPort,
              pgPasswordPath: result.pgPasswordPath,
            },
            embeddings: { baseUrl: buildEmbeddingBaseUrl(result.embedPort), apiKey: null },
          }
        : null;
      return { kind: result.kind, endpoints, detail: result };
    },

    async stop() {
      if (lastComposeOutPath === null || lastInstallId === null) {
        return {
          kind: "not_running",
          detail: {
            kind: "not_running",
            message: "No compose project has been started in this session.",
          },
        };
      }
      const result = await composeDown(lastComposeOutPath, lastInstallId);
      return { kind: result.kind, detail: result };
    },

    async stopPreviousInstallStacks(signal) {
      const conflict = lastPreviousInstallConflict;
      if (conflict === null) return { kind: "none_eligible" };
      const result = await stopStacksHoldingPorts({
        currentInstallId: conflict.currentInstallId,
        conflictPorts: conflict.conflictPorts,
        signal,
      });
      if (!result.ok) return { kind: "failed" };
      lastPreviousInstallConflict = null;
      return { kind: "stopped", stoppedCount: result.stoppedCount, message: result.message };
    },
  };
}
