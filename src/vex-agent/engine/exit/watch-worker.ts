/**
 * Exit-watch worker — thin polling wrapper around the pure `runWatchCycle`.
 *
 * This module owns NO business logic and does NO direct I/O: every side effect
 * (loading open positions, pricing, alert emission, peak persistence) is
 * supplied by the caller as an injected dependency. The wrapper only sequences
 * them on a timer:
 *
 *   each tick →  getOpenPositions()
 *             →  runWatchCycle(positions, priceOf, now, config)   [pure]
 *             →  emitAlert(alert)              for each alert
 *             →  savePeak(token, updatedPeak)  for each alert
 *
 * `emitAlert` is where this subsystem's responsibility ENDS. It is a
 * notification seam, not an execution seam: the worker never places an order,
 * signs anything, or touches a wallet. A caller that wants an alert to become
 * a trade is expected to route it through the app's existing approval path,
 * exactly as any other user-authorised trade — this module deliberately opens
 * no second route.
 *
 * Loop discipline mirrors the engine's other workers (see
 * `engine/regime/regime-worker.ts`): a non-reentrant `setTimeout` chain rather
 * than an overlapping `setInterval`, an immediate first tick, and an
 * idempotent teardown that awaits an in-flight tick. A tick that throws is
 * swallowed and routed to the injected `onError`, so a single bad poll can
 * never kill the loop. Peak persistence is best-effort per token: one failed
 * `savePeak` does not skip the rest of the sweep.
 *
 * Not wired into app boot. Construction of the real dependencies — and the
 * decision to run this at all — is left to whoever owns the product story for
 * acting on an exit.
 */

import { runWatchCycle, type WatchAlert, type WatchInputPosition } from "./watch-cycle.js";
import { type ExitConfig } from "./exit-rules.js";

/** Default poll cadence — one exit sweep per 15s. */
export const EXIT_WATCH_POLL_MS = 15_000;

export interface ExitWatchWorkerDeps {
  /** Load the currently-open positions to evaluate this tick. */
  getOpenPositions: () => Promise<readonly WatchInputPosition[]>;
  /** Current USD price for a token (sync); any failure degrades to unavailable. */
  priceOf: (token: string) => number | null | undefined;
  /** Surface one exit alert. Notification only — never execution. */
  emitAlert: (alert: WatchAlert) => void | Promise<void>;
  /** Persist the refreshed high-water peak for the next cycle. */
  savePeak: (token: string, peakPriceUsd: number) => void | Promise<void>;
  /** Static exit configuration (ladder, stops, time-stop). */
  config: ExitConfig;
  /** Poll interval in ms. Defaults to EXIT_WATCH_POLL_MS. */
  pollMs?: number;
  /** Wall-clock source, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Optional error sink; a throwing tick is swallowed and reported here. */
  onError?: (err: unknown) => void;
}

/** Teardown handle — idempotent, awaits any in-flight tick. */
export type ExitWatchTeardown = () => Promise<void>;

/**
 * Run ONE watch tick against the injected deps. Exported so the sequencing
 * (load → cycle → emit → persist) can be asserted without timers. Errors from
 * `getOpenPositions` / `emitAlert` propagate to the caller;
 * `setupExitWatchWorker` is what turns them into `onError` calls.
 */
export async function runExitWatchTick(deps: ExitWatchWorkerDeps): Promise<WatchAlert[]> {
  const now = deps.now ?? Date.now;
  const positions = await deps.getOpenPositions();
  const alerts = runWatchCycle(positions, deps.priceOf, now(), deps.config);

  for (const alert of alerts) {
    await deps.emitAlert(alert);
    // Peak persistence is best-effort per token: never let one failure abort
    // the rest of the sweep. A dropped peak self-heals on the next tick.
    try {
      await deps.savePeak(alert.token, alert.updatedPeakPriceUsd);
    } catch (err: unknown) {
      deps.onError?.(err);
    }
  }

  return alerts;
}

/**
 * Start the exit-watch poll loop and return an idempotent teardown fn.
 *
 * Non-reentrant `setTimeout` chain (never overlapping): the next tick is armed
 * only after the current one settles, so a slow poll delays the next rather
 * than stacking. Ticks that throw are caught and routed to `onError` so the
 * loop survives transient failures. Teardown clears the timer and awaits any
 * in-flight tick.
 */
export function setupExitWatchWorker(deps: ExitWatchWorkerDeps): ExitWatchTeardown {
  const pollMs = deps.pollMs ?? EXIT_WATCH_POLL_MS;

  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    try {
      await runExitWatchTick(deps);
    } catch (err: unknown) {
      deps.onError?.(err);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    inFlight = tick().finally(() => {
      inFlight = null;
      if (!stopped) timer = setTimeout(schedule, pollMs);
    });
  };

  schedule();

  return async function teardown(): Promise<void> {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight) await inFlight;
  };
}
