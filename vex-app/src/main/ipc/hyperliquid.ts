/** Thin registration aggregator for the Hyperliquid IPC surface. */

import { CH } from "@shared/ipc/channels.js";
import { type Result } from "@shared/ipc/result.js";
import {
  hyperliquidPositionsDtoSchema,
  hyperliquidPositionsReadInputSchema,
  type HyperliquidPositionsDto,
} from "@shared/schemas/hyperliquid.js";
import { getHyperliquidPositions } from "../database/hyperliquid-db.js";
import { registerHandler } from "./register-handler.js";
import { registerHyperliquidAccountReadHandlers } from "./hyperliquid/account-reads.js";
import { registerHyperliquidLiveFeedHandlers } from "./hyperliquid/live-feed.js";
import { registerHyperliquidMarketReadHandlers } from "./hyperliquid/market-reads.js";
import { registerHyperliquidRiskPolicyHandlers } from "./hyperliquid/risk-policy.js";
import {
  registerHyperliquidEnterWorkspaceHandler,
  registerHyperliquidExitWorkspaceHandler,
  registerHyperliquidWorkspaceModeHandler,
} from "./hyperliquid/workspace.js";

function registerPositionsHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.getPositions,
    domain: "hyperliquid",
    inputSchema: hyperliquidPositionsReadInputSchema,
    outputSchema: hyperliquidPositionsDtoSchema,
    handle: (input, ctx): Promise<Result<HyperliquidPositionsDto>> =>
      getHyperliquidPositions(input.sessionId, ctx.requestId),
  });
}

export function registerHyperliquidHandlers(): Array<() => void> {
  return [
    registerPositionsHandler(),
    ...registerHyperliquidMarketReadHandlers(),
    ...registerHyperliquidAccountReadHandlers(),
    registerHyperliquidWorkspaceModeHandler(),
    ...registerHyperliquidRiskPolicyHandlers(),
    registerHyperliquidEnterWorkspaceHandler(),
    registerHyperliquidExitWorkspaceHandler(),
    ...registerHyperliquidLiveFeedHandlers(),
  ];
}
