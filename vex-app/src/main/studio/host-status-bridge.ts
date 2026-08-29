/**
 * Subscribe the Studio host-status cache to the IPC broadcaster (stage B0).
 *
 * The ONLY piece of the host-status path that touches Electron. Mirrors
 * `agent/mission-update-bridge.ts`: validate the payload with the shared schema
 * before it crosses the boundary, drop what does not conform, and return the
 * teardown for `globalCleanup`.
 *
 * The re-validation is defense in depth, not ceremony. The host composes this
 * payload from its own counters and flags, and a composition bug there is
 * exactly the kind of thing that would otherwise push an off-contract shape -
 * or, worse, a field carrying the endpoint path - into the renderer. The schema
 * is `.strict()`, so an extra key fails here rather than arriving.
 */

import { EV } from "@shared/ipc/channels.js";
import { studioHostStatusSchema } from "@shared/schemas/studio.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";
import { onStudioHostStatus } from "./host-status.js";

export function setupStudioHostStatusBridge(): () => void {
  const off = onStudioHostStatus((status) => {
    const parsed = studioHostStatusSchema.safeParse(status);
    if (!parsed.success) {
      log.error(
        "[studio:host-status] refused to publish an invalid StudioHostStatus",
        parsed.error.format(),
      );
      return;
    }
    broadcastToAllWindows(EV.studio.hostStatus, parsed.data);
  });

  return () => {
    off();
  };
}
