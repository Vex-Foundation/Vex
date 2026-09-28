/**
 * Runner-side lease handle (puzzle 03).
 *
 * Wraps a successfully-claimed `runner_leases` row and owns:
 *   - the heartbeat interval (renews `expires_at` every `ttlMs / 3`);
 *   - the release callback (DELETE on terminal/paused/exception);
 *   - the lease-lost signal (`lostSignal`), fired when a renewal returns
 *     null, plus the optional `onLeaseLost` notification.
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
 *
 * ## The handle IS the runner's lease guard
 *
 * `LeaseHandle` extends `RunnerLeaseGuard` (`lease-guard.ts`), so every
 * runner that creates a handle has a lease-lost signal wired to its
 * heartbeat by construction — there is no opt-in callback a runner could
 * forget. The runner threads the handle into its turn loop as
 * `EngineContext.leaseGuard`; the loop fences its writes on `fence` and
 * treats `lostSignal` as the distinct `lease_lost` stop (never the Stop).
 */

import {
  getLease,
  renewLease,
  releaseLease,
  type RunnerLease,
} from "../../db/repos/runner-leases.js";
import logger from "@utils/logger.js";
import { withControlClient } from "../../db/control-pool.js";
import {
  createRunnerLeaseGuard,
  type LeaseLostReason,
  type RunnerLeaseGuard,
} from "./lease-guard.js";

export interface LeaseHandle extends RunnerLeaseGuard {
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
   * Extra notification when the claim is lost (the handle's own
   * `lostSignal` always fires). `lease_stolen_after_expiry` when another
   * claim now holds the row, `lease_released_externally` when the row is
   * gone, `lease_renewal_unconfirmed` when the follow-up read failed.
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
  /**
   * Override for tests: the read that tells a takeover (row present under
   * another token) from a release (row gone) after a failed renewal.
   */
  readonly probeFn?: typeof getLease;
}

const DEFAULT_TIMER = {
  setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
  clearInterval: (h: ReturnType<typeof setInterval>) => {
    clearInterval(h);
  },
};

const controlRenew: typeof renewLease = (sessionId, claimToken, ttlMs) =>
  withControlClient((client) => renewLease(sessionId, claimToken, ttlMs, client));
const controlRelease: typeof releaseLease = (sessionId, claimToken) =>
  withControlClient((client) => releaseLease(sessionId, claimToken, client));
const controlProbe: typeof getLease = (sessionId) =>
  withControlClient((client) => getLease(sessionId, client));

const LOST_CALLBACK_REASON: Readonly<Record<LeaseLostReason, string>> = {
  taken_over: "lease_stolen_after_expiry",
  released: "lease_released_externally",
  unconfirmed: "lease_renewal_unconfirmed",
};

export function createLeaseHandle(opts: CreateLeaseHandleOptions): LeaseHandle {
  const timer = opts.timer ?? DEFAULT_TIMER;
  // Renewal, release and the loss probe run on the reserved CONTROL pool
  // (`db/control-pool.ts`): a lease must stay renewable, and releasable, while
  // the main pool is saturated by the very work the lease protects.
  const renew = opts.renewFn ?? controlRenew;
  const release = opts.releaseFn ?? controlRelease;
  const probe = opts.probeFn ?? controlProbe;
  const heartbeatIntervalMs = Math.max(1_000, Math.floor(opts.ttlMs / 3));

  let released = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  const guard = createRunnerLeaseGuard({
    ownerId: opts.ownerId,
    fence: { sessionId: opts.lease.sessionId, claimToken: opts.lease.claimToken },
    tookOverExpiredClaim: opts.lease.tookOver === true,
    onLost: (reason) => {
      if (opts.onLeaseLost !== undefined) opts.onLeaseLost(LOST_CALLBACK_REASON[reason]);
    },
  });

  function stopHeartbeat(): void {
    if (intervalHandle !== null) {
      timer.clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  /** Why did our renewal match nothing? Row present ⇒ another claim holds it. */
  async function classifyLoss(): Promise<LeaseLostReason> {
    try {
      const current = await probe(opts.lease.sessionId);
      return current === null ? "released" : "taken_over";
    } catch {
      return "unconfirmed";
    }
  }

  async function heartbeatTick(): Promise<void> {
    if (released) return;
    try {
      const renewed = await renew(opts.lease.sessionId, opts.lease.claimToken, opts.ttlMs);
      if (renewed === null) {
        // Our token matches no row — another claim took the lease after our
        // expiry, or the row was deleted. Stop the heartbeat and fire the
        // lost signal; the runner starts no new work and ends the turn.
        released = true;
        stopHeartbeat();
        guard.markLost(await classifyLoss(), "heartbeat");
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
    fence: guard.fence,
    tookOverExpiredClaim: guard.tookOverExpiredClaim,
    lostSignal: guard.lostSignal,
    lostReason: () => guard.lostReason(),
    markLost: (reason, source) => {
      guard.markLost(reason, source);
    },
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
