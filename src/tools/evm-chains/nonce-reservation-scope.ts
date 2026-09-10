/** Cleanup follows the signing attempt, including every pre-sign refusal. */
import { AsyncLocalStorage } from "node:async_hooks";
import logger from "@utils/logger.js";

interface ScopedReservation { release: () => Promise<void>; validate?: (() => Promise<void>) | undefined }
const cleanupScope = new AsyncLocalStorage<ScopedReservation[]>();

export class EvmNonceReservationExpiredError extends Error {
  readonly failureCode = "broadcast_error";
  readonly retryable = true;
  readonly status = "not_attempted";
  constructor() {
    super("Refused before signing: the nonce signing lease expired or was released. Nothing was signed or broadcast for this step. Request a new intent after nonce reconciliation.");
    this.name = "EvmNonceReservationExpiredError";
  }
}
export async function validateNonceReservationScope(): Promise<void> {
  for (const reservation of cleanupScope.getStore() ?? []) await reservation.validate?.();
}

/** The durable allocator registers a hashless-only, token-fenced release. */
export function onNonceReservationScopeExit(release: () => Promise<void>, validate?: () => Promise<void>): void {
  cleanupScope.getStore()?.push({ release, validate });
}

export async function withNonceReservationScope<T>(run: () => Promise<T>): Promise<T> {
  const releases: ScopedReservation[] = [];
  return cleanupScope.run(releases, async () => {
    try { return await run(); }
    finally {
      for (const reservation of releases.reverse()) {
        try { await reservation.release(); }
        catch { logger.warn("evm.nonce.reservation_release_failed", { recovery: "bounded_signing_lease" }); }
      }
    }
  });
}
