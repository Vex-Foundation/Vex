/**
 * Engine -> renderer compaction-preparation bridge (compaction v2).
 *
 * Subscribes to the in-process `compactionPreparationBus`
 * (`src/vex-agent/engine/runtime/compaction-bus.ts`) and broadcasts each event
 * to every BrowserWindow on `EV.engine.compactionPreparation`.
 *
 * A pass-through validate, like `mission-update-bridge` and unlike
 * `stream-bridge`: the engine payload is already bounded to a session id, a
 * closed status enum, a boolean and a correlation id, so there is nothing to
 * sanitize — only to verify. A payload carrying an unknown status, or an extra
 * field (the strict parse rejects it, which is how a prose field smuggled onto
 * the event would be caught), is DROPPED here rather than forwarded, and the
 * preload subscriber re-validates a third time.
 *
 * Producers emit only AFTER the transaction that made the row fetchable has
 * committed, so a renderer that refetches on this signal is guaranteed to see
 * the state the event names.
 *
 * Import discipline: the bus is imported DIRECTLY from `compaction-bus.js`,
 * not the engine barrel, which would pull the DB client into the main-process
 * graph at bridge-setup time.
 */

import { EV } from "@shared/ipc/channels.js";
import { compactionPreparationEventSchema } from "@shared/schemas/compaction-preparation.js";
import { compactionPreparationBus } from "@vex-agent/engine/runtime/compaction-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

/**
 * Subscribe the preparation bus to the IPC broadcaster. Returns the teardown —
 * the caller pushes it into `globalCleanup`.
 */
export function setupCompactionPreparationBridge(): () => void {
  const off = compactionPreparationBus.subscribe((event) => {
    const parsed = compactionPreparationEventSchema.safeParse(event);
    if (!parsed.success) {
      log.warn("[agent:compaction-preparation-bridge] dropped invalid payload", {
        issues: parsed.error.issues,
      });
      return;
    }
    broadcastToAllWindows(EV.engine.compactionPreparation, parsed.data);
  });

  return () => {
    off();
  };
}
