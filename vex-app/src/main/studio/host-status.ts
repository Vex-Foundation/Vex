/**
 * The ONE renderer-visible view of the Vex Studio MCP host (stage B0).
 *
 * ## Why this module exists rather than a getter on the host
 *
 * `mcp-host.ts` owns the listener, the lifecycle epoch, the established
 * reservations and the lock flag. It is deliberately free of Electron: its
 * lock teardown runs synchronously inside `lockSecretSession`, and pulling
 * `BrowserWindow` into that path would put window enumeration between a scrub
 * and a dispatch-generation advance.
 *
 * So the host PUBLISHES facts here, this module owns the cache and the
 * coalescing, and `host-status-bridge.ts` - the only piece that touches
 * Electron - subscribes and broadcasts. That is the same split
 * `agent/mission-update-bridge.ts` uses for the mission bus, and it keeps one
 * source of truth behind both the pull channel and the push event: the handler
 * reads the value this module cached, so a pull can never disagree with the
 * last push.
 *
 * ## Coalescing
 *
 * Transitions are bursty - sixteen bridges reconnecting after an unlock is one
 * user action - and every one of them recomputes the same four fields. So an
 * identical consecutive payload is DROPPED rather than broadcast. This is a
 * coalescer, not a truncation: nothing is omitted, because a payload equal to
 * the one the renderer already holds carries no information. The cache is
 * always updated to the newest value regardless.
 *
 * ## Bounds
 *
 * The subscriber set is bounded by its callers: the bridge registers exactly
 * one listener for the life of the process, and returns an idempotent
 * unsubscribe that the app's `globalCleanup` owns. There is no queue and no
 * buffering - a status is a level, not an edge, so the newest value is the
 * only one worth having and a slow consumer cannot make this grow.
 */

import type { StudioHostStatus } from "@shared/schemas/studio.js";

/**
 * Before the host has done anything, the honest answer is "not serving,
 * because it has not started yet" - which is exactly `starting`. A renderer
 * that mounts during boot gets this rather than a null it would have to
 * special-case.
 */
const INITIAL_STATUS: StudioHostStatus = {
  state: "unavailable",
  cause: "starting",
  connectionCount: 0,
  maxConnections: 16,
  atCapacity: false,
};

let current: StudioHostStatus = INITIAL_STATUS;

type StudioHostStatusListener = (status: StudioHostStatus) => void;

const listeners = new Set<StudioHostStatusListener>();

/** The last published status. What `studio.hostStatus` returns; never null. */
export function getStudioHostStatus(): StudioHostStatus {
  return current;
}

/**
 * Record a transition and notify subscribers, unless the payload is identical
 * to the one already published.
 *
 * A listener that throws must not stop the remaining listeners or the caller:
 * this runs inside the host's synchronous lock teardown, where an exception
 * would abort the teardown between destroying sockets and advancing the
 * dispatch fence. Failures are contained per listener.
 */
export function publishStudioHostStatus(next: StudioHostStatus): void {
  if (isSameStatus(current, next)) return;
  current = next;
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch {
      // Contained on purpose - see the doc above. The bridge does its own
      // logging; a listener that cannot report is not the host's problem.
    }
  }
}

/** Subscribe to transitions. Returns an idempotent unsubscribe. */
export function onStudioHostStatus(
  listener: StudioHostStatusListener,
): () => void {
  listeners.add(listener);
  let removed = false;
  return (): void => {
    if (removed) return;
    removed = true;
    listeners.delete(listener);
  };
}

/**
 * Field-by-field equality. Written out rather than JSON-compared so that a
 * field added to the schema without a decision here is a COMPILE error, not a
 * silently uncoalesced (or silently swallowed) update.
 */
function isSameStatus(a: StudioHostStatus, b: StudioHostStatus): boolean {
  return (
    a.state === b.state
    && a.cause === b.cause
    && a.connectionCount === b.connectionCount
    && a.maxConnections === b.maxConnections
    && a.atCapacity === b.atCapacity
  );
}

/** Test seam: forget the cache and every subscriber between cases. */
export function resetStudioHostStatusForTests(): void {
  current = INITIAL_STATUS;
  listeners.clear();
}
