/**
 * Hypervexing workspace bridge adapter — the ONE place the renderer touches
 * the main-process workspace surface.
 *
 * Product contract: the mode is HIDDEN and AGENT-DRIVEN. Entry is a main→
 * renderer push (`onWorkspaceMode`); the only renderer→main request is EXIT
 * (`exitWorkspace`). There is deliberately NO renderer "enter" invoke — the
 * agent decides.
 *
 * Every access is optional-chained so the renderer never crashes if the bridge
 * surface is absent (older preload, a shell test that stubs a partial
 * `window.vex.hyperliquid`). The bridge method names live ONLY here, so if
 * main renames a channel the reconciliation is a one-line change in this file.
 */

import type { HyperliquidWorkspaceModeEvent } from "@shared/schemas/hyperliquid.js";

/** No-op unsubscribe returned when the bridge surface is unavailable. */
const NOOP = (): void => {};

/**
 * Subscribe to agent-driven workspace-mode pushes. Returns an unsubscribe.
 * When the bridge is absent the callback is simply never invoked (no throw).
 */
export function subscribeWorkspaceMode(
  callback: (event: HyperliquidWorkspaceModeEvent) => void,
): () => void {
  const off = window.vex?.hyperliquid?.onWorkspaceMode?.(callback);
  return off ?? NOOP;
}

/**
 * Ask main to leave the workspace (the in-mode EXIT control). Main is the
 * authority and broadcasts the resulting `normal` event. The renderer never
 * flips its local mode optimistically, so an IPC failure leaves a visible,
 * retryable in-mode state rather than diverging from the engine's session map.
 */
export async function requestWorkspaceExit(sessionId: string | null): Promise<boolean> {
  try {
    if (sessionId === null) return false;
    const exit = window.vex?.hyperliquid?.exitWorkspace;
    if (exit === undefined) return false;
    const result = await exit({ sessionId });
    return result.ok;
  } catch {
    return false;
  }
}
