import { hyperliquidWorkspaceRequestBus, type HyperliquidWorkspaceMode } from "@vex-agent/engine/events/hyperliquid-workspace-bus.js";
import { resolveHlWorkspaceMode } from "../../../../lib/hyperliquid-workspace-mode.js";
import type { ProtocolExecutionContext, ProtocolHandler } from "../types.js";
import type { ToolResult } from "../../types.js";
import { fail, ok } from "./handler-shared.js";

export const HYPERLIQUID_WORKSPACE_HANDLERS: Record<string, ProtocolHandler> = {
  "hyperliquid.workspace.enter": async (_params, context) => requestHyperliquidWorkspaceMode("hypervexing", context),
  "hyperliquid.workspace.exit": async (_params, context) => requestHyperliquidWorkspaceMode("normal", context),
};

export function requestHyperliquidWorkspaceMode(
  mode: HyperliquidWorkspaceMode,
  context: ProtocolExecutionContext,
): ToolResult {
  if (context.sessionId === undefined) {
    return fail("Hypervexing workspace requests require an active session.");
  }
  const event = { sessionId: context.sessionId, mode, requestedBy: "agent" as const };
  const alreadyActive = resolveHlWorkspaceMode(context.sessionId) === mode;
  if (!alreadyActive) hyperliquidWorkspaceRequestBus.emit(event);
  return ok({
    workspaceMode: { mode: event.mode, requestedBy: event.requestedBy },
    alreadyActive,
    _displayBlock: {
      namespace: "hyperliquid",
      kind: "workspace_mode_request",
      mode: event.mode,
      requestedBy: event.requestedBy,
      alreadyActive,
    },
  });
}

