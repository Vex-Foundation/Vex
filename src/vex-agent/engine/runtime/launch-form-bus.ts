/**
 * In-process launch-form event bus (§C3b — the agent asked the user to launch).
 *
 * Shape-for-shape mirror of `mission-bus.ts` / `compaction-bus.ts`: same
 * `Set<listener>`, same idempotent unsubscribe, same misbehaving-listener
 * isolation, same exported singleton. The `vex-app` main process subscribes
 * through the agent bridges, re-validates against the shared schema, then
 * broadcasts via `broadcastToAllWindows(EV.tokenLaunch.formRequested, …)`.
 *
 * ## Why this is its OWN bus and not a topic on an existing one
 *
 * The obvious reuse candidate is `control-bus.ts`, which already knows the
 * `paused_user_form` run status. It cannot serve: `trench.launch_request_form`
 * parks a MISSION RUN, and a CHAT session has no run to park — the turn simply
 * ends holding the pending call (see `request-form.ts`). A control-state event
 * therefore never fires for a chat-mode launch, which is the majority case for
 * "the agent asked me to launch a token". Hanging the dialog off that signal
 * would open it for mission sessions only.
 *
 * `mission-bus.ts` is equally wrong: a launch form is not a mission surface, it
 * has a different producer and a different subscriber, and that file's own
 * header states why such a pair gets separate modules rather than one shared
 * blast radius.
 *
 * ## The payload is METADATA ONLY
 *
 * Ids and a timestamp. The token name, symbol, description, image and prebuy
 * all stay in the row: the renderer treats this purely as an invalidation
 * signal and re-reads `tokenLaunch.getAwaiting`, with the DB as source of
 * truth. Same doctrine as every other bus here — nothing that can carry model
 * output rides the wire.
 *
 * ## POST-COMMIT EMIT CONTRACT — binding on every producer
 *
 * Producers emit ONLY AFTER the transaction that inserted the
 * `awaiting_user_form` row has COMMITTED. The renderer opens a dialog by
 * re-reading that row; an emit issued inside the transaction would make the
 * read observe nothing and the form would never appear.
 */

export const LAUNCH_FORM_EVENT_TYPE = "engine.launch.form" as const;

/**
 * What happened to the form.
 *
 * Only `requested` exists today, and it is an enum rather than a bare signal so
 * that a later "expired" or "resolved" push can be added without every
 * subscriber having to re-derive which one it received.
 */
export type LaunchFormEventKind = "requested";

export interface LaunchFormEvent {
  readonly type: typeof LAUNCH_FORM_EVENT_TYPE;
  readonly sessionId: string;
  readonly intentId: string;
  readonly kind: LaunchFormEventKind;
  readonly occurredAt: string;
}

export type LaunchFormListener = (event: LaunchFormEvent) => void;

export class LaunchFormBus {
  private readonly listeners = new Set<LaunchFormListener>();

  emit(event: LaunchFormEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: LaunchFormListener): () => void {
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

export const launchFormBus = new LaunchFormBus();

/**
 * Producer-side convenience so every emit site stamps `type` and `occurredAt`
 * identically. Call it only after the producing transaction has COMMITTED.
 */
export function emitLaunchFormRequested(input: {
  readonly sessionId: string;
  readonly intentId: string;
}): void {
  launchFormBus.emit({
    type: LAUNCH_FORM_EVENT_TYPE,
    sessionId: input.sessionId,
    intentId: input.intentId,
    kind: "requested",
    occurredAt: new Date().toISOString(),
  });
}
