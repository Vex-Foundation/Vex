import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import type { MissionRun } from "@vex-agent/db/repos/mission-runs.js";
import type { MissionRunStatus } from "../../types.js";

/**
 * Dependencies hoisted out of concrete imports so tests can inject fakes
 * without loading the real DB / engine stack. The production factory
 * (`buildProductionDeps`) builds a `WakeDeps` from the repos + engine
 * entrypoints.
 */
export interface WakeDeps {
  /** Claim up to `limit` due rows, atomically flipping them to `consumed`. */
  claimDue(now: Date, limit: number): Promise<LoopWakeRequest[]>;
  /** Fetch a mission run by id (used to re-check status before resume). */
  getMissionRun(runId: string): Promise<MissionRun | null>;
  /** Claim a paused run before injecting a wake banner and resuming. */
  casFlipToRunning(
    runId: string,
    fromStatuses: readonly MissionRunStatus[],
  ): Promise<MissionRunStatus | null>;
  /** Persist a `wake_due` banner for the resume path to pick up. */
  injectWakeBanner(sessionId: string, reason: string | null, dueAt: string): Promise<void>;
  /** Resume a mission run. */
  resumeMissionRun(runId: string): Promise<void>;
  /**
   * Continue a Full-Autonomous agent session whose runtime slice was exhausted.
   * Called with the session lease ALREADY HELD by the executor, exactly like
   * `resumeMissionRun` is called under the run lease.
   */
  continueAgentSession(sessionId: string): Promise<void>;
  /**
   * Pre-claim provider/config gate. `claimDue` is destructive
   * (pending→consumed) and the subsequent resume runs the agent turn loop,
   * which needs the inference provider. The executor must NOT claim wake rows
   * when provider config is absent (e.g. before the vault injects the key on
   * unlock); production checks OPENROUTER_API_KEY + AGENT_MODEL in env.
   */
  isProviderReady(): boolean;
}

// ── Production dep wiring ──────────────────────────────────────────

// Production wiring lives inline (top-level imports) because this module is
// only reachable after the host has booted the DB + engine.
// Tests that just want `tick` call it directly with a handcrafted `WakeDeps`.

import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import { appendEngineMessage } from "@vex-agent/engine/events/index.js";
import { isWakeProviderConfigured } from "./provider.js";

export function buildProductionDeps(): WakeDeps {
  return {
    claimDue: (now, limit) => loopWakeRepo.claimDue(now, limit),
    getMissionRun: (runId) => missionRunsRepo.getRun(runId),
    casFlipToRunning: (runId, fromStatuses) =>
      missionRunsRepo.casFlipToRunning(runId, fromStatuses),
    injectWakeBanner: async (sessionId, reason, dueAt) => {
      await appendEngineMessage(
        sessionId,
        `[Engine: wake_due — ${reason ?? "no reason provided"} (scheduled: ${dueAt})]`,
        {
          source: "engine",
          messageType: "wake_due",
          visibility: "internal",
          payload: { reason: reason ?? null, dueAt },
        },
      );
    },
    resumeMissionRun: async (runId) => {
      // Lazy dynamic import so wake/executor.ts doesn't introduce a circular
      // dependency through the engine barrel. The ESM runtime caches the
      // promise after the first resolve, so there's no per-tick cost.
      // Blob TTL refresh is done inside `resumeMissionRun` itself
      // so every caller — wake executor, ingress preempt, approval resume —
      // gets it idempotently.
      const engine = await import("@vex-agent/engine/index.js");
      await engine.resumeMissionRun(runId);
    },
    continueAgentSession: async (sessionId) => {
      // Same lazy-import rationale as `resumeMissionRun` above. Imported from
      // the runner module directly (not the engine barrel) because this entry
      // point is deliberately lease-held — the barrel's `processAgentTurn`
      // claims its own lease and would deadlock against the executor's.
      const { continueAgentSessionUnderLease } = await import(
        "../../core/runner/agent.js"
      );
      await continueAgentSessionUnderLease(sessionId);
    },
    isProviderReady: isWakeProviderConfigured,
  };
}
