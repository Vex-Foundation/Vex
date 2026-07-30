/**
 * Receipt confirmation guard for state-changing EVM operations.
 *
 * viem resolves `waitForTransactionReceipt` for a mined revert. Callers must
 * therefore distinguish a confirmed revert from a post-broadcast confirmation
 * failure, where the transaction may still settle and must never be retried
 * automatically.
 *
 * The WAIT ITSELF is retried, bounded (`waitForReceiptWithRetry`). A single
 * transient RPC failure used to be enough to declare an already-mined swap
 * ambiguous and leave its `agent_activity` row pending. Only the READ is
 * repeated — the broadcast is never re-sent from here or from any caller
 * (rule 90: a re-send can double-spend). A wait that RESOLVES is a definitive
 * answer, revert included, and is never retried.
 */

import type { Hex, PublicClient, TransactionReceipt } from "viem";

import { ErrorCodes, VexError } from "../../errors.js";

export type ReceiptWaitClient = Pick<PublicClient, "waitForTransactionReceipt">;

/**
 * Total attempts at the receipt wait, the first included. Small on purpose:
 * `waitForTransactionReceipt` already polls internally until it is mined, so
 * a throw here means the RPC connection failed rather than "not yet mined",
 * and two extra chances are enough to survive a hiccup without holding a
 * money-path call open indefinitely.
 */
export const RECEIPT_WAIT_ATTEMPTS = 3;

/** Backoff between attempts (doubled each time): 1.5s then 3s — ~4.5s of added wall clock at worst. */
export const RECEIPT_WAIT_BASE_DELAY_MS = 1_500;

export interface ReceiptWaitRetryOptions {
  /** Base backoff override — tests pass 0. Attempt N waits `delayMs * 2^(N-1)`. */
  readonly delayMs?: number;
}

/**
 * `client.waitForTransactionReceipt`, retried a bounded number of times when
 * the wait THROWS. Rethrows the last error once the bound is exhausted, so
 * every caller's existing "could not be determined" handling is unchanged —
 * it just becomes much rarer.
 */
export async function waitForReceiptWithRetry(
  client: ReceiptWaitClient,
  hash: Hex,
  options?: ReceiptWaitRetryOptions,
): Promise<TransactionReceipt> {
  const baseDelayMs = options?.delayMs ?? RECEIPT_WAIT_BASE_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= RECEIPT_WAIT_ATTEMPTS; attempt++) {
    try {
      return await client.waitForTransactionReceipt({ hash });
    } catch (err) {
      lastError = err;
      if (attempt < RECEIPT_WAIT_ATTEMPTS) {
        await delay(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ReceiptFailureContext {
  readonly code: string;
  readonly what: string;
  readonly hint?: string;
}

/** Wait for a successful receipt, preserving the receipt for callers that need logs. */
export async function waitForSuccessfulReceipt(
  client: ReceiptWaitClient,
  hash: Hex,
  context: ReceiptFailureContext,
  retry?: ReceiptWaitRetryOptions,
): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await waitForReceiptWithRetry(client, hash, retry);
  } catch {
    throw new VexError(
      ErrorCodes.CONFIRMATION_UNKNOWN,
      `Transaction ${hash} was broadcast but its confirmation could not be determined. It may still confirm on-chain.`,
      "Do not retry automatically. Check the transaction hash on-chain before taking any further action.",
    );
  }

  if (receipt.status !== "success") {
    throw new VexError(
      context.code,
      `${context.what} ${hash} reverted on-chain (status: ${receipt.status}).`,
      context.hint,
    );
  }

  return receipt;
}
