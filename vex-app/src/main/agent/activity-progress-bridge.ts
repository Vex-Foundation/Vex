/**
 * Engine -> renderer PENDING-PROGRESS bridge (OD-7).
 *
 * Subscribes to the in-process `pendingProgressBus`
 * (`src/vex-agent/events/pending-progress-bus.ts`) and broadcasts each
 * OBSERVATION OF A STILL-PENDING ROW on `EV.portfolio.activityProgress`.
 *
 * ## Why this exists, separately from the resolution bridge
 *
 * Its sibling fires exactly once per row, at the end. That left the entire
 * middle of a pending row's life invisible: the renderer polls the portfolio
 * every 60 s, so the lane's 5 s observations landed in Postgres and sat there.
 * The owner's stuck launch looked frozen for that reason — not because nothing
 * was happening, but because nothing said so.
 *
 * A SEPARATE MODULE for a separate bus and a separate channel: this one is
 * high-frequency and non-terminal, its sibling is once-per-row and terminal, and
 * a single module subscribing to both would own two reasons to change.
 *
 * ## AN EXPLICIT PROJECTION, then validate
 *
 * The `lane` regression is the reason this is written field-by-field rather than
 * as `safeParse(event)`. On the sibling channel an internal sync-layer field was
 * added to the bus event, the `.strict()` DTO treated it as drift, and EVERY
 * push was dropped — silently, because a dropped push looks exactly like a quiet
 * system. Naming the DTO's fields here means an internal field added tomorrow
 * can neither sever this signal nor leak across the boundary. Real drift (a
 * reason too long for the DTO) is still dropped and logged, and the preload
 * subscriber re-validates independently.
 *
 * ## Bounded by construction
 *
 * At most one message per pending row per its CURRENT interval, and the claim
 * caps concurrent rows at `EVM_CLAIM_LIMIT`. Zero when nothing is pending, and
 * six times cheaper once rows leave their fast phase.
 *
 * Import discipline: the bus is imported DIRECTLY from its leaf module — no DB
 * import reaches the main-process graph at bridge-setup time.
 */

import { EV } from "@shared/ipc/channels.js";
import { activityProgressEventSchema } from "@shared/schemas/agent-scan-feed.js";
import { pendingProgressBus } from "@vex-agent/events/pending-progress-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

/**
 * Subscribe the pending-progress bus to the IPC broadcaster. Returns the
 * teardown — the caller pushes it into `globalCleanup`.
 */
export function setupActivityProgressBridge(): () => void {
  const off = pendingProgressBus.subscribe((event) => {
    // IDS AND REASONS ONLY, field by field — never `...event`.
    const parsed = activityProgressEventSchema.safeParse({
      type: event.type,
      activityId: event.activityId,
      chainFamily: event.chainFamily,
      chainId: event.chainId,
      pendingReason: event.pendingReason,
      verificationReason: event.verificationReason,
      nextCheckInMs: event.nextCheckInMs,
      occurredAt: event.occurredAt,
    });
    if (!parsed.success) {
      log.warn("[agent:activity-progress-bridge] dropped invalid payload", {
        issues: parsed.error.issues,
      });
      return;
    }
    broadcastToAllWindows(EV.portfolio.activityProgress, parsed.data);
  });

  return () => {
    off();
  };
}
