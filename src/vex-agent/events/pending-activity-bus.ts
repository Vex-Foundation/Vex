/**
 * In-process pending-activity event bus (Wave P — the real-time pending
 * resolver).
 *
 * Shape-for-shape mirror of `engine/runtime/launch-form-bus.ts`: same
 * `Set<listener>`, same idempotent unsubscribe, same misbehaving-listener
 * isolation, same exported singleton, same post-commit emit contract. Two
 * kinds ride this one bus because they describe the SAME row's life:
 *
 * - `armed`    — a broadcast was accepted; the fast lane should start watching.
 * - `resolved` — the row reached a terminal status; disarm, push, snapshot.
 *
 * ## Why a new module and not a topic on an existing bus
 *
 * The producers are DB repositories (`db/repos/agent-activity/*`), which own no
 * engine state and must not import the engine runtime. `events/` is a leaf with
 * no DB and no sync import, so the direction stays `repos → events` and
 * `sync → events` with no cycle. Hanging this off `engine/runtime/*` would make
 * every repo write reach into the turn runtime, which is the opposite of the
 * process-boundary rule.
 *
 * ## The payload is IDS ONLY
 *
 * Row id, chain family/id, and a timestamp. No amounts, no tx hashes, no token
 * identities. Subscribers re-read the DB, which stays the single source of
 * truth. This is what makes the event safe to forward to the renderer verbatim.
 *
 * ## POST-COMMIT EMIT CONTRACT — binding on every producer
 *
 * Producers emit ONLY AFTER the UPDATE that moved the row has COMMITTED, and
 * ONLY when that CAS actually applied. Each producing statement here is a single
 * auto-committed UPDATE, so `applied === true` already means "committed". An
 * emit issued before the commit would make every subscriber re-read the
 * PRE-transition row — the fast lane would watch a row that is not yet
 * broadcast, and the renderer would re-render the still-pending state.
 */

export const PENDING_ACTIVITY_EVENT_TYPE = "sync.activity.pending" as const;

/** Which side of a pending row's life the event describes. */
export type PendingActivityEventKind = "armed" | "resolved";

/** Chain family as persisted on `agent_activity.chain_family`. */
export type PendingActivityChainFamily = "eip155" | "solana";

/**
 * WHICH LEG CAN ANSWER "did this row settle?" — the authoritative lane
 * discriminator.
 *
 * - `onchain` — Vex signed and broadcast this row itself, so its truth is a
 *   receipt/signature we can look up from a hash we hold.
 * - `provider` — a LOGICAL row (the bridge `bridge_fill_expected`) whose fill
 *   has not happened yet. It holds no hash and no submit timestamp of its own;
 *   only the bridge API knows its state.
 *
 * THIS IS SET BY THE CAS THAT ARMS THE LANE, never inferred downstream. The CAS
 * is the one place that knows which kind of row it just moved:
 * `attachProviderOrderId` arms `provider`, the broadcast-accepted transitions
 * arm `onchain`. Inferring it from the payload (e.g. "chain id is null") was the
 * live defect this field replaces: a logical bridge row carries a NON-NULL
 * destination chain id, so it was misrouted into the on-chain leg, which then
 * disarmed it immediately for lacking the hash it can never have.
 */
export type PendingActivityLane = "onchain" | "provider";

export interface PendingActivityEvent {
  readonly type: typeof PENDING_ACTIVITY_EVENT_TYPE;
  readonly kind: PendingActivityEventKind;
  readonly activityId: number;
  readonly chainFamily: PendingActivityChainFamily;
  readonly chainId: number | null;
  /** The authoritative lane discriminator — see `PendingActivityLane`. */
  readonly lane: PendingActivityLane;
  /**
   * Terminal status for `resolved`, `null` for `armed`. A bounded open string
   * rather than an enum, per the tolerant-reader law: a new terminal status must
   * not require every subscriber to change before the push can carry it.
   */
  readonly status: string | null;
  readonly occurredAt: string;
}

export type PendingActivityListener = (event: PendingActivityEvent) => void;

export class PendingActivityBus {
  private readonly listeners = new Set<PendingActivityListener>();

  emit(event: PendingActivityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: PendingActivityListener): () => void {
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

export const pendingActivityBus = new PendingActivityBus();

/**
 * Producer-side convenience for the arm side so every emit site stamps `type`,
 * `kind` and `occurredAt` identically. Call it only after the staging/broadcast
 * CAS applied and committed.
 */
export function emitPendingActivityArmed(input: {
  readonly activityId: number;
  readonly chainFamily: PendingActivityChainFamily;
  readonly chainId: number | null;
  /** REQUIRED — the arming CAS names the lane; nothing downstream may guess it. */
  readonly lane: PendingActivityLane;
}): void {
  pendingActivityBus.emit({
    type: PENDING_ACTIVITY_EVENT_TYPE,
    kind: "armed",
    activityId: input.activityId,
    chainFamily: input.chainFamily,
    chainId: input.chainId,
    lane: input.lane,
    status: null,
    occurredAt: new Date().toISOString(),
  });
}

/**
 * Producer-side convenience for the resolve side. Call it only after the
 * terminalizing CAS applied and committed — a subscriber's first action is to
 * re-read the row.
 */
export function emitPendingActivityResolved(input: {
  readonly activityId: number;
  readonly chainFamily: PendingActivityChainFamily;
  readonly chainId: number | null;
  readonly lane: PendingActivityLane;
  readonly status: string;
}): void {
  pendingActivityBus.emit({
    type: PENDING_ACTIVITY_EVENT_TYPE,
    kind: "resolved",
    activityId: input.activityId,
    chainFamily: input.chainFamily,
    chainId: input.chainId,
    lane: input.lane,
    status: input.status,
    occurredAt: new Date().toISOString(),
  });
}
