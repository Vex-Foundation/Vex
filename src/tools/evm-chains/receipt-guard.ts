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

import type {
  Hex,
  PublicClient,
  ReplacementReason,
  ReplacementReturnType,
  TransactionReceipt,
} from "viem";

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
  /** Total wait calls, including the first. Defaults to the shared bounded limit. */
  readonly attempts?: number;
  /** Optional viem polling timeout for each wait call. */
  readonly timeoutMs?: number;
}

export interface ReceiptReplacementEvidence {
  readonly reason: ReplacementReason;
  readonly replacedTxHash: Hex;
  readonly replacementTxHash: Hex;
  readonly fromAddress: Hex;
  readonly nonce: number;
  readonly to: Hex | null;
  readonly data: Hex;
  readonly value: bigint;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint | null;
  readonly maxPriorityFeePerGas: bigint | null;
}

export interface ReceiptWithReplacementEvidence {
  readonly receipt: TransactionReceipt;
  readonly replacement: ReceiptReplacementEvidence | null;
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
  return (await waitForReceiptWithReplacementEvidence(client, hash, options)).receipt;
}

/** Same bounded receipt read, preserving any provider-proven replacement. */
export async function waitForReceiptWithReplacementEvidence(
  client: ReceiptWaitClient,
  hash: Hex,
  options?: ReceiptWaitRetryOptions,
): Promise<ReceiptWithReplacementEvidence> {
  const baseDelayMs = options?.delayMs ?? RECEIPT_WAIT_BASE_DELAY_MS;
  const attempts = options?.attempts ?? RECEIPT_WAIT_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > RECEIPT_WAIT_ATTEMPTS) {
    throw new Error(`Receipt wait attempts must be between 1 and ${RECEIPT_WAIT_ATTEMPTS}.`);
  }
  if (
    options?.timeoutMs !== undefined
    && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    throw new Error("Receipt wait timeout must be a positive integer.");
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let replacement: ReceiptReplacementEvidence | null = null;
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash,
        ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        onReplaced: (value) => {
          replacement = projectReplacement(value);
        },
      });
      return { receipt, replacement };
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await delay(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

function projectReplacement(value: ReplacementReturnType): ReceiptReplacementEvidence {
  return {
    reason: value.reason,
    replacedTxHash: value.replacedTransaction.hash,
    replacementTxHash: value.transaction.hash,
    fromAddress: value.transaction.from,
    nonce: value.transaction.nonce,
    to: value.transaction.to,
    data: value.transaction.input,
    value: value.transaction.value,
    gas: value.transaction.gas,
    maxFeePerGas: value.transaction.maxFeePerGas ?? null,
    maxPriorityFeePerGas: value.transaction.maxPriorityFeePerGas ?? null,
  };
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
  } catch (err) {
    const unknownConfirmation = new VexError(
      ErrorCodes.CONFIRMATION_UNKNOWN,
      `Transaction ${hash} was broadcast but its confirmation could not be determined. It may still confirm on-chain.`,
      "Do not retry automatically. Check the transaction hash on-chain before taking any further action.",
    );
    // The cause is KEPT (SPEC §1.5). This fires on an ALREADY-BROADCAST
    // transaction, where "why could we not read the receipt" is the whole
    // question — an RPC 429 and a genuine non-inclusion are the same sentence
    // without it. `summarizeProtocolError` walks the chain and scrubs it.
    unknownConfirmation.cause = err;
    throw unknownConfirmation;
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
