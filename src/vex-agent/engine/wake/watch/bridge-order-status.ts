/**
 * `bridge_order_status` wake watch — wake the session EARLY when the bridge it
 * is sleeping on reaches a terminal status.
 *
 * ## Why this evaluator exists
 *
 * `loop_defer`'s timer is a guess. A bridge advertised as "1-10 minutes" is
 * sometimes 40 seconds and sometimes 12 minutes, so a timer sized for the tail
 * wastes the good case and a timer sized for the good case re-sleeps through the
 * bad one. The watch removes the guess from the good case WITHOUT removing the
 * timer: the deferred wake still fires at `due_at` no matter what, and a
 * terminalizing row only ever moves that deadline EARLIER
 * (`promotePendingWake` is a `LEAST(due_at, NOW())`).
 *
 * ## Ids: the model gives an orderId, the trigger path compares a row id
 *
 * The model holds a PROVIDER order id — it is what the bridge execute tools
 * return and what `bridge_status` takes. The push source (the pending-activity
 * bus `resolved` event) carries the `agent_activity` ROW id and nothing else,
 * by the bus's ids-only doctrine.
 *
 * So the resolution happens ONCE, here, at validation time: the canonical
 * condition persisted in the wake payload carries BOTH ids. The trigger path is
 * then a pure comparison with no DB read — which matters, because it runs on
 * every terminalization for every session.
 *
 * ## Failure is never silent and never fatal
 *
 * An unknown order id, or one that already settled, is REJECTED BY NAME with
 * what to do instead. The rejection travels back as a warning on a `loop_defer`
 * that still parked on its timer — see `watch-registry.ts` for why a rejected
 * watch must never fail the defer.
 */

import { z } from "zod";

import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type {
  WakeWatchCondition,
  WakeWatchEvaluator,
  WakeWatchSignal,
} from "../watch-registry.js";

export const BRIDGE_ORDER_STATUS_WATCH_TYPE = "bridge_order_status";

/** Bounded so a model cannot push an arbitrary blob through the envelope. */
const ORDER_ID_MAX_CHARS = 200;

const BridgeOrderStatusInput = z.object({
  type: z.literal(BRIDGE_ORDER_STATUS_WATCH_TYPE),
  orderId: z
    .string({ error: "orderId is required (the provider order id the bridge tool returned)" })
    .min(1, { message: "orderId must be a non-empty string" })
    .max(ORDER_ID_MAX_CHARS, { message: `orderId must be ≤ ${ORDER_ID_MAX_CHARS} chars` }),
});

/** The canonical shape persisted in `loop_wake_requests.payload.conditions`. */
export interface BridgeOrderStatusCondition extends WakeWatchCondition {
  readonly type: typeof BRIDGE_ORDER_STATUS_WATCH_TYPE;
  readonly orderId: string;
  readonly activityId: number;
}

export interface BridgeOrderStatusDeps {
  readonly findActivityByProviderOrderId: (
    orderId: string,
  ) => Promise<{ readonly id: number; readonly status: string } | null>;
}

async function defaultFindActivity(
  orderId: string,
): Promise<{ id: number; status: string } | null> {
  const { findActivityByProviderOrderId } = await import(
    "@vex-agent/db/repos/agent-activity/watch-reads.js"
  );
  const row = await findActivityByProviderOrderId(orderId);
  return row === null ? null : { id: row.id, status: row.status };
}

export function createBridgeOrderStatusEvaluator(
  deps: BridgeOrderStatusDeps = { findActivityByProviderOrderId: defaultFindActivity },
): WakeWatchEvaluator {
  return {
    type: BRIDGE_ORDER_STATUS_WATCH_TYPE,

    async validate(
      condition: WakeWatchCondition,
      _context: InternalToolContext,
    ): Promise<WakeWatchCondition> {
      const parsed = BridgeOrderStatusInput.safeParse(condition);
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "invalid bridge_order_status condition");
      }
      const { orderId } = parsed.data;
      const row = await deps.findActivityByProviderOrderId(orderId);
      if (row === null) {
        throw new Error(
          `no recorded bridge has orderId "${orderId}". Use the orderId a bridge execute tool `
          + "returned, or find it with agent_scan(view=\"transactions\", productType=\"bridge\").",
        );
      }
      if (row.status !== "pending") {
        throw new Error(
          `bridge order "${orderId}" already reached status "${row.status}" — there is nothing `
          + "left to wait for. Read it now with bridge_status instead of deferring.",
        );
      }
      const canonical: BridgeOrderStatusCondition = {
        type: BRIDGE_ORDER_STATUS_WATCH_TYPE,
        orderId,
        activityId: row.id,
      };
      return canonical;
    },

    isTriggered(condition: WakeWatchCondition, signal: WakeWatchSignal): boolean {
      if (signal.type !== BRIDGE_ORDER_STATUS_WATCH_TYPE) return false;
      const activityId = condition.activityId;
      if (typeof activityId !== "number" || !Number.isFinite(activityId)) return false;
      return signal.values.activityId === String(activityId);
    },
  };
}
