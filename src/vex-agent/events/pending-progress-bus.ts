/**
 * In-process PENDING-PROGRESS bus — the "we looked, it is still pending, here is
 * what we saw" signal.
 *
 * ## Why this is a SEPARATE bus and not a third kind on `pending-activity-bus`
 *
 * Not a style preference — a defect avoided. `fast-lane.ts`'s subscriber reads
 * every non-`resolved` event as an ARM (`if (event.kind === "resolved") {…}
 * arm(…)`). A `"progress"` kind on that bus would therefore re-arm the lane on
 * every observation, resetting `armedAt`, `attempts` and `nextDueAt`, so the
 * lane would never age out and its bookkeeping would be quietly wrong. Two
 * different facts, two different subscriber sets, two buses.
 *
 * ## Why it exists at all
 *
 * The renderer refetches the portfolio every 60 s, and the only push it has is
 * TERMINALIZATION-only by explicit design. So a 5 s observation cadence was
 * invisible: the writes landed in Postgres and sat there for up to a minute.
 * A cadence nobody can see is not a feature, it is a cost.
 *
 * ## The payload
 *
 * IDS, plus the two facts the renderer genuinely cannot derive: the reason the
 * row is still pending (or why the last check could not conclude) and the row's
 * CURRENT cadence. The subscriber's job is still to re-read the row — this bus
 * carries no amounts, no hashes and no token identities, exactly like its
 * sibling, which is what makes it safe to forward across IPC.
 *
 * `nextCheckInMs` is on the payload because a fixed "every 5s" would be FALSE
 * for any row past its fast phase, and stating a cadence we do not hold is the
 * kind of claim rule 90 forbids.
 *
 * ## POST-WRITE EMIT CONTRACT
 *
 * Producers emit only AFTER the observation's bookkeeping write has committed,
 * so a subscriber that re-reads sees the observation it was told about.
 */

export const PENDING_PROGRESS_EVENT_TYPE = "sync.activity.progress" as const;

export interface PendingProgressEvent {
  readonly type: typeof PENDING_PROGRESS_EVENT_TYPE;
  readonly activityId: number;
  readonly chainFamily: string;
  readonly chainId: number | null;
  /**
   * Why the row is still pending, when the observation was CONCLUSIVE
   * (`in_mempool`, `nonce_superseded`). `null` when the check could not
   * conclude — that case is carried by `verificationReason` instead, and the two
   * are never both set, because they answer different questions.
   */
  readonly pendingReason: string | null;
  /** Why the last CHECK could not conclude. `null` when it did conclude. */
  readonly verificationReason: string | null;
  /** The row's CURRENT phase interval — 5 s in its first 10 minutes, then 30 s. */
  readonly nextCheckInMs: number;
  readonly occurredAt: string;
}

export type PendingProgressListener = (event: PendingProgressEvent) => void;

export class PendingProgressBus {
  private readonly listeners = new Set<PendingProgressListener>();

  emit(event: PendingProgressEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: PendingProgressListener): () => void {
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

export const pendingProgressBus = new PendingProgressBus();

/**
 * Producer-side convenience, so every emit site stamps `type` and `occurredAt`
 * identically. Call it only after the observation's write has committed.
 */
export function emitPendingProgress(input: {
  readonly activityId: number;
  readonly chainFamily: string;
  readonly chainId: number | null;
  readonly pendingReason: string | null;
  readonly verificationReason: string | null;
  readonly nextCheckInMs: number;
}): void {
  pendingProgressBus.emit({
    type: PENDING_PROGRESS_EVENT_TYPE,
    activityId: input.activityId,
    chainFamily: input.chainFamily,
    chainId: input.chainId,
    pendingReason: input.pendingReason,
    verificationReason: input.verificationReason,
    nextCheckInMs: input.nextCheckInMs,
    occurredAt: new Date().toISOString(),
  });
}
