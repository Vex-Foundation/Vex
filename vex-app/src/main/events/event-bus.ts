/**
 * Generic in-process pub/sub primitives used by domain progress streams
 * (database migrations, the local runtime). Two flavors:
 *
 *  - `Bus<T>`: forward-only — subscribers receive future emissions.
 *  - `ReplayBus<T>`: tracks the last emitted event and replays it to
 *    new subscribers on `subscribe()`.
 *
 * IMPORTANT (codex turn 2 / turn 4): `ReplayBus`'s `subscribe()` replay
 * only fires for in-process listeners. Renderer subscribers listen to
 * Electron events forwarded by the IPC handler — the bus does NOT cross
 * the IPC boundary on its own. To deliver "latest state to a late
 * renderer," the IPC handler must call `peek()` and forward the value
 * to that renderer's webContents explicitly. The bus exposes `peek()`
 * for exactly this hop.
 *
 * Domain modules (`database/progress-bus.ts`) keep typed singleton
 * instances so consumers import a named bus, not a generic factory call
 * site (better grep, better signal in stacks).
 */

class Bus<T> {
  protected readonly listeners = new Set<(payload: T) => void>();

  emit(payload: T): void {
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: (payload: T) => void): () => void {
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

class ReplayBus<T> extends Bus<T> {
  private lastEvent: T | null = null;

  override emit(payload: T): void {
    this.lastEvent = payload;
    super.emit(payload);
  }

  override subscribe(listener: (payload: T) => void): () => void {
    const off = super.subscribe(listener);
    if (this.lastEvent !== null) {
      try {
        listener(this.lastEvent);
      } catch {
        /* ignore */
      }
    }
    return off;
  }

  /** Most recent event without subscribing. Returns null before any emit. */
  peek(): T | null {
    return this.lastEvent;
  }

  /** Drop the cached last event so a fresh run does not replay stale state. */
  reset(): void {
    this.lastEvent = null;
  }
}

export { Bus, ReplayBus };
