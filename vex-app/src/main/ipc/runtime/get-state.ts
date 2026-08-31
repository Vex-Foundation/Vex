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
  MONEY_STATE_UNREADABLE,
  type RuntimeRecoveryReadiness,
  type RuntimeStateDto,
} from "@shared/schemas/runtime.js";
import {
  isStoppable,
  readSessionActivity,
  readSessionControlFacts,
  type RuntimeControlFacts,
} from "../../database/session-control-state.js";
import { ensureEngineDbUrl } from "./_ensure-engine-db-url.js";
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
      const recoveryReady = await readRecoveryReadiness(facts, ctx.requestId);
      const dto = projectRuntimeStateDto(facts, pausedWake, recoveryReady);
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
          `activity=${dto.activity.kind} ` +
          `recoveryReady=${recoveryReady?.kind ?? "n/a"} ` +
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
  recoveryReady: RuntimeRecoveryReadiness | null,
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
    activity: readSessionActivity(facts),
    ...(facts.lastError === undefined ? {} : { lastError: facts.lastError }),
    ...(pausedWake === null ? {} : { pausedWake }),
    ...(recoveryReady === null ? {} : { recoveryReady }),
  };
}

/**
 * The Recover affordance's money-state mirror, or `null` for every status
 * where Recover is not offered.
 *
 * READS THE SAME OWNER as the enforcement. `getUnresolvedMoneyStateForSession`
 * is the single source of that answer; re-implementing its eleven predicates
 * here would create a second, quietly diverging one, and the surface that
 * diverged would be the one telling the operator it is safe to press.
 *
 * WITHOUT the session control lock, and that is deliberate. The lock is what
 * makes the retry dispatcher's read a decision boundary; taking it on a
 * read-only IPC that fires on every control-state push would put a poll in
 * front of the operator's Stop, which is precisely the inversion the lock's own
 * module forbids. So this answer is a possibly-stale MIRROR, which is all a
 * button state may ever be: `runtime-retry-dispatch.ts` re-reads under the lock
 * and refuses on its own answer.
 *
 * FAIL-CLOSED: any failure - unset DB url, connect error, malformed row -
 * projects `blocked`, because an unreadable money state is not a clear one.
 */
async function readRecoveryReadiness(
  facts: RuntimeControlFacts,
  correlationId: string,
): Promise<RuntimeRecoveryReadiness | null> {
  if (facts.status !== "paused_error") return null;
  try {
    const dbUrl = await ensureEngineDbUrl(correlationId);
    if (!dbUrl.ok) return { kind: "blocked", reasonKinds: [MONEY_STATE_UNREADABLE] };
    const { withTransaction } = await import("@vex-agent/db/client.js");
    const { getUnresolvedMoneyStateForSession } = await import(
      "@vex-agent/db/repos/approval-intents/money-state.js"
    );
    const money = await withTransaction(async (client) =>
      getUnresolvedMoneyStateForSession(client, facts.sessionId),
    );
    if (money.clear) return { kind: "ready" };
    return {
      kind: "blocked",
      reasonKinds: [...new Set(money.reasons.map((reason) => reason.kind))],
    };
  } catch (cause) {
    log.warn("[ipc:vex:runtime:getState] money-state mirror read failed", cause);
    return { kind: "blocked", reasonKinds: [MONEY_STATE_UNREADABLE] };
  }
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
