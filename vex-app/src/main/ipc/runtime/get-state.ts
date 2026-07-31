/**
 * `vex.runtime.getState` — read-only. Pulls the active mission run row
 * + lease summary + top pending control kind in one round-trip (see
 * `mission-runs-db.ts getActiveRunForSession`). Renderer uses this to
 * gate the pause/stop/resume buttons.
 *
 * A `paused_wake` run additionally carries `pausedWake` — the pending
 * `loop_wake_requests` row, shaped for the "Vex is sleeping until…" banner.
 * That read is COMPOSED here rather than folded into the run query: the wake
 * table is `wake-db.ts`'s responsibility, and only one status ever needs it,
 * so no other call pays for the extra round-trip.
 */

import { CH } from "@shared/ipc/channels.js";
import type { Result } from "@shared/ipc/result.js";
import {
  runtimeRequestInputSchema,
  runtimeStateDtoSchema,
  type RuntimePausedWake,
  type RuntimeStateDto,
} from "@shared/schemas/runtime.js";
import { getActiveRunForSession } from "../../database/mission-runs-db.js";
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
      const outcome = await getActiveRunForSession(input.sessionId);
      if (outcome.ok) {
        const pausedWake = await readPausedWake(outcome.data);
        log.info(
          `[ipc:vex:runtime:getState] ok sessionId=${input.sessionId} ` +
            `hasActiveRun=${outcome.data.hasActiveRun} ` +
            `status=${outcome.data.status ?? "none"} ` +
            `leaseActive=${outcome.data.leaseActive} ` +
            `pendingControl=${outcome.data.pendingControlKind ?? "none"} ` +
            // Metadata only — the agent-authored reason text stays out of the
            // log line; `dueAt` is what makes a mis-timed wake diagnosable.
            `pausedWakeDueAt=${pausedWake?.dueAt ?? "none"} ` +
            `correlationId=${ctx.requestId}`,
        );
        return pausedWake === null
          ? outcome
          : { ok: true, data: { ...outcome.data, pausedWake } };
      }
      log.info(
        `[ipc:vex:runtime:getState] errCode=${outcome.error.code} ` +
          `correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

/**
 * The sleeping detail for a `paused_wake` run, or `null` for every other
 * status — and for a `paused_wake` run whose pending row is already gone
 * (the executor claims `pending → consumed` while the run is still flipping,
 * so this races by design and "not sleeping" is the honest answer).
 *
 * FAIL-OPEN: any throw degrades to `null`. The banner is a decoration; the
 * control gating this DTO exists for is not, and must survive a wake-table
 * outage.
 */
async function readPausedWake(
  state: RuntimeStateDto,
): Promise<RuntimePausedWake | null> {
  if (state.status !== "paused_wake") return null;
  try {
    return await getPendingWakeForSession(state.sessionId);
  } catch (cause) {
    log.warn("[ipc:vex:runtime:getState] pending wake read failed", cause);
    return null;
  }
}
