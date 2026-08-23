/**
 * In-process mission-update event bus.
 *
 * Same shape as `control-bus.ts` (which itself mirrors `transcript-bus.ts`):
 * a `Set<listener>`, idempotent unsubscribe, misbehaving-listener isolation.
 * Deliberately a SEPARATE module from the control bus rather than another
 * topic on it — the two have different producers and different subscribers,
 * and a shared file would make either one's blast radius the other's.
 *
 * Producers emit only AFTER the DB transaction that created the fetchable row
 * has committed. That is the repo's emit-after-commit doctrine: a visible
 * event must always correspond to a row the renderer can then read. The
 * `vex-app` main process subscribes through the agent bridges, re-validates
 * against the shared schema, and broadcasts to the windows.
 *
 * The payload is bounded — ids, an enum and a timestamp. No draft content, no
 * provider text, no error strings ever ride this bus: it is a signal that
 * something changed, and the DB stays the source of truth for what.
 */

export const MISSION_UPDATE_EVENT_TYPE = "engine.mission.update" as const;

/**
 * Why the mission surface changed. Consumers invalidate their reads on any of
 * these; the finer grain exists so a consumer that only cares about approvals
 * does not have to refetch a draft on every patch.
 */
export type MissionUpdateKind =
  /** A model patch was written to the mission draft. */
  | "draft_updated"
  /** The draft crossed the ready/not-ready boundary. */
  | "readiness_changed"
  /** The host accepted the mission contract — "Start mission" is now live. */
  | "accepted"
  /** An approval intent was enqueued and is now pending a human decision. */
  | "approval_enqueued"
  /**
   * A mission SETUP turn finished without writing anything to an incomplete
   * draft. Nothing changed - that is precisely the point. Every other kind means
   * "refetch, the row moved"; this one means "the row did NOT move and will not
   * move on its own", which is the only way the host can tell a draft that is
   * still progressing from one that has stalled. Consumers must NOT refetch the
   * draft on it.
   */
  | "setup_no_progress";

export interface MissionUpdateEvent {
  readonly type: typeof MISSION_UPDATE_EVENT_TYPE;
  readonly sessionId: string;
  /** `null` when the producer has no mission in scope (chat-session approval). */
  readonly missionId: string | null;
  readonly kind: MissionUpdateKind;
  readonly occurredAt: string;
}

export type MissionUpdateListener = (event: MissionUpdateEvent) => void;

export class MissionUpdateBus {
  private readonly listeners = new Set<MissionUpdateListener>();

  emit(event: MissionUpdateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: MissionUpdateListener): () => void {
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

export const missionUpdateBus = new MissionUpdateBus();

/**
 * Producer-side convenience so every emit site stamps `type` and `occurredAt`
 * identically. Call it only after the producing transaction has resolved.
 */
export function emitMissionUpdate(input: {
  readonly sessionId: string;
  readonly missionId: string | null;
  readonly kind: MissionUpdateKind;
}): void {
  missionUpdateBus.emit({
    type: MISSION_UPDATE_EVENT_TYPE,
    sessionId: input.sessionId,
    missionId: input.missionId,
    kind: input.kind,
    occurredAt: new Date().toISOString(),
  });
}
