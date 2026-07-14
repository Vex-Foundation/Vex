/** Main bridge for post-commit Hyperliquid risk proposal signals. */

import { hyperliquidRiskProposalBus } from "@vex-agent/engine/events/hyperliquid-risk-bus.js";
import { EV } from "@shared/ipc/channels.js";
import { listHyperliquidRiskProposals } from "../database/hyperliquid-db.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

export function setupHyperliquidRiskProposalBridge(): () => void {
  return hyperliquidRiskProposalBus.subscribe((event) => {
    void listHyperliquidRiskProposals(event.sessionId)
      .then((result) => {
        if (!result.ok) return;
        const proposal = result.data.find((candidate) => candidate.proposalId === event.proposalId);
        if (proposal !== undefined) {
          broadcastToAllWindows(EV.hyperliquid.riskProposalUpdate, proposal);
        }
      })
      .catch((cause: unknown) => {
        log.warn("[agent:hyperliquid-risk-bridge] proposal refresh failed", cause);
      });
  });
}
