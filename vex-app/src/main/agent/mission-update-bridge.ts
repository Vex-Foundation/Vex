/**
 * Engine -> renderer mission-update bridge.
 *
 * Subscribes to the in-process `missionUpdateBus`
 * (`src/vex-agent/engine/runtime/mission-bus.ts`) and broadcasts each event to
 * every BrowserWindow on `EV.engine.missionUpdate`.
 *
 * A pass-through validate, like `transcript-bridge` and unlike
 * `stream-bridge`: the engine payload is already bounded to ids, an enum and a
 * timestamp, so there is nothing to sanitize — only to verify. Drift in the
 * engine payload is dropped at this boundary rather than forwarded, and the
 * preload subscriber re-validates a third time.
 *
 * Producers emit only AFTER the transaction that created the fetchable row has
 * committed, so a renderer that refetches on this signal is guaranteed to see
 * the row the event refers to.
 *
 * Import discipline: the bus is imported DIRECTLY from `mission-bus.js`, not
 * the engine barrel, which would pull the DB client into the main-process
 * graph at bridge-setup time.
 */

import { EV } from "@shared/ipc/channels.js";
import { missionUpdateEventSchema } from "@shared/schemas/mission-update.js";
import { missionUpdateBus } from "@vex-agent/engine/runtime/mission-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

/**
 * Subscribe the mission-update bus to the IPC broadcaster. Returns the
 * teardown — the caller pushes it into `globalCleanup`.
 */
export function setupMissionUpdateBridge(): () => void {
  const off = missionUpdateBus.subscribe((event) => {
    const parsed = missionUpdateEventSchema.safeParse(event);
    if (!parsed.success) {
      log.warn("[agent:mission-update-bridge] dropped invalid payload", {
        issues: parsed.error.issues,
      });
      return;
    }
    broadcastToAllWindows(EV.engine.missionUpdate, parsed.data);
  });

  return () => {
    off();
  };
}
