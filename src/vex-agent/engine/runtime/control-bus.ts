/**
 * In-process control-state event bus (puzzle 03).
 *
 * Mirror of `transcript-bus.ts` from puzzle 02 — same `Set<listener>`
 * shape, same idempotent unsubscribe, same misbehaving-listener
 * isolation. Producers (runtime IPC handlers, atomic helpers, lease
 * handles) emit AFTER the DB transaction commits; the `vex-app` main
 * process subscribes through `setupAgentBridges()`, re-validates with
 * `controlStateEventSchema`, then broadcasts via
 * `broadcastToAllWindows(EV.engine.controlState, ...)`.
 *
 * Bus is the signal layer. DB stays source of truth — the renderer
 * always re-reads `runtime.getState` after invalidation.
 */

export const CONTROL_STATE_EVENT_TYPE = "engine.control.state" as const;

export type ControlEventStatus =
  | "running"
  | "paused_approval"
  | "paused_wake"
  | "paused_error"
  | "paused_user"
  | "paused_plan_acceptance"
  | "paused_user_form"
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled";

export type ControlEventPendingKind =
  | "pause_after_step"
  | "stop_terminal"
  | "resume"
  | "cancel_wake";

export interface ControlStateEvent {
  readonly type: typeof CONTROL_STATE_EVENT_TYPE;
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly runStatus: ControlEventStatus | null;
  readonly stopReason: string | null;
  readonly pendingControlKind: ControlEventPendingKind | null;
  readonly leaseActive: boolean;
  readonly leaseExpiresAt: string | null;
  readonly correlationId: string | null;
}

export type ControlStateListener = (event: ControlStateEvent) => void;

export class ControlStateBus {
  private readonly listeners = new Set<ControlStateListener>();

  emit(event: ControlStateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: ControlStateListener): () => void {
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

export const controlStateBus = new ControlStateBus();
