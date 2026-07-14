/** Engine-to-main bridge for agent-requested Hypervexing workspace changes. */

import { hyperliquidWorkspaceRequestBus } from "@vex-agent/engine/events/hyperliquid-workspace-bus.js";
import { log } from "../logger/index.js";
import { requestHyperliquidWorkspaceMode } from "../hyperliquid/workspace-mode.js";

export function setupHyperliquidWorkspaceBridge(): () => void {
  return hyperliquidWorkspaceRequestBus.subscribe((event) => {
    void requestHyperliquidWorkspaceMode(event.sessionId, event.mode).catch((cause: unknown) => {
      log.warn("[agent:hyperliquid-workspace-bridge] workspace request failed", cause);
    });
  });
}
