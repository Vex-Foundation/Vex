/**
 * AgentScan seconds-level PUSH lane — the real-time complement to the 30 s
 * periodic reporting lane (`agentscan-report.ts`).
 *
 * ## Why direct invocation, not "wake the executor" or "enqueue a run"
 *
 * Enqueuing a sync run does not help: runs only drain on the periodic 30 s
 * tick, so a trigger routed through the queue would still wait out the exact
 * floor this lane exists to beat. Waking the whole sync executor is worse:
 * every job type due at that moment drains together, so one freshly-broadcast
 * swap would pull balance sync, position projection and every other periodic
 * job forward with it — blast radius far past what a single activity event
 * justifies. This module instead calls `runAgentscanIncremental` directly,
 * scoped to exactly the AgentScan outbox, the moment `pendingActivityBus`
 * says something changed.
 *
 * ## Latency contract
 *
 * Best-effort, seconds-level, not a guarantee. A trailing debounce (default
 * 2000 ms) collapses bursts of activity into one drain, and a single-flight
 * guard means a burst that lands mid-drain waits for the current run and then
 * fires exactly one follow-up — never a queue of them. The 30 s periodic lane
 * is UNCHANGED and stays the floor/sweep for every row this lane misses.
 *
 * ## Crash-lossiness is fine
 *
 * `pendingActivityBus` is in-process and ids-only (see its own header): a
 * trigger dropped by a crash between emit and debounce firing is simply lost,
 * and nothing here re-derives it. That is an accepted trade, not a gap — the
 * periodic lane's next tick runs the same diff scan regardless of whether
 * this lane ever fired, so a lost trigger costs at most one 30 s cycle of
 * latency, never a lost event.
 */

import { pendingActivityBus } from "../events/pending-activity-bus.js";
import { runAgentscanIncremental, buildProductionAgentscanReporterDeps } from "./agentscan-report.js";
import logger from "@utils/logger.js";

/** Trailing debounce window: collapses a burst of bus events into one drain. */
export const AGENTSCAN_PUSH_DEBOUNCE_MS = 2000;

export interface AgentscanPushDeps {
  readonly run: () => Promise<unknown>;
  readonly debounceMs?: number;
}

/**
 * Start the push lane: subscribe to `pendingActivityBus` and drive
 * `runAgentscanIncremental` on a trailing debounce. Returns a stop function
 * that unsubscribes, cancels anything pending, and guarantees no further run
 * — including one already in flight's dirty-triggered follow-up.
 */
export function startAgentscanPush(overrides: Partial<AgentscanPushDeps> = {}): () => void {
  const debounceMs = overrides.debounceMs ?? AGENTSCAN_PUSH_DEBOUNCE_MS;
  const run = overrides.run ?? (() => runAgentscanIncremental(buildProductionAgentscanReporterDeps()));

  let stopped = false;
  let running = false;
  let dirty = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const startRun = (): void => {
    running = true;
    // The bus's own listeners must stay synchronous (see its header) — async
    // work is dispatched here as `void run().catch(...)`, never awaited by
    // the caller, so a rejection can only ever reach this `.catch`.
    void run()
      .catch((err: unknown) => {
        logger.warn("sync.agentscan_push.run_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        running = false;
        if (stopped || !dirty) return;
        dirty = false;
        startRun();
      });
  };

  const scheduleDebounced = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      startRun();
    }, debounceMs);
    debounceTimer.unref?.();
  };

  const onBusEvent = (): void => {
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    scheduleDebounced();
  };

  const unsubscribe = pendingActivityBus.subscribe(onBusEvent);

  logger.info("sync.agentscan_push.started", { debounceMs });

  return (): void => {
    if (stopped) return;
    stopped = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    unsubscribe();
    logger.info("sync.agentscan_push.stopped");
  };
}
