/**
 * Staged EVM transaction primitive (venue-agnostic) — sign locally and hand the
 * caller the computed hash BEFORE broadcasting, so a DB-backed caller can
 * persist `tx_hash`/`from`/`nonce` first, THEN the signed payload is sent to
 * the network and a bounded receipt is awaited.
 *
 * Owned by `evm-chains/` alongside the guards it composes
 * (`gas-limit-headroom`, `dependent-leg-gas-estimate`). Consumers are every EVM
 * venue: kyberswap, relay, pendle, uniswap (twin), and trench-express. The
 * historical `@tools/kyberswap/evm/staged-broadcast.js` path re-exports this
 * module for import stability.
 *
 * Generalizes `sendKyberTransactionWithReceipt`'s send+wait shape (`erc20.ts`)
 * into the pre-broadcast-durable contract Agent Scan's staged execute needs
 * (plan §11.1 step 2): "prepare and sign locally; compute the tx hash from
 * the signed payload; persist tx_hash/from/nonce — THEN broadcast." A crash
 * between sign and send leaves a discoverable pending `agent_activity` row
 * instead of a silently lost transaction.
 *
 * `ambiguous` covers BOTH a send-time failure (the RPC response never
 * confirms whether the raw transaction reached the mempool) and a
 * receipt-wait failure (not yet mined, or the wait itself could not complete
 * after a BOUNDED retry of that read — see `evm-chains/receipt-guard.ts`;
 * the send is NEVER repeated) — in BOTH cases the caller must NOT treat this
 * as a definitive failure: leave the durable row `pending` for the sweep, never
 * re-broadcast (ambiguity never terminalizes — plan §11.1 / FIX-SPINE C1).
 */

import type {
  Account,
  Address,
  Chain,
  Hex,
  PublicClient,
  TransactionReceipt,
  Transport,
  WalletClient,
} from "viem";
import { keccak256 } from "viem";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  waitForReceiptWithRetry,
  type ReceiptWaitRetryOptions,
} from "@tools/evm-chains/receipt-guard.js";
import {
  estimateGasForPlanLeg,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { describeFailureForLog } from "../../utils/error-summary.js";

export interface StagedTxParams {
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
}

/** Persisted BEFORE the signed payload is broadcast. */
export interface StagedSendHandles {
  readonly txHash: Hex;
  readonly fromAddress: Address;
  readonly nonce: number;
}

export type StagedBroadcastOutcome =
  | { readonly kind: "confirmed"; readonly txHash: Hex; readonly receipt: TransactionReceipt }
  | { readonly kind: "reverted"; readonly txHash: Hex; readonly receipt: TransactionReceipt }
  | {
      readonly kind: "ambiguous";
      readonly txHash: Hex;
      readonly stage: "send" | "confirm";
      /**
       * The sanitized reason the stage could not be resolved (SPEC §1.5).
       * Ambiguity is still ambiguity — this NEVER terminalizes the row — but
       * "the RPC rate-limited us" and "not mined yet" led to the same silent
       * `pending` before, and only one of them is worth retrying the READ for.
       */
      readonly reason: string;
    };

export interface StagedBroadcastHooks {
  /**
   * Called AFTER the transaction is signed and its hash computed, BEFORE it
   * is sent to the network. The caller persists the hash here
   * (`markActivityBroadcast`) — a throw from this hook aborts the broadcast
   * entirely (nothing has been sent yet).
   */
  readonly onHashStaged: (handles: StagedSendHandles) => Promise<void>;
  /**
   * Called once the RPC has accepted the raw-transaction submission
   * (`markBroadcastAccepted` bookkeeping). Best-effort — a throw here does
   * NOT roll back the broadcast (the transaction is already in flight).
   */
  readonly onAccepted: () => Promise<void>;
}

/**
 * Sign `txParams` locally with `walletClient`'s bound account, compute its
 * hash, invoke `hooks.onHashStaged`, THEN broadcast the signed payload and
 * wait for a bounded receipt.
 *
 * `priorLeg` is the receipt anchor of the leg this plan confirmed immediately
 * before (the ERC-20 approval, in practice). Supplying it lets the pre-sign
 * estimate survive an estimating node that has not yet applied that approval
 * (`dependent-leg-gas-estimate.ts`); omitting it keeps the single-shot
 * estimate. Either way a leg whose estimate never succeeds is still refused
 * before anything is signed.
 *
 * `walletClient` is typed `WalletClient<Transport, Chain, Account>` — an
 * ACCOUNT-BOUND client, required at the TYPE level. This is a compile-time
 * guarantee, not a runtime signal: an accountless client cannot reach the
 * signer at all, so there is no state in which this function has to decide what
 * to do about a missing account mid-flight. It replaces a `walletClient.account!`
 * non-null assertion that asserted the same invariant without proving it.
 */
export async function signStageBroadcast(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  txParams: StagedTxParams,
  hooks: StagedBroadcastHooks,
  priorLeg?: ConfirmedPriorLeg,
  receiptWaitRetry?: ReceiptWaitRetryOptions,
): Promise<StagedBroadcastOutcome> {
  const account = walletClient.account;
  const value = txParams.value ?? 0n;

  // Estimated explicitly rather than left to `prepareTransactionRequest`,
  // which signs viem's bare estimate with no headroom. Same call shape as the
  // signed transaction (`value` included, so a native-input swap is priced as
  // the call that actually runs), so a route that can no longer execute still
  // throws HERE — before anything is signed, staged, or broadcast.
  const gasEstimate = await estimateGasForPlanLeg(
    publicClient,
    { account, to: txParams.to, data: txParams.data, value },
    priorLeg,
  );

  const gasLimit = gasLimitWithHeadroom(gasEstimate);

  const request = await walletClient.prepareTransactionRequest({
    account,
    chain: walletClient.chain,
    to: txParams.to,
    data: txParams.data,
    value,
    gas: gasLimit,
  });
  // Re-asserted on the request that is actually serialized: when fees/nonce
  // still need filling, viem may route preparation through the node's
  // `wallet_fillTransaction`, whose reply overwrites `gas` with the node's own
  // unbuffered figure. The signed bytes are what the chain enforces, so the
  // headroom has to survive to exactly here.
  const serializedTransaction = await walletClient.signTransaction({ ...request, gas: gasLimit });
  const txHash = keccak256(serializedTransaction);
  const nonce = request.nonce;
  if (nonce === undefined) {
    throw new Error("signStageBroadcast: prepared transaction request has no nonce");
  }

  await hooks.onHashStaged({
    txHash,
    fromAddress: account.address,
    nonce,
  });

  try {
    await publicClient.sendRawTransaction({ serializedTransaction });
  } catch (err) {
    return { kind: "ambiguous", txHash, stage: "send", reason: describeFailureForLog(err) };
  }

  // Best-effort bookkeeping (per this function's contract) — a throw here
  // must NOT be mistaken for the broadcast itself failing: the transaction is
  // already in flight, so swallow (the caller already logs a miss) and keep
  // going to the receipt wait.
  try {
    await hooks.onAccepted();
  } catch {
    // Intentionally swallowed — see comment above.
  }

  // Bounded RETRY of the receipt READ before declaring ambiguity: a single
  // transient wait failure left an already-mined swap recorded `pending`.
  // The broadcast above is never re-sent — only this read repeats.
  try {
    const receipt = await waitForReceiptWithRetry(publicClient, txHash, receiptWaitRetry);
    return receipt.status === "success"
      ? { kind: "confirmed", txHash, receipt }
      : { kind: "reverted", txHash, receipt };
  } catch (err) {
    return { kind: "ambiguous", txHash, stage: "confirm", reason: describeFailureForLog(err) };
  }
}
