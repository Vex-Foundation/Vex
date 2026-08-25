/**
 * In-process Vex Studio settlement event bus.
 *
 * Same shape as `mission-bus.ts` and `control-bus.ts`: a `Set<listener>`,
 * idempotent unsubscribe, misbehaving-listener isolation. A separate module
 * rather than another kind on the mission bus, because the subscriber is
 * different in kind: the mission bus tells the RENDERER that a surface changed,
 * this tells the MAIN-PROCESS BROKER that one blocked MCP call now has a
 * durable answer. Sharing a bus would make either one's blast radius the
 * other's, and would push Studio ids into every renderer window.
 *
 * DURABLE FIRST, WAITER SECOND. The producer emits only after the settlement or
 * refusal transaction has COMMITTED, so a subscriber that reads the row by id
 * on this signal always finds committed state. A lost listener therefore costs
 * a blocked call its early answer, never its correctness: the row is right, the
 * approvals UI shows it, and the call's own expiry still fires.
 *
 * The payload is bounded to IDS AND ONE ENUM. No tool output, no provider text,
 * no refusal prose ever rides this bus; the database stays the source of truth
 * for what happened, exactly as the mission bus does.
 */

export const STUDIO_SETTLEMENT_EVENT_TYPE = "engine.studio.settlement" as const;

/**
 * How a Studio intent ended, as a closed enum.
 *
 *   `settled`         the approved call dispatched and its result is stored;
 *   `rejected`        no dispatch happened: declined, expired, refused, or
 *                     failed closed at a commit-time check;
 *   `dispatch_failed` the dispatch was attempted and could not be carried out;
 *   `indeterminate`   the dispatch may have happened and the outcome cannot be
 *                     proven. It is NOT a failure and must never be retried.
 */
export type StudioSettlementOutcome =
  | "settled"
  | "rejected"
  | "dispatch_failed"
  | "indeterminate";

export interface StudioSettlementEvent {
  readonly type: typeof STUDIO_SETTLEMENT_EVENT_TYPE;
  readonly approvalId: string;
  /** `null` only for a row whose project reference was never written. */
  readonly projectId: string | null;
  readonly outcome: StudioSettlementOutcome;
  readonly occurredAt: string;
}

export type StudioSettlementListener = (event: StudioSettlementEvent) => void;

export class StudioSettlementBus {
  private readonly listeners = new Set<StudioSettlementListener>();

  emit(event: StudioSettlementEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: StudioSettlementListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const studioSettlementBus = new StudioSettlementBus();

/**
 * Producer-side convenience so every emit site stamps `type` and `occurredAt`
 * identically. Call it only after the producing transaction has COMMITTED.
 */
export function emitStudioSettlement(input: {
  readonly approvalId: string;
  readonly projectId: string | null;
  readonly outcome: StudioSettlementOutcome;
}): void {
  studioSettlementBus.emit({
    type: STUDIO_SETTLEMENT_EVENT_TYPE,
    approvalId: input.approvalId,
    projectId: input.projectId,
    outcome: input.outcome,
    occurredAt: new Date().toISOString(),
  });
}
