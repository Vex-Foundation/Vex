/** Heartbeating cross-process lease for one Lighter deposit wallet. */

import { randomUUID } from "node:crypto";

import * as leasesRepo from "@vex-agent/db/repos/lighter-evm-execution-leases.js";

const LEASE_TTL_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface LighterDepositExecutionLeaseHandle {
  /** Re-prove ownership and extend the lease before a privileged leg. */
  assertOwned(): Promise<void>;
  /** Idempotent owner-guarded release. */
  releaseExecutionLease(): Promise<void>;
}

export type AcquireLighterDepositExecutionLeaseResult =
  | { readonly acquired: true; readonly handle: LighterDepositExecutionLeaseHandle }
  | { readonly acquired: false; readonly retryAfter: Date | null };

export async function acquireLighterDepositExecutionLease(input: {
  readonly chainId: number;
  readonly walletAddress: string;
  readonly intentId: string;
}): Promise<AcquireLighterDepositExecutionLeaseResult> {
  const ownerId = `lighter-deposit:${randomUUID()}`;
  const acquired = await leasesRepo.acquireLighterEvmExecutionLease({
    ...input,
    ownerId,
    ttlMs: LEASE_TTL_MS,
  });
  if (acquired === null) {
    const current = await leasesRepo.getLighterEvmExecutionLease(
      input.chainId,
      input.walletAddress,
    ).catch(() => null);
    return { acquired: false, retryAfter: current?.expiresAt ?? null };
  }

  let closed = false;
  let lost = false;
  let renewalInFlight: Promise<boolean> | null = null;

  const renew = async (): Promise<boolean> => {
    if (closed || lost) return false;
    if (renewalInFlight !== null) return renewalInFlight;
    renewalInFlight = (async () => {
      try {
        const row = await leasesRepo.renewLighterEvmExecutionLease({
          chainId: input.chainId,
          walletAddress: input.walletAddress,
          ownerId,
          ttlMs: LEASE_TTL_MS,
        });
        if (row === null) lost = true;
        return row !== null;
      } catch {
        lost = true;
        return false;
      } finally {
        renewalInFlight = null;
      }
    })();
    return renewalInFlight;
  };

  const timer = setInterval(() => {
    void renew();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    acquired: true,
    handle: {
      async assertOwned(): Promise<void> {
        if (closed || lost || !(await renew())) {
          throw new Error(
            "Lighter EVM execution lease was lost; no further transaction may be signed or broadcast.",
          );
        }
      },
      async releaseExecutionLease(): Promise<void> {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        await leasesRepo.releaseLighterEvmExecutionLease({
          chainId: input.chainId,
          walletAddress: input.walletAddress,
          ownerId,
        });
      },
    },
  };
}
