/**
 * Khalani order status polling.
 *
 * Khalani's official Integration Guide REQUIRES tracking a submitted bridge
 * order to a TERMINAL state — a deposit tx mining does NOT mean the destination
 * leg filled. `getOrderById` returns the live `OrderStatus`; the terminal set is
 * {filled, refunded, failed}. `refund_pending` is explicitly NON-terminal with
 * no documented SLA, so it NEVER ends the poll — the caller surfaces it as an
 * in-flight (not-yet-delivered) refund when the bounded window closes.
 *
 * Cadence mirrors the official reference (5s interval, 24 polls ≈ 2 min) and the
 * Relay substrate's bounded `pollToTerminal`: we never block a turn forever.
 */

import { getKhalaniClient } from "./client.js";
import type { OrderStatus } from "./types.js";
import { VexError } from "../../errors.js";
import { delay, pollUntil } from "../../utils/cancellation.js";
import logger from "../../utils/logger.js";

export const KHALANI_TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "filled",
  "refunded",
  "failed",
]);

/**
 * The three DISTINCT outcomes of tracking an order — the caller must not conflate
 * them:
 *   - `terminal`: a terminal status (filled/refunded/failed) was OBSERVED;
 *   - `pending`: a non-terminal status was OBSERVED but the bounded window closed
 *     before it settled (the order is live, may still complete);
 *   - `unavailable`: NO poll ever succeeded (Khalani status API unreachable for
 *     the whole window) — delivery is UNKNOWN, NOT benignly pending. Masking this
 *     as a pending order would enqueue a projection for a status nobody observed.
 *   - `aborted`: the operator stopped the run while the window was open. Like
 *     `unavailable` the delivery state is UNKNOWN, but for a different reason
 *     the caller must be able to say out loud: nobody looked, rather than
 *     nobody answered. The deposit is already broadcast and the logical row is
 *     already pending for the background sweep, so abandoning the watch loses
 *     nothing that is not re-derivable.
 */
export type KhalaniOrderPoll =
  | { readonly kind: "terminal"; readonly status: OrderStatus }
  | { readonly kind: "pending"; readonly status: OrderStatus }
  | { readonly kind: "unavailable" }
  | { readonly kind: "aborted"; readonly lastObserved: OrderStatus | null };

// Official reference: poll every 5s, up to 24 times (~2 min).
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 24;

/**
 * Poll a Khalani order toward a terminal status (bounded). Returns a `terminal`
 * result once one is observed; otherwise, when the budget is exhausted, `pending`
 * with the last OBSERVED non-terminal status, or `unavailable` when NO poll ever
 * succeeded. There is NO synthetic default status — a status is only ever reported
 * because `getOrderById` actually returned it. Poll failures are swallowed
 * (logged, bounded reason class only) so one transient error does not abort the
 * whole track, but a track where EVERY poll fails resolves to `unavailable`.
 *
 * `signal` is the operator's Stop. This whole window is a READ — the deposit is
 * already broadcast and W4 owns terminalization either way — so a Stop lands
 * here immediately instead of costing the turn up to two minutes. The cadence
 * is unchanged: a leading wait, then 24 reads 5 s apart.
 */
export async function pollKhalaniOrderToTerminal(
  orderId: string,
  signal?: AbortSignal,
): Promise<KhalaniOrderPoll> {
  const client = getKhalaniClient();
  let lastObserved: OrderStatus | null = null;

  // The leading wait the official cadence starts with — a freshly submitted
  // order has nothing to report yet. Abortable like every wait below it.
  try {
    await delay(POLL_INTERVAL_MS, signal);
  } catch {
    return { kind: "aborted", lastObserved };
  }

  const outcome = await pollUntil<OrderStatus>({
    attempts: POLL_MAX_ATTEMPTS,
    intervalMs: POLL_INTERVAL_MS,
    ...(signal ? { signal } : {}),
    attempt: async () => {
      try {
        const order = await client.getOrderById(orderId);
        lastObserved = order.status;
        return KHALANI_TERMINAL_STATUSES.has(order.status) ? order.status : undefined;
      } catch (err) {
        logger.warn("khalani.bridge.status_poll_failed", {
          reason: err instanceof VexError ? err.code : "unknown",
        });
        return undefined;
      }
    },
  });

  if (outcome.kind === "settled") return { kind: "terminal", status: outcome.value };
  if (outcome.kind === "aborted") return { kind: "aborted", lastObserved };
  return lastObserved === null
    ? { kind: "unavailable" }
    : { kind: "pending", status: lastObserved };
}
