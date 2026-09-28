/**
 * Runner-side lease handle (puzzle 03).
 *
 * Wraps a successfully-claimed `runner_leases` row and owns:
 *   - the heartbeat interval (renews `expires_at` every `ttlMs / 3`);
 *   - the release callback (DELETE on terminal/paused/exception);
 *   - the `onLeaseLost` notification when a renewal returns null
 *     (someone else stole the lease after expiry — runner should
 *     treat this as a forced terminal).
 *
 * Heartbeat ownership lives on the runner that successfully claimed,
 * not on the IPC request that initiated the claim. An IPC handler kicks
 * off the resume path and returns its discriminated outcome
 * immediately; the continuation runs fire-and-forget and the lease
 * handle survives until the continuation resolves / rejects / is
 * forced-terminated.
 *
 * `release()` is idempotent — repeated calls are safe (heartbeat
 * cleared once, DELETE matches the claim token so a stale call after
 * eviction is a no-op).
 *
 * The handle carries `claimToken` — the token THIS claim was issued
 * (migration 173). Renewal and release present it, never the owner id, so
 * two runners that share an owner id cannot renew or release each other's
 * claim.
 */

import {
  renewLease,
  releaseLease,
  type RunnerLease,
} from "../../db/repos/runner-leases.js";
import logger from "@utils/logger.js";

export interface LeaseHandle {
  readonly lease: RunnerLease;
  readonly ownerId: string;
  /** The token of this claim — the only credential renewal and release accept. */
  readonly claimToken: string;
  /** Idempotent. Safe to call multiple times. */
  release(): Promise<void>;
}

export interface CreateLeaseHandleOptions {
  readonly lease: RunnerLease;
  readonly ownerId: string;
  readonly ttlMs: number;
  /**
   * Fired when a heartbeat renewal returns null (lease stolen because
   * the previous owner missed too many heartbeats and `expires_at`
   * lapsed). Runner should treat this as forced pause / stop.
   */
  readonly onLeaseLost?: (reason: string) => void;
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

  function stopHeartbeat(): void {
    if (intervalHandle !== null) {
      timer.clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  async function heartbeatTick(): Promise<void> {
    if (released) return;
    try {
      const renewed = await renew(opts.lease.sessionId, opts.lease.claimToken, opts.ttlMs);
      if (renewed === null) {
        // Lease stolen — somebody else claimed after our expiry. Stop
        // the heartbeat and notify the runner; the runner is expected
        // to terminate its work promptly.
        released = true;
        stopHeartbeat();
        if (opts.onLeaseLost) {
          try {
            opts.onLeaseLost("lease_stolen_after_expiry");
          } catch (cbErr) {
            logger.warn("runner_lease.handle.on_lost_callback_threw", {
              sessionId: opts.lease.sessionId,
              error: cbErr instanceof Error ? cbErr.message : String(cbErr),
            });
          }
        }
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
    claimToken: opts.lease.claimToken,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      stopHeartbeat();
      try {
        await release(opts.lease.sessionId, opts.lease.claimToken);
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
