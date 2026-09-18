/**
 * Shared WebSocket "watcher" lifecycle for the Lighter stream supervisors
 * (candle-stream, public-market-stream, order-stream). Each supervisor keeps
 * one watcher per subscribed target; every watcher independently reconnects
 * with jittered exponential backoff, gives up after a bounded number of
 * consecutive failures, optionally rests and rebuilds its budget, arms a
 * handshake timeout while a socket is connecting, and pings on an interval to
 * detect a stalled connection. This module holds only that generic
 * bookkeeping (attempt counter, timers, give-up state) plus the pure backoff
 * formula. All domain logic — what "stale" means for a stream, what a ping
 * frame looks like, what status values mean, how to build the socket — stays
 * in each stream file and is threaded through as callbacks/config so every
 * stream can keep its own behavior exactly as it was before this extraction.
 */

export interface SocketWatcherBackoffConfig {
  /** Consecutive failed connection attempts before the watcher gives up. */
  readonly maxReconnectAttempts: number;
  /** Upper bound on the exponential backoff delay, in milliseconds. */
  readonly reconnectCeilingMs: number;
  /** Attempt count above which the exponent stops growing (before jitter). */
  readonly reconnectExponentCap: number;
  /**
   * Rest before automatically rebuilding an exhausted restart budget. Omit to
   * leave a given-up watcher terminally unavailable until something external
   * (a new subscriber, a credential change, ...) rearms it.
   */
  readonly giveUpRetryMs?: number;
}

/**
 * Jittered exponential backoff: doubles per attempt (capped at
 * `reconnectExponentCap`), capped again at `reconnectCeilingMs`, then
 * widened by +/-20% jitter so many watchers reconnecting at once do not
 * synchronize on the same wall-clock instant.
 */
export function reconnectDelayMs(
  attempt: number,
  random: number,
  config: Pick<SocketWatcherBackoffConfig, "reconnectCeilingMs" | "reconnectExponentCap">,
): number {
  const base = Math.min(
    config.reconnectCeilingMs,
    1_000 * (2 ** Math.min(attempt, config.reconnectExponentCap)),
  );
  const jitter = 0.8 + Math.max(0, Math.min(1, random)) * 0.4;
  return Math.floor(base * jitter);
}

/** Clears a possibly-armed timer and returns the `null` it should be reset to. */
export function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

export interface SocketWatcherGiveUpOptions {
  /** Runs once when the watcher gives up (diagnostic logging, status emit, ...). */
  readonly onGiveUp: (attempts: number, lastFailureReason: string) => void;
  /** Runs when the rest elapses and the watcher is rearmed. Required for an auto rearm to happen. */
  readonly onRearm?: () => void;
  /** Guards the rearm; a true result leaves the watcher given up. */
  readonly rearmBlocked?: () => boolean;
}

export interface SocketWatcherScheduleConnectOptions {
  /** Stream-specific reasons a connect should not be scheduled right now (already connected, no subscribers, ...). */
  readonly blocked: boolean;
  readonly connect: () => void;
  /** Explicit delay (e.g. the immediate `0` used for a first connect); omit to use the backoff formula. */
  readonly delayMs?: number;
  readonly random: () => number;
  readonly giveUp: SocketWatcherGiveUpOptions;
}

/**
 * Per-watcher reconnect/backoff/give-up state, plus the handshake and
 * keepalive timers every stream arms around a live socket. Fields are plain
 * mutable state (matching the rest of this codebase's watcher objects) so a
 * stream can read them directly, e.g. for its own extra timer bookkeeping.
 */
export class SocketWatcherReconnectState {
  reconnectAttempt = 0;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  givenUp = false;
  lastFailureReason = "none";

  constructor(private readonly config: SocketWatcherBackoffConfig) {}

  scheduleConnect(options: SocketWatcherScheduleConnectOptions): void {
    if (options.blocked || this.givenUp || this.reconnectTimer !== null) return;
    if (this.reconnectAttempt >= this.config.maxReconnectAttempts) {
      this.giveUp(options.giveUp);
      return;
    }
    const delay = options.delayMs
      ?? reconnectDelayMs(this.reconnectAttempt, options.random(), this.config);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      options.connect();
    }, delay);
  }

  /** Force a given-up watcher to rebuild its budget immediately (e.g. new evidence arrived that recovery is worth retrying). */
  forceRearm(): void {
    this.givenUp = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = clearTimer(this.reconnectTimer);
  }

  clearReconnectTimer(): void {
    this.reconnectTimer = clearTimer(this.reconnectTimer);
  }

  armHandshakeTimeout(timeoutMs: number, onTimeout: () => void): void {
    // Re-arming replaces any earlier timer, so a stale handshake can never
    // fire against a newer socket.
    this.clearHandshakeTimeout();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      onTimeout();
    }, timeoutMs);
  }

  clearHandshakeTimeout(): void {
    this.handshakeTimer = clearTimer(this.handshakeTimer);
  }

  /**
   * Arms a self-rescheduling keepalive ping. `tick` performs one round (stale
   * check, ping) and returns whether the timer should be rearmed; `blocked`
   * is re-checked on every (re)arm, matching each stream's own "is there
   * still a socket to ping" guard.
   */
  scheduleKeepalive(intervalMs: number, blocked: () => boolean, tick: () => boolean): void {
    if (this.keepaliveTimer !== null || blocked()) return;
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      if (tick()) this.scheduleKeepalive(intervalMs, blocked, tick);
    }, intervalMs);
  }

  clearKeepaliveTimer(): void {
    this.keepaliveTimer = clearTimer(this.keepaliveTimer);
  }

  /** Clears both socket-lifetime timers; the reconnect timer is intentionally untouched. */
  clearSocketTimers(): void {
    this.clearHandshakeTimeout();
    this.clearKeepaliveTimer();
  }

  private giveUp(options: SocketWatcherGiveUpOptions): void {
    if (this.givenUp) return;
    this.givenUp = true;
    options.onGiveUp(this.reconnectAttempt, this.lastFailureReason);
    const retryMs = this.config.giveUpRetryMs;
    if (retryMs === undefined || options.onRearm === undefined) return;
    const onRearm = options.onRearm;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (options.rearmBlocked?.() === true) return;
      this.givenUp = false;
      this.reconnectAttempt = 0;
      onRearm();
    }, retryMs);
  }
}
