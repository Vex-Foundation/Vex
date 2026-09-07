/**
 * Versioned/legacy transaction send helpers for the Jupiter shelves.
 */

import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { VexError, ErrorCodes } from "../../../../errors.js";
import { solanaExplorerUrl } from "../solana-validation.js";
import { DEFAULT_CONFIRM_TIMEOUT_MS, DEFAULT_SEND_RETRIES } from "./constants.js";
import { confirmVersionedTx } from "./confirm.js";
import { createSolanaConnection } from "./connection.js";
import { signAndSubmitVersionedTxStaged } from "./staged.js";

export async function sendSignedVersionedTx(
  connection: Connection,
  tx: VersionedTransaction,
  options: {
    skipPreflight?: boolean;
    sendMaxRetries?: number;
    confirmTimeoutMs?: number;
  } = {},
): Promise<string> {
  const {
    skipPreflight = false,
    sendMaxRetries = DEFAULT_SEND_RETRIES,
    confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
  } = options;

  let signature: string;

  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight,
      maxRetries: sendMaxRetries,
    });
  } catch (err) {
    const error = new VexError(
      ErrorCodes.SOLANA_TX_FAILED,
      `Failed to send transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
    error.retryable = true;
    throw error;
  }

  await confirmVersionedTx(connection, signature, confirmTimeoutMs);
  return signature;
}

/**
 * Idempotency-safe versioned send that preserves the original
 * `Promise<string>` contract for callers that expect a confirmed signature.
 *
 * Delegates to `signAndSubmitVersionedTxStaged`, so `sendRawTransaction` runs
 * AT MOST ONCE per call path that reaches broadcast. Post-broadcast outcomes
 * are mapped to the legacy throw contract WITHOUT resending:
 *
 *   - `confirmed`            -> returns the signature.
 *   - `chain_failed`         -> throws `SOLANA_TX_FAILED` (non-retryable;
 *                               the chain rejected it, a resend would not be
 *                               idempotent).
 *   - `confirmation_unknown` -> throws `SOLANA_TX_TIMEOUT` (non-retryable),
 *                               with the signature in the hint so callers can
 *                               inspect on-chain state instead of resending.
 *
 * The thrown errors carry `retryable = false` so no upstream retry loop can
 * turn an unknown post-broadcast state into a duplicate broadcast.
 */
export async function signAndSendVersionedTx(
  txInput: Uint8Array | string,
  signers: Keypair[],
  options: {
    connection?: Connection;
    skipPreflight?: boolean;
    sendMaxRetries?: number;
    confirmTimeoutMs?: number;
    networkRetries?: number;
  } = {},
): Promise<string> {
  const submission = await signAndSubmitVersionedTxStaged(txInput, signers, options);

  if (submission.phase === "confirmed") {
    return submission.signature;
  }

  if (submission.phase === "chain_failed") {
    const error = new VexError(
      ErrorCodes.SOLANA_TX_FAILED,
      `Transaction failed after broadcast (${submission.errorKind ?? "unknown"})`,
      `Signature: ${submission.signature}\nExplorer: ${solanaExplorerUrl(submission.signature)}`,
    );
    error.retryable = false;
    throw error;
  }

  // confirmation_unknown: broadcast happened, confirmation did not resolve.
  // Surface the on-chain trace; do NOT resend.
  const error = new VexError(
    ErrorCodes.SOLANA_TX_TIMEOUT,
    `Transaction broadcast but confirmation is unknown (${submission.errorKind ?? "unknown"})`,
    `Signature: ${submission.signature}\nExplorer: ${solanaExplorerUrl(submission.signature)}`,
  );
  error.retryable = false;
  throw error;
}

// ── Legacy transaction helper ───────────────────────────────────

export async function signAndSendLegacyTx(
  transaction: Transaction,
  keypair: Keypair,
  opts?: { connection?: Connection },
): Promise<string> {
  // `role: "broadcast"` when the caller did not inject one: this function
  // signs and sends, and the endpoint that accepts a signature must be the one
  // this repository has broadcast evidence for, not the faster read endpoint.
  const connection = opts?.connection ?? createSolanaConnection({ role: "broadcast" });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = keypair.publicKey;
  transaction.sign(keypair);

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });

  await confirmVersionedTx(connection, signature);
  return signature;
}
