/** Agent requests for the main-owned Hypervexing workspace mode. */

export type HyperliquidWorkspaceMode = "hypervexing" | "normal";

export interface HyperliquidWorkspaceRequestEvent {
  /** Session whose transient main-owned workspace mode should change. */
  readonly sessionId: string;
  readonly mode: HyperliquidWorkspaceMode;
  readonly requestedBy: "agent";
}

export class HyperliquidWorkspaceRequestBus {
  private readonly listeners = new Set<(event: HyperliquidWorkspaceRequestEvent) => void>();

  emit(event: HyperliquidWorkspaceRequestEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Workspace presentation must never make a completed tool fail.
      }
    }
  }

  subscribe(listener: (event: HyperliquidWorkspaceRequestEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const hyperliquidWorkspaceRequestBus = new HyperliquidWorkspaceRequestBus();
