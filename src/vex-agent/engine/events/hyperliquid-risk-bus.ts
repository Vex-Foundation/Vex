/**
 * Post-commit signal for durable Hyperliquid risk proposals.
 *
 * The event carries identifiers only. Electron main re-reads and validates the
 * renderer DTO from Postgres before broadcasting, so model-produced policy
 * text can never become a trusted UI card payload.
 */

export interface HyperliquidRiskProposalEvent {
  readonly sessionId: string;
  readonly proposalId: string;
}

export class HyperliquidRiskProposalBus {
  private readonly listeners = new Set<(event: HyperliquidRiskProposalEvent) => void>();

  emit(event: HyperliquidRiskProposalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A renderer-refresh observer must never fail a committed proposal.
      }
    }
  }

  subscribe(listener: (event: HyperliquidRiskProposalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const hyperliquidRiskProposalBus = new HyperliquidRiskProposalBus();
