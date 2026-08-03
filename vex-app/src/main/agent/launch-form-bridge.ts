/**
 * Engine -> renderer launch-form bridge (§C3b).
 *
 * Subscribes to the in-process `launchFormBus`
 * (`src/vex-agent/engine/runtime/launch-form-bus.ts`) and broadcasts each event
 * to every BrowserWindow on `EV.launch.formRequested`.
 *
 * A pass-through validate, like `mission-update-bridge` and unlike
 * `stream-bridge`: the engine payload is already bounded to ids, an enum and a
 * timestamp, so there is nothing to sanitize — only to verify. Drift in the
 * engine payload is dropped at this boundary rather than forwarded, and the
 * preload subscriber re-validates a third time.
 *
 * The producer emits only AFTER the transaction that inserted the
 * `awaiting_user_form` row has committed, so a renderer that reads
 * `tokenLaunch.getAwaiting` on this signal is guaranteed to find the row.
 *
 * Import discipline: the bus is imported DIRECTLY from `launch-form-bus.js`,
 * not the engine barrel, which would pull the DB client into the main-process
 * graph at bridge-setup time.
 */

import { EV } from "@shared/ipc/channels.js";
import { launchFormEventSchema } from "@shared/schemas/token-launch.js";
import { launchFormBus } from "@vex-agent/engine/runtime/launch-form-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

/**
 * Subscribe the launch-form bus to the IPC broadcaster. Returns the teardown —
 * the caller pushes it into `globalCleanup`.
 */
export function setupLaunchFormBridge(): () => void {
  const off = launchFormBus.subscribe((event) => {
    const parsed = launchFormEventSchema.safeParse(event);
    if (!parsed.success) {
      log.warn("[agent:launch-form-bridge] dropped invalid payload", {
        issues: parsed.error.issues,
      });
      return;
    }
    broadcastToAllWindows(EV.launch.formRequested, parsed.data);
  });

  return () => {
    off();
  };
}
