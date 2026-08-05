/**
 * `vex.runtime.getState` — read-only. ONE round-trip through the session
 * control-state aggregate (`database/session-control-state.ts`) pulls the
 * active mission run, the lease summary, the top pending control kind, and the
 * three existence facts that decide `stoppable`.
 *
 * A `paused_wake` run additionally carries `pausedWake` — the pending
 * `loop_wake_requests` row, shaped for the "Vex is sleeping until…" banner.
 * That read stays COMPOSED here rather than folded into the aggregate: it is a
 * display detail with its own fail-open policy, gated on one status. The
 * `stoppable` term for a park comes from the aggregate's own `EXISTS`, never
 * from this read — a wake-table hiccup may cost the banner, never the Stop key.
 */

import { CH } from "@shared/ipc/channels.js";
import type { Result } from "@shared/ipc/result.js";
import {
  runtimeRequestInputSchema,
  runtimeStateDtoSchema,
  type RuntimePausedWake,
  type RuntimeStateDto,
} from "@shared/schemas/runtime.js";
import {
  isStoppable,
  readSessionControlFacts,
  type RuntimeControlFacts,
} from "../../database/session-control-state.js";
import { getPendingWakeForSession } from "../../database/wake-db.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

export function registerRuntimeGetStateHandler(): () => void {
  return registerHandler({
    channel: CH.runtime.getState,
    domain: "runtime",
    inputSchema: runtimeRequestInputSchema,
    outputSchema: runtimeStateDtoSchema,
    handle: async (input, ctx): Promise<Result<RuntimeStateDto>> => {
      const outcome = await readSessionControlFacts(
        input.sessionId,
        ctx.requestId,
      );
      if (!outcome.ok) {
        log.info(
          `[ipc:vex:runtime:getState] errCode=${outcome.error.code} ` +
            `correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      const facts = outcome.data;
      const pausedWake = await readPausedWake(facts);
      const dto = projectRuntimeStateDto(facts, pausedWake);
      log.info(
        `[ipc:vex:runtime:getState] ok sessionId=${input.sessionId} ` +
          `hasActiveRun=${facts.hasActiveRun} ` +
          `status=${facts.status ?? "none"} ` +
          `leaseActive=${facts.leaseActive} ` +
          `stoppable=${dto.stoppable} ` +
          `hasPendingWake=${facts.hasPendingWake} ` +
          `hasPendingApproval=${facts.hasPendingApproval} ` +
          `hasIncompleteLifecycle=${facts.hasIncompleteApprovalLifecycle} ` +
          `pendingControl=${facts.pendingControlKind ?? "none"} ` +
          // Metadata only — the agent-authored reason text stays out of the
          // log line; `dueAt` is what makes a mis-timed wake diagnosable.
          `pausedWakeDueAt=${pausedWake?.dueAt ?? "none"} ` +
          `correlationId=${ctx.requestId}`,
      );
      return { ok: true, data: dto };
    },
  });
}

/**
 * EXPLICIT field-by-field projection — never `{ ...facts, stoppable }`.
 *
 * This is the `lane` lesson: a `.strict()` cross-process DTO must be assembled
 * from named sources, or an internal column that appears later rides across (or
 * starts failing the strict parse) with nobody noticing. The aggregate
 * deliberately carries main-internal existence facts that must NOT cross, so a
 * spread here would leak them the day one of them changes.
 *
 * `exactOptionalPropertyTypes` is on, so the optional members are spread
 * conditionally and never assigned `undefined`.
 */
function projectRuntimeStateDto(
  facts: RuntimeControlFacts,
  pausedWake: RuntimePausedWake | null,
): RuntimeStateDto {
  return {
    sessionId: facts.sessionId,
    hasActiveRun: facts.hasActiveRun,
    missionRunId: facts.missionRunId,
    status: facts.status,
    stopReason: facts.stopReason,
    lastCheckpointAt: facts.lastCheckpointAt,
    startedAt: facts.startedAt,
    iterationCount: facts.iterationCount,
    leaseActive: facts.leaseActive,
    leaseExpiresAt: facts.leaseExpiresAt,
    pendingControlKind: facts.pendingControlKind,
    stoppable: isStoppable(facts),
    ...(facts.lastError === undefined ? {} : { lastError: facts.lastError }),
    ...(pausedWake === null ? {} : { pausedWake }),
  };
}

/**
 * The sleeping detail for a `paused_wake` run, or `null` for every other
 * status — and for a `paused_wake` run whose pending row is already gone
 * (the executor claims `pending → consumed` while the run is still flipping,
 * so this races by design and "not sleeping" is the honest answer).
 *
 * FAIL-OPEN: any throw degrades to `null`. The banner is a decoration; the
 * control gating this DTO exists for is not, and `stoppable` does not depend on
 * this read.
 */
async function readPausedWake(
  facts: RuntimeControlFacts,
): Promise<RuntimePausedWake | null> {
  if (facts.status !== "paused_wake") return null;
  try {
    return await getPendingWakeForSession(facts.sessionId);
  } catch (cause) {
    log.warn("[ipc:vex:runtime:getState] pending wake read failed", cause);
    return null;
  }
}
