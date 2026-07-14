/** Post-signing builder-consent signal consumed only by Electron main. */

export class HyperliquidBuilderConsentBus {
  private readonly listeners = new Set<(maxFeeRate: "0.025%") => void>();

  emit(maxFeeRate: "0.025%"): void {
    for (const listener of this.listeners) {
      try { listener(maxFeeRate); } catch { /* persistence observer is best effort */ }
    }
  }

  subscribe(listener: (maxFeeRate: "0.025%") => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const hyperliquidBuilderConsentBus = new HyperliquidBuilderConsentBus();
