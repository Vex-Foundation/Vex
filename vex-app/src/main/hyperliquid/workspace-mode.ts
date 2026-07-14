/** Main-owned Hypervexing workspace state and renderer broadcast boundary. */

import {
  hyperliquidWorkspaceModeEventSchema,
  type HyperliquidWorkspaceModeEvent,
} from "@shared/schemas/hyperliquid.js";
import { EV } from "@shared/ipc/channels.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { hasHyperliquidSessionPolicyHistory } from "../database/hyperliquid-db.js";
import { preferencesStore } from "../preferences/store.js";
import { registerHlWorkspaceModeProvider } from "@vex-lib/hyperliquid-workspace-mode.js";

export type HyperliquidWorkspaceMode = HyperliquidWorkspaceModeEvent["mode"];

let transitionChain: Promise<void> = Promise.resolve();
const modesBySession = new Map<string, HyperliquidWorkspaceMode>();
const enteredOnce = new Set<string>();

/**
 * Register the main-owned, transient session map before the engine starts.
 * Modes are deliberately not persisted: a relaunch begins in normal mode.
 */
export function initializeHyperliquidWorkspaceModeProvider(): void {
  registerHlWorkspaceModeProvider((sessionId) => modesBySession.get(sessionId) ?? "normal");
}

/** Test/shutdown helper. It clears process-transient mode and entry history. */
export function resetHyperliquidWorkspaceModes(): void {
  modesBySession.clear();
  enteredOnce.clear();
}

/** Read the current transient mode without mutating or broadcasting it. */
export function resolveHyperliquidWorkspaceMode(sessionId: string): HyperliquidWorkspaceMode {
  return modesBySession.get(sessionId) ?? "normal";
}

/** Session ids currently eligible for Hypervexing-only main-process work. */
export function listHypervexingSessionIds(): readonly string[] {
  return [...modesBySession]
    .filter(([, mode]) => mode === "hypervexing")
    .map(([sessionId]) => sessionId);
}

/**
 * Manual re-entry eligibility is the union of process-transient successful
 * entries and any persisted session policy row. The latter is intentionally
 * status- and wallet-agnostic so sessions that configured trading retain the
 * button after an app restart. Database failures return false (fail closed).
 */
export async function hasSessionEverEnteredHypervexing(sessionId: string): Promise<boolean> {
  return enteredOnce.has(sessionId)
    || await hasHyperliquidSessionPolicyHistory(sessionId);
}

/** Serialize requests so a slower preference read cannot reorder enter/exit. */
export function requestHyperliquidWorkspaceMode(
  sessionId: string,
  mode: HyperliquidWorkspaceMode,
): Promise<HyperliquidWorkspaceModeEvent> {
  const result = transitionChain.then(async () => {
    const preferences = await preferencesStore.load();
    const event = hyperliquidWorkspaceModeEventSchema.parse({
      sessionId,
      mode,
      requestedBy: "agent",
      acknowledged: preferences.hyperliquid.riskAcknowledgedAt !== null,
    });
    if (mode === "hypervexing") enteredOnce.add(sessionId);
    if (resolveHyperliquidWorkspaceMode(sessionId) === mode) {
      return event;
    }
    // Main updates the source of truth before notifying the renderer. The
    // next engine request for this same session therefore sees the identical
    // state regardless of whether it came from the agent path or a manual
    // enter/exit request.
    // Normal is the provider default, so do not retain an entry after exit.
    // This keeps the transient map bounded across a long-lived desktop run.
    if (mode === "hypervexing") modesBySession.set(sessionId, mode);
    else modesBySession.delete(sessionId);
    broadcastToAllWindows(EV.hyperliquid.workspaceMode, event);
    return event;
  });
  transitionChain = result.then(() => undefined, () => undefined);
  return result;
}
