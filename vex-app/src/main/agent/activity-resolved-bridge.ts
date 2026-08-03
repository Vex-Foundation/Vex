/**
 * Engine -> renderer pending-activity bridge (Wave P).
 *
 * Subscribes to the in-process `pendingActivityBus`
 * (`src/vex-agent/events/pending-activity-bus.ts`) and broadcasts each
 * TERMINALIZATION to every BrowserWindow on `EV.portfolio.activityResolved`.
 *
 * An EXPLICIT PROJECTION, then validate. The engine payload is already bounded
 * to ids, a bounded status string and a timestamp, so there is nothing to
 * sanitize — but the internal event carries sync-layer fields the IPC DTO
 * deliberately does not (today: `lane`, the fast-lane leg discriminator). The
 * DTO is `.strict()`, so a pass-through `safeParse(event)` treated every such
 * internal field as drift and DROPPED the whole push — which is exactly the
 * outage this projection prevents. Naming the DTO's fields here means an
 * internal field added tomorrow cannot sever the renderer's resolution signal,
 * and cannot leak across the boundary either. Real drift (a status the DTO
 * cannot carry, a missing terminal status) is still dropped and logged, and the
 * preload subscriber re-validates a third time.
 *
 * ONLY `resolved` CROSSES. The `armed` half of the bus is a sync-layer concern
 * (it starts a fast lane); the renderer has nothing to do with it, and
 * forwarding it would push an event per broadcast for no UI effect.
 *
 * The producer emits only AFTER the terminalizing CAS has COMMITTED, so a
 * renderer that re-reads `portfolio.listAgentScan` on this signal is guaranteed
 * to observe the terminal row rather than the pending one it replaced.
 *
 * Import discipline: the bus is imported DIRECTLY from `pending-activity-bus.js`
 * — a leaf module with no DB import — not through any barrel that would pull the
 * DB client into the main-process graph at bridge-setup time.
 */

import { EV } from "@shared/ipc/channels.js";
import { activityResolvedEventSchema } from "@shared/schemas/agent-scan-feed.js";
import { pendingActivityBus } from "@vex-agent/events/pending-activity-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

/**
 * Subscribe the pending-activity bus to the IPC broadcaster. Returns the
 * teardown — the caller pushes it into `globalCleanup`.
 */
export function setupActivityResolvedBridge(): () => void {
  const off = pendingActivityBus.subscribe((event) => {
    if (event.kind !== "resolved") return;
    // IDS ONLY, field by field — never `...event`. `lane` stays internal.
    const parsed = activityResolvedEventSchema.safeParse({
      type: event.type,
      kind: event.kind,
      activityId: event.activityId,
      chainFamily: event.chainFamily,
      chainId: event.chainId,
      status: event.status,
      occurredAt: event.occurredAt,
    });
    if (!parsed.success) {
      log.warn("[agent:activity-resolved-bridge] dropped invalid payload", {
        issues: parsed.error.issues,
      });
      return;
    }
    broadcastToAllWindows(EV.portfolio.activityResolved, parsed.data);
  });

  return () => {
    off();
  };
}
