/**
 * Runner-side lease handle (puzzle 03).
 *
 * Wraps a successfully-claimed `runner_leases` row and owns:
 *   - the heartbeat interval (renews `expires_at` every `ttlMs / 3`);
 *   - the release callback (DELETE on terminal/paused/exception);
 *   - an abort signal that fires when a renewal returns null (someone else
 *     stole the lease after expiry). Every runner threads this signal to its
 *     dispatch boundary so stale owners cannot start more work.
 *
 * Heartbeat ownership lives on the runner that successfully claimed,
 * not on the IPC request that initiated the claim. An IPC handler kicks
 * off the resume path and returns its discriminated outcome
 * immediately; the continuation runs fire-and-forget and the lease
 * handle survives until the continuation resolves / rejects / is
 * forced-terminated.
 *
 * `release()` is idempotent — repeated calls are safe (heartbeat
 * cleared once, DELETE matches the owner_id so a stale call after
 * eviction is a no-op).
 */

import {
  renewLease,
  releaseLease,
  type RunnerLease,
} from "../../db/repos/runner-leases.js";
import logger from "@utils/logger.js";
import { RunnerLeaseLostError } from "./lease-loss.js";
export {
  RunnerLeaseLostError,
  getRunnerLeaseLostError,
  isRunnerLeaseLostError,
  throwIfRunnerLeaseLost,
} from "./lease-loss.js";

export interface LeaseHandle {
  readonly lease: RunnerLease;
  readonly ownerId: string;
  /** Aborted exactly once when heartbeat renewal proves ownership was lost. */
  readonly signal: AbortSignal;
  /** Idempotent. Safe to call multiple times. */
  release(): Promise<void>;
}

export interface CreateLeaseHandleOptions {
  readonly lease: RunnerLease;
  readonly ownerId: string;
  readonly ttlMs: number;
  /**
   * Override for tests — defaults to `globalThis.setInterval` /
   * `clearInterval`. The injectable timer makes vitest fake-timer tests
   * deterministic without monkey-patching globals.
   */
  readonly timer?: {
    setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  };
  /** Override for tests so renewal can be mocked. */
  readonly renewFn?: typeof renewLease;
  /** Override for tests so release can be mocked. */
  readonly releaseFn?: typeof releaseLease;
}

const DEFAULT_TIMER = {
  setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
  clearInterval: (h: ReturnType<typeof setInterval>) => {
    clearInterval(h);
  },
};

export function createLeaseHandle(opts: CreateLeaseHandleOptions): LeaseHandle {
  const timer = opts.timer ?? DEFAULT_TIMER;
  const renew = opts.renewFn ?? renewLease;
  const release = opts.releaseFn ?? releaseLease;
  const heartbeatIntervalMs = Math.max(1_000, Math.floor(opts.ttlMs / 3));

  let released = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  const leaseLostController = new AbortController();

  function stopHeartbeat(): void {
    if (intervalHandle !== null) {
      timer.clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  async function heartbeatTick(): Promise<void> {
    if (released) return;
    try {
      const renewed = await renew(opts.lease.sessionId, opts.ownerId, opts.ttlMs);
      if (renewed === null) {
        // Lease stolen — somebody else claimed after our expiry. Stop the
        // heartbeat and synchronously revoke this runner at its next guarded
        // dispatch/persistence boundary.
        released = true;
        stopHeartbeat();
        leaseLostController.abort(new RunnerLeaseLostError(opts.lease.sessionId));
      }
    } catch (err) {
      // Transient DB issue — log + keep the interval armed. If renewal
      // never recovers, `expires_at` will lapse, the next runner will
      // claim, and our next renewal will hit the `null` branch above.
      logger.warn("runner_lease.handle.heartbeat_failed", {
        sessionId: opts.lease.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  intervalHandle = timer.setInterval(() => {
    void heartbeatTick();
  }, heartbeatIntervalMs);

  return {
    lease: opts.lease,
    ownerId: opts.ownerId,
    signal: leaseLostController.signal,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      stopHeartbeat();
      try {
        await release(opts.lease.sessionId, opts.ownerId);
      } catch (err) {
        // Swallow — releasing on top of an already-stolen lease is
        // best-effort. The next claimant won't be blocked by our row.
        logger.warn("runner_lease.handle.release_failed", {
          sessionId: opts.lease.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
