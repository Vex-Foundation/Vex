/**
 * In-process compaction-preparation event bus (compaction v2, package C10).
 *
 * Shape-for-shape mirror of `control-bus.ts`: same `Set<listener>`, same
 * idempotent unsubscribe, same misbehaving-listener isolation, same exported
 * singleton. The `vex-app` main process subscribes through
 * `setupAgentBridges()`, re-validates with `compactionPreparationEventSchema`,
 * then broadcasts via `broadcastToAllWindows(EV.engine.compactionPreparation, …)`.
 *
 * ## The payload is METADATA ONLY — deliberately
 *
 * `compaction_preparations` holds a verbatim frozen copy of the conversation
 * (`corpus`) and a model-authored condensation of it (`summary_output`).
 * Neither has any business crossing the renderer boundary for a progress
 * indicator, so this event carries a session id, a closed status enum, one
 * boolean and a correlation id — and nothing that can carry model output or
 * error prose. Same doctrine as `error-bus`/`error-bridge` (no provider prose
 * crosses) and the bounded `leaseActive`/`leaseExpiresAt` pair on the runtime
 * DTO.
 *
 * ## POST-COMMIT EMIT CONTRACT — binding on every producer
 *
 * Producers emit ONLY AFTER the transaction that made the row fetchable has
 * COMMITTED. The renderer treats this event purely as an invalidation signal
 * and immediately re-reads `compaction.getPreparation`; an emit issued inside
 * the transaction would make that refetch observe the OLD state and then not
 * refetch again until the 60s fallback poll — a stale button for a minute.
 * The DB stays the source of truth; the bus is the signal layer.
 */

import type { PreparationStatus } from "../../db/repos/compaction-preparations/types.js";

export const COMPACTION_PREPARATION_EVENT_TYPE =
  "engine.compaction.preparation" as const;

export interface CompactionPreparationEvent {
  readonly type: typeof COMPACTION_PREPARATION_EVENT_TYPE;
  readonly sessionId: string;
  /** The status the row carries AFTER the committed transition. */
  readonly status: PreparationStatus;
  /** Whether branch A has produced a summary — never the summary itself. */
  readonly summaryReady: boolean;
  readonly correlationId: string | null;
}

export type CompactionPreparationListener = (
  event: CompactionPreparationEvent,
) => void;

export class CompactionPreparationBus {
  private readonly listeners = new Set<CompactionPreparationListener>();

  emit(event: CompactionPreparationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: CompactionPreparationListener): () => void {
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

export const compactionPreparationBus = new CompactionPreparationBus();
