/**
 * Bridges the Agent runtime's first-time Lighter setup handoff to renderer
 * windows. The payload is re-validated here and again in preload; any drift or
 * extra field is dropped rather than widening this security-sensitive route.
 */

import { EV } from "@shared/ipc/channels.js";
import { lighterSetupHandoffEventSchema } from "@shared/schemas/lighter-setup-handoff.js";
import { lighterSetupBus } from "@vex-agent/engine/runtime/lighter-setup-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

export function setupLighterSetupBridge(): () => void {
  const off = lighterSetupBus.subscribe((event) => {
    const parsed = lighterSetupHandoffEventSchema.safeParse(event);
    if (!parsed.success) {
      log.warn("[agent:lighter-setup-bridge] dropped invalid payload", {
        issues: parsed.error.issues,
      });
      return;
    }

    broadcastToAllWindows(EV.engine.lighterSetupRequested, parsed.data);
  });

  return () => {
    off();
  };
}
