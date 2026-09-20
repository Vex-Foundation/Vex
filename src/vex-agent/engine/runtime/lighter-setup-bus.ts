/**
 * In-process signal that transfers first-time Lighter setup from an Agent turn
 * to the desktop's existing deterministic setup dialog.
 *
 * The payload is metadata only: the originating session and the fixed Lighter
 * environment and durable interaction id. No key, wallet secret, amount,
 * approval or model-authored text crosses this bus. Producers emit only after
 * the pending assistant tool call and interaction row are durable.
 */

export const LIGHTER_SETUP_EVENT_TYPE = "engine.lighter.setup" as const;

export interface LighterSetupEvent {
  readonly type: typeof LIGHTER_SETUP_EVENT_TYPE;
  readonly sessionId: string;
  readonly intentId: string;
  readonly environment: "core" | "rhc";
  readonly kind: "requested";
  readonly occurredAt: string;
}

export type LighterSetupListener = (event: LighterSetupEvent) => void;

export class LighterSetupBus {
  private readonly listeners = new Set<LighterSetupListener>();

  emit(event: LighterSetupEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not prevent the setup signal reaching the
        // remaining desktop windows.
      }
    }
  }

  subscribe(listener: LighterSetupListener): () => void {
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

export const lighterSetupBus = new LighterSetupBus();

export function emitLighterSetupRequested(input: {
  readonly sessionId: string;
  readonly intentId: string;
  readonly environment: "core" | "rhc";
}): void {
  lighterSetupBus.emit({
    type: LIGHTER_SETUP_EVENT_TYPE,
    sessionId: input.sessionId,
    intentId: input.intentId,
    environment: input.environment,
    kind: "requested",
    occurredAt: new Date().toISOString(),
  });
}
