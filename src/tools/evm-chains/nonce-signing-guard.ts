import { validateNonceReservationScope } from "./nonce-reservation-scope.js";
import type { Address } from "viem";

/** No signature exists. A stale local nonce must never become a queued gap. */
export class EvmNonceMismatchError extends Error {
  readonly failureCode = "broadcast_error";
  readonly retryable = true;
  readonly status = "not_attempted";
  readonly reason: "local_nonce_ledger_ahead" | "local_nonce_ledger_behind";
  constructor(readonly chainId: number, reserved: number, pending: number) {
    const ahead = reserved > pending;
    super(`Refused before signing on chain ${chainId}: the local nonce ledger is ${ahead ? "ahead of" : "behind"} the network `
      + `(reserved ${reserved}, pending ${pending}). No transaction was signed or broadcast for this step. `
      + "Wait for nonce reconciliation, then request a fresh quote. Do not resend an existing staged transaction.");
    this.name = "EvmNonceMismatchError";
    this.reason = ahead ? "local_nonce_ledger_ahead" : "local_nonce_ledger_behind";
  }
}

export async function assertReservedNonceMatchesPending(
  client: { getTransactionCount: (input: { address: Address; blockTag: "pending" }) => Promise<number> },
  address: Address, chainId: number, reserved: number,
): Promise<void> {
  await validateNonceReservationScope();
  const pending = await client.getTransactionCount({ address, blockTag: "pending" });
  if (!Number.isSafeInteger(pending) || pending < 0) throw new Error("The pending nonce could not be read before signing");
  if (pending !== reserved) throw new EvmNonceMismatchError(chainId, reserved, pending);
}
