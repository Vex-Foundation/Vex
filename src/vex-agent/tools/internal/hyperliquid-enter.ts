/** Direct internal entry point for the main-owned Hypervexing workspace. */

import type { InternalToolContext } from "./types.js";
import type { ToolResult } from "../types.js";
import { requestHyperliquidWorkspaceMode } from "../protocols/hyperliquid/handlers.js";

export async function handleHyperliquidEnter(
  _args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  return requestHyperliquidWorkspaceMode("hypervexing", context);
}
