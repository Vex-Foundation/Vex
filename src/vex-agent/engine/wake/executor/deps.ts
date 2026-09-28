import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import type { RunnerLeaseGuard } from "../../runtime/lease-guard.js";
import type {
  ClaimSessionWakeInput,
  ClaimSessionWakeOutcome,
} from "./claim-session-wake.js";
import type {
  ClaimMissionWakeInput,
  ClaimMissionWakeOutcome,
} from "./claim-mission-wake.js";

/**
 * Dependencies hoisted out of concrete imports so tests can inject fakes
 * without loading the real DB / engine stack. The production factory
 * (`buildProductionDeps`) builds a `WakeDeps` from the repos + engine
 * entrypoints.
 */
export interface WakeDeps {
  /**
   * List up to `limit` due MISSION-SCOPED candidates WITHOUT consuming them.
   * Non-destructive by contract: each row is only claimed by
   * `claimMissionWake`, one at a time, so a crash between two claims leaves
   * every later row pending.
   */
  listDueMissionWakes(now: Date, limit: number): Promise<LoopWakeRequest[]>;
  /**
   * Revalidate + lease-claim + run flip + consume ONE mission-scoped wake as a
   * single transaction under the session control lock. A busy lease or a run
   * still unwinding toward its park leaves the row pending with a bounded
   * backoff.
   */
  claimMissionWake(
    input: ClaimMissionWakeInput,
  ): Promise<ClaimMissionWakeOutcome>;
  /**
   * List up to `limit` due SESSION-SCOPED candidates WITHOUT consuming them.
   * Non-destructive by contract: the row is only claimed by
   * `claimSessionWake`, under the session control lock.
   */
  listDueSessionWakes(now: Date, limit: number): Promise<LoopWakeRequest[]>;
  /**
   * Revalidate + lease-claim + consume ONE session-scoped wake as a single
   * transaction under the session control lock. On a busy lease the row stays
   * pending with a bounded backoff instead of being lost.
   */
  claimSessionWake(
    input: ClaimSessionWakeInput,
  ): Promise<ClaimSessionWakeOutcome>;
  /**
   * Persist a `wake_due` banner for the resume path to pick up.
   *
   * `triggeredBy` is the wake row's raw `payload.triggeredBy` - the cause the
   * promotion stamped, or `undefined` for an ordinary timer wake. It is passed
   * through UNPARSED because the banner builder owns the validation: every wake
   * path forwards the same untrusted value, and none of them gets to decide
   * what a renderable cause looks like.
   */
  injectWakeBanner(
    sessionId: string,
    reason: string | null,
    dueAt: string,
    triggeredBy?: unknown,
  ): Promise<void>;
  /**
   * Resume a mission run, under the run/session lease the executor already
   * holds. `runnerLease` (the executor's `LeaseHandle`) is REQUIRED: the
   * resumed turn loop proves lease ownership with it, fences its writes on it
   * and ends on `lease_lost` through it, and an optional parameter is exactly
   * how that proof got dropped before.
   */
  resumeMissionRun(runId: string, runnerLease: RunnerLeaseGuard): Promise<void>;
  /**
   * Continue a Full-Autonomous agent session whose runtime slice was exhausted.
   * Called with the session lease ALREADY HELD by the executor, exactly like
   * `resumeMissionRun` is called under the run lease.
   */
  continueAgentSession(sessionId: string, runnerLease: RunnerLeaseGuard): Promise<void>;
  /**
   * Pre-claim provider/config gate. A claim is destructive
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
import { appendEngineMessage } from "@vex-agent/engine/events/index.js";
import { isWakeProviderConfigured } from "./provider.js";
import { claimSessionWakeAtomically } from "./claim-session-wake.js";
import { claimMissionWakeAtomically } from "./claim-mission-wake.js";
import { formatWakeBanner, parseWakeTrigger } from "./wake-banner.js";

export function buildProductionDeps(): WakeDeps {
  return {
    listDueMissionWakes: (now, limit) =>
      loopWakeRepo.listDueMissionScoped(now, limit),
    claimMissionWake: (input) => claimMissionWakeAtomically(input),
    listDueSessionWakes: (now, limit) =>
      loopWakeRepo.listDueSessionScoped(now, limit),
    claimSessionWake: (input) => claimSessionWakeAtomically(input),
    injectWakeBanner: async (sessionId, reason, dueAt, triggeredBy) => {
      const trigger = parseWakeTrigger(triggeredBy);
      await appendEngineMessage(
        sessionId,
        formatWakeBanner(reason, dueAt, triggeredBy),
        {
          source: "engine",
          messageType: "wake_due",
          visibility: "internal",
          payload: { reason: reason ?? null, dueAt, triggeredBy: trigger },
        },
      );
    },
    resumeMissionRun: async (runId, runnerLease) => {
      // Lazy dynamic import so wake/executor.ts doesn't introduce a circular
      // dependency through the engine barrel. The ESM runtime caches the
      // promise after the first resolve, so there's no per-tick cost.
      // Blob TTL refresh is done inside `resumeMissionRun` itself
      // so every caller — wake executor, ingress preempt, approval resume —
      // gets it idempotently.
      const engine = await import("@vex-agent/engine/index.js");
      await engine.resumeMissionRun(runId, runnerLease);
    },
    continueAgentSession: async (sessionId, runnerLease) => {
      // Same lazy-import rationale as `resumeMissionRun` above. Imported from
      // the runner module directly (not the engine barrel) because this entry
      // point is deliberately lease-held — the barrel's `processAgentTurn`
      // claims its own lease and would deadlock against the executor's.
      const { continueAgentSessionUnderLease } = await import(
        "../../core/runner/agent.js"
      );
      await continueAgentSessionUnderLease(sessionId, runnerLease);
    },
    isProviderReady: isWakeProviderConfigured,
  };
}
