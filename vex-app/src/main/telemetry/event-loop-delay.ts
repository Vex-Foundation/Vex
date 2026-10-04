/**
 * Event loop delay telemetry for the Electron main process (Kairos Phase 7,
 * K-5). MEASUREMENT ONLY: nothing reads these numbers to decide anything.
 *
 * WHY. The agent engine, every IPC handler and every wallet call share this
 * process's one event loop, so any synchronous stretch freezes every click
 * and window at once. Until now nothing measured how often that happens.
 *
 * HOW. Two cheap instruments, summarised once per window
 * ({@link EVENT_LOOP_WINDOW_MS}):
 *
 *   - `perf_hooks.monitorEventLoopDelay` (a native histogram sampled every
 *     {@link EVENT_LOOP_HISTOGRAM_RESOLUTION_MS}) gives p50 / p99 / max delay.
 *   - A tick timer every {@link EVENT_LOOP_STALL_TICK_MS} counts the ticks
 *     that fired at least {@link EVENT_LOOP_STALL_THRESHOLD_MS} late: one per
 *     freeze a user would notice. A histogram cannot count events above a
 *     value, which is why the counter exists.
 *
 * Each window is logged through the main logger (`warn` when it had a stall,
 * so packaged builds, whose file log keeps warn and above, keep it too) and
 * handed to `record`, which writes one row to `main_event_loop_samples`
 * (migration 175) for `pnpm kairos-runtime:report`. Every value is a number;
 * no session, path or message content is ever part of a window. When the
 * caller passes `takeKdfStats` (FLC-6), the log line also carries what the
 * scrypt KDF cost this thread in the window; the row is unchanged.
 *
 * Both timers are `unref`ed: telemetry never keeps the process alive.
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** K-5 switch. Default ON: measurement only, negligible cost. */
export const EVENT_LOOP_TELEMETRY_ENABLED = true;

/** Length of one summarised window. */
export const EVENT_LOOP_WINDOW_MS = 60_000;

/** Sampling resolution of the native delay histogram. */
export const EVENT_LOOP_HISTOGRAM_RESOLUTION_MS = 20;

/** Interval of the stall-counting tick. */
export const EVENT_LOOP_STALL_TICK_MS = 50;

/** A tick this late (ms) counts as a stall: a freeze a click would feel. */
export const EVENT_LOOP_STALL_THRESHOLD_MS = 100;

export interface EventLoopWindow {
  readonly windowMs: number;
  readonly sampleCount: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly stallCount: number;
  readonly stallThresholdMs: number;
  readonly longestStallMs: number;
}

/** The part of a Node `IntervalHistogram` this module reads. */
export interface DelayHistogram {
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  percentile(percentile: number): number;
  readonly max: number;
  readonly count: number;
}

export interface EventLoopTelemetryDeps {
  readonly now: () => number;
  readonly createHistogram: (resolutionMs: number) => DelayHistogram;
  /** Runs `fn` every `ms` without keeping the process alive; returns a cancel. */
  readonly every: (fn: () => void, ms: number) => () => void;
  readonly log: (level: "info" | "warn", line: string) => void;
  readonly record: (window: EventLoopWindow) => void;
}

const NS_PER_MS = 1_000_000;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function nsToMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? round2(value / NS_PER_MS) : 0;
}

/**
 * Tracks how late each stall tick fired. Pure: the caller supplies the
 * timestamps, so tests drive it without timers.
 */
export class StallCounter {
  private expectedAt: number;
  private count = 0;
  private longest = 0;

  constructor(
    startedAt: number,
    private readonly tickMs: number,
    private readonly thresholdMs: number,
  ) {
    this.expectedAt = startedAt + tickMs;
  }

  observeTick(now: number): void {
    const lateBy = now - this.expectedAt;
    if (lateBy >= this.thresholdMs) {
      this.count += 1;
      if (lateBy > this.longest) this.longest = lateBy;
    }
    this.expectedAt = now + this.tickMs;
  }

  /** Returns the window's stall numbers and starts a new window. */
  take(): { readonly stallCount: number; readonly longestStallMs: number } {
    const out = { stallCount: this.count, longestStallMs: round2(this.longest) };
    this.count = 0;
    this.longest = 0;
    return out;
  }
}

export function summariseWindow(
  histogram: DelayHistogram,
  stalls: { readonly stallCount: number; readonly longestStallMs: number },
  windowMs: number,
  stallThresholdMs: number,
): EventLoopWindow {
  const sampleCount = histogram.count;
  return {
    windowMs: Math.max(0, Math.round(windowMs)),
    sampleCount,
    p50Ms: sampleCount > 0 ? nsToMs(histogram.percentile(50)) : 0,
    p99Ms: sampleCount > 0 ? nsToMs(histogram.percentile(99)) : 0,
    maxMs: sampleCount > 0 ? nsToMs(histogram.max) : 0,
    stallCount: stalls.stallCount,
    stallThresholdMs,
    longestStallMs: stalls.longestStallMs,
  };
}

/**
 * FLC-6 attribution: what the scrypt KDF (vault opens, keystore decrypts) cost
 * this thread during the same window, from `takeScryptKdfStats` in
 * `src/utils/scrypt-async.ts`. Numbers only. Log line only: the
 * `main_event_loop_samples` row is unchanged.
 */
export interface EventLoopKdfStats {
  /** Derives started. */
  readonly derives: number;
  /** Derives a worker thread completed, so none of their KDF ran here. */
  readonly offMainDerives: number;
  /** Time this thread spent inside the calls that started them, in ms. */
  readonly callerBlockedMs: number;
}

/** The suffix appended to a window's line, e.g. ` kdf=6 kdfOffMain=6 kdfMainMs=0.14`. */
export function formatKdfStats(stats: EventLoopKdfStats): string {
  return ` kdf=${stats.derives} kdfOffMain=${stats.offMainDerives} kdfMainMs=${round2(stats.callerBlockedMs)}`;
}

export function formatWindow(window: EventLoopWindow): string {
  return (
    `[event-loop] window=${window.windowMs}ms samples=${window.sampleCount} ` +
    `p50=${window.p50Ms}ms p99=${window.p99Ms}ms max=${window.maxMs}ms ` +
    `stalls>=${window.stallThresholdMs}ms=${window.stallCount} longestStall=${window.longestStallMs}ms`
  );
}

function defaultDeps(
  log: EventLoopTelemetryDeps["log"],
  record: EventLoopTelemetryDeps["record"],
): EventLoopTelemetryDeps {
  return {
    now: () => performance.now(),
    createHistogram: (resolutionMs) => monitorEventLoopDelay({ resolution: resolutionMs }),
    every: (fn, ms) => {
      const handle = setInterval(fn, ms);
      handle.unref();
      return () => clearInterval(handle);
    },
    log,
    record,
  };
}

/**
 * Starts the instruments and returns an idempotent stop. With the switch off
 * (or `enabled: false`) nothing starts and the stop is a no-op.
 */
export function startEventLoopTelemetry(options: {
  readonly log: EventLoopTelemetryDeps["log"];
  readonly record: EventLoopTelemetryDeps["record"];
  readonly enabled?: boolean;
  readonly deps?: Partial<EventLoopTelemetryDeps>;
  /** FLC-6: read-and-reset KDF numbers, appended to each window's log line. */
  readonly takeKdfStats?: () => EventLoopKdfStats;
}): () => void {
  if (!(options.enabled ?? EVENT_LOOP_TELEMETRY_ENABLED)) return () => undefined;
  const deps: EventLoopTelemetryDeps = {
    ...defaultDeps(options.log, options.record),
    ...options.deps,
  };

  let histogram: DelayHistogram;
  try {
    histogram = deps.createHistogram(EVENT_LOOP_HISTOGRAM_RESOLUTION_MS);
    histogram.enable();
  } catch {
    deps.log("warn", "[event-loop] delay histogram unavailable; telemetry off");
    return () => undefined;
  }

  let windowStartedAt = deps.now();
  const stalls = new StallCounter(
    windowStartedAt,
    EVENT_LOOP_STALL_TICK_MS,
    EVENT_LOOP_STALL_THRESHOLD_MS,
  );

  const cancelTick = deps.every(() => {
    stalls.observeTick(deps.now());
  }, EVENT_LOOP_STALL_TICK_MS);

  const takeKdfStatsSafely = (): EventLoopKdfStats | null => {
    if (options.takeKdfStats === undefined) return null;
    try {
      return options.takeKdfStats();
    } catch {
      return null;
    }
  };

  const flush = (): void => {
    const now = deps.now();
    const window = summariseWindow(
      histogram,
      stalls.take(),
      now - windowStartedAt,
      EVENT_LOOP_STALL_THRESHOLD_MS,
    );
    windowStartedAt = now;
    histogram.reset();
    // Taken every window, logged or not, so a count never spills into the next.
    const kdf = takeKdfStatsSafely();
    if (window.sampleCount === 0 && window.stallCount === 0) return;
    try {
      deps.log(
        window.stallCount > 0 ? "warn" : "info",
        formatWindow(window) + (kdf === null ? "" : formatKdfStats(kdf)),
      );
      deps.record(window);
    } catch {
      // Telemetry must never surface as a main-process error.
    }
  };

  const cancelReport = deps.every(flush, EVENT_LOOP_WINDOW_MS);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancelTick();
    cancelReport();
    try {
      histogram.disable();
    } catch {
      // Already disabled.
    }
  };
}
