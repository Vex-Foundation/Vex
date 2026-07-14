/**
 * Read-only bridge from the main-owned Hypervexing workspace controller to
 * the in-process agent runtime.
 *
 * Electron main is the sole owner of the transient, per-session mode map.
 * The engine only asks this registered provider whether a particular session
 * is in the focused workspace. An absent or invalid provider deliberately
 * resolves to `normal`, so aliases and the compact index never leak by
 * default. This state is intentionally process-local and is never persisted.
 */

export type HyperliquidWorkspaceMode = "hypervexing" | "normal";

export type HlWorkspaceModeProvider = (sessionId: string) => unknown;

let workspaceModeProvider: HlWorkspaceModeProvider | null = null;

/** Register the live main-owned mode lookup before engine turns begin. */
export function registerHlWorkspaceModeProvider(provider: HlWorkspaceModeProvider): void {
  workspaceModeProvider = provider;
}

/** Test and shutdown helper. Normal mode is the fail-closed default. */
export function clearHlWorkspaceModeProvider(): void {
  workspaceModeProvider = null;
}

/**
 * Resolve one session's transient mode. Any missing, malformed, or throwing
 * provider is normal mode: the engine must never expose a hot tool set merely
 * because the main controller is unavailable.
 */
export function resolveHlWorkspaceMode(sessionId: string | undefined): HyperliquidWorkspaceMode {
  if (sessionId === undefined || workspaceModeProvider === null) return "normal";
  try {
    const value = workspaceModeProvider(sessionId);
    return value === "hypervexing" || value === "normal" ? value : "normal";
  } catch {
    return "normal";
  }
}

export function isHlWorkspaceModeActive(sessionId: string | undefined): boolean {
  return resolveHlWorkspaceMode(sessionId) === "hypervexing";
}
