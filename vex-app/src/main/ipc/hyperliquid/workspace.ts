import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  hyperliquidWorkspaceEnterAcceptedSchema,
  hyperliquidWorkspaceEnterInputSchema,
  hyperliquidWorkspaceExitInputSchema,
  hyperliquidWorkspaceModeDtoSchema,
  hyperliquidWorkspaceModeEventSchema,
  hyperliquidWorkspaceModeReadInputSchema,
  type HyperliquidWorkspaceEnterAccepted,
  type HyperliquidWorkspaceModeDto,
  type HyperliquidWorkspaceModeEvent,
} from "@shared/schemas/hyperliquid.js";
import { getSessionWalletScope } from "../../database/sessions-db.js";
import {
  hasSessionEverEnteredHypervexing,
  requestHyperliquidWorkspaceMode,
  resolveHyperliquidWorkspaceMode,
} from "../../hyperliquid/workspace-mode.js";
import { preferencesStore } from "../../preferences/store.js";
import { registerHandler } from "../register-handler.js";
import { requireExistingHyperliquidSession } from "./support.js";

export function registerHyperliquidWorkspaceModeHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.getWorkspaceMode,
    domain: "hyperliquid",
    inputSchema: hyperliquidWorkspaceModeReadInputSchema,
    outputSchema: hyperliquidWorkspaceModeDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidWorkspaceModeDto>> => {
      const sessionError = await requireExistingHyperliquidSession(input.sessionId, ctx.requestId);
      if (sessionError !== null) return sessionError;
      const preferences = await preferencesStore.load();
      return ok(hyperliquidWorkspaceModeDtoSchema.parse({
        mode: resolveHyperliquidWorkspaceMode(input.sessionId),
        acknowledged: preferences.hyperliquid.riskAcknowledgedAt !== null,
        everEntered: await hasSessionEverEnteredHypervexing(input.sessionId),
      }));
    },
  });
}

function manualEntryRejected(message: string, correlationId: string): Result<never> {
  return err({
    code: "validation.invalid_input",
    domain: "hyperliquid",
    message,
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

export function registerHyperliquidEnterWorkspaceHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.enterWorkspace,
    domain: "hyperliquid",
    inputSchema: hyperliquidWorkspaceEnterInputSchema,
    outputSchema: hyperliquidWorkspaceEnterAcceptedSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidWorkspaceEnterAccepted>> => {
      const sessionError = await requireExistingHyperliquidSession(input.sessionId, ctx.requestId);
      if (sessionError !== null) return sessionError;

      const preferences = await preferencesStore.load();
      if (preferences.hyperliquid.riskAcknowledgedAt === null) {
        return manualEntryRejected(
          "Acknowledge Hyperliquid risk before manual re-entry, or use the agent path to enter Hypervexing.",
          ctx.requestId,
        );
      }
      if (!await hasSessionEverEnteredHypervexing(input.sessionId)) {
        return manualEntryRejected(
          "Manual re-entry is available only after this session has entered Hypervexing once. Use the agent path for first entry.",
          ctx.requestId,
        );
      }

      await requestHyperliquidWorkspaceMode(input.sessionId, "hypervexing");
      return ok(hyperliquidWorkspaceEnterAcceptedSchema.parse({ accepted: true }));
    },
  });
}

export function registerHyperliquidExitWorkspaceHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.exitWorkspace,
    domain: "hyperliquid",
    inputSchema: hyperliquidWorkspaceExitInputSchema,
    outputSchema: hyperliquidWorkspaceModeEventSchema,
    handle: async (input): Promise<Result<HyperliquidWorkspaceModeEvent>> => {
      // Exit remains manual and must name an existing server-resolved session.
      // Entry is a separate fail-closed handler, not a generic mode setter.
      const scope = await getSessionWalletScope(input.sessionId);
      if (!scope.ok) return scope;
      return ok(await requestHyperliquidWorkspaceMode(input.sessionId, "normal"));
    },
  });
}

