export interface TransitionLogObservation {
  readonly suppressedCount: number;
}

export interface TransitionLog {
  /** State must contain only stable, sanitized facts, never timestamps or payloads. */
  observe(key: string, state: string): TransitionLogObservation | undefined;
  /** Recovery or disposal forgets this incident so a recurrence emits immediately. */
  clear(key: string): TransitionLogObservation | undefined;
}

/**
 * First observation, state changes, and five-minute reminders remain visible.
 * No timers are allocated. Idle keys are evicted when the bounded LRU fills;
 * a later observation of an evicted key is treated as a new incident.
 */
export function createTransitionLog(options: {
  reminderMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}): TransitionLog {
  const reminderMs = Math.max(5 * 60_000, options.reminderMs ?? 5 * 60_000);
  const maxEntries = Math.max(1, options.maxEntries ?? 256);
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, { state: string; emittedAt: number; suppressedCount: number }>();

  return {
    observe(key, state) {
      const at = now();
      const previous = entries.get(key);
      entries.delete(key);
      if (previous && previous.state === state && at >= previous.emittedAt
        && at - previous.emittedAt < reminderMs) {
        previous.suppressedCount++;
        entries.set(key, previous);
        return undefined;
      }
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { state, emittedAt: at, suppressedCount: 0 });
      return { suppressedCount: previous?.suppressedCount ?? 0 };
    },
    clear(key) {
      const previous = entries.get(key);
      entries.delete(key);
      return previous === undefined ? undefined : { suppressedCount: previous.suppressedCount };
    },
  };
}
