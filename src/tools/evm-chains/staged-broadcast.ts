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
import { parseAccount } from "viem/accounts";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  acquireEvmNonceOwner,
  type EvmNonceOwnerLease,
} from "@tools/evm-chains/nonce-owner.js";
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

/**
 * The transaction AS IT WILL BE SERIALIZED, handed to the pre-sign gate.
 *
 * WHY THE GATE TAKES IT. A gate that re-checks the caller's own earlier values
 * proves something about a closure, not about the bytes:
 * `prepareTransactionRequest` returns the request that is actually signed, and
 * viem may fill or route it through the node, so `to`, `data` and `value` on the
 * way out are not the caller's inputs by definition. The gate is therefore given
 * exactly the object the signature is taken over, and a caller whose invariant is
 * about the transaction can assert it against the transaction.
 *
 * Every field is the value passed to the signer; nothing here is re-derived.
 */
export interface FinalSignedRequest {
  readonly to: Address | null | undefined;
  readonly data: Hex | undefined;
  readonly value: bigint;
  readonly gas: bigint;
  readonly nonce: number;
  /**
   * THE ACTUAL PRICE FIELDS OF THE REQUEST BEING SIGNED, exactly as they stand
   * on it - never re-derived, never defaulted.
   *
   * WHY A GATE NEEDS THEM. A pre-sign check that asks "can this wallet pay for
   * everything still to come" cannot answer without the price this very
   * transaction commits to: `gas` is a COUNT, and a count times an unknown
   * price is not money. Before these fields the only prices a gate could see
   * were the ones it had asked for, which is precisely the class of mistake
   * `FinalSignedRequest` exists to end - viem fills the fee fields when the
   * caller supplies no ceiling, so the request's prices are frequently not the
   * caller's.
   *
   * EXACTLY ONE PRICING MODE IS POPULATED, because a transaction has exactly
   * one: an EIP-1559 request carries `maxFeePerGas` and `maxPriorityFeePerGas`
   * with `gasPrice` undefined, and a legacy request the reverse. A consumer
   * computing a debit uses `maxFeePerGas` ALONE on the 1559 arm - the priority
   * fee is paid out of that ceiling, not beside it, and adding the two is a
   * double count (`./swap-native-debit.ts` owns that arithmetic).
   *
   * `undefined` is a real state and is not a zero: it means the request is not
   * priced that way. A gate that needs a price and finds none must refuse.
   */
  readonly gasPrice: bigint | undefined;
  readonly maxFeePerGas: bigint | undefined;
  readonly maxPriorityFeePerGas: bigint | undefined;
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

/**
 * The APPROVED fee ceiling for this transaction, enforced on the request that is
 * actually serialized.
 *
 * WHY IT IS A PARAMETER AND NOT AN ASSUMPTION. Without it,
 * `prepareTransactionRequest` fills whatever fees the node suggests, and the
 * signed bytes commit the user to them. On a venue path that is tolerable
 * because the user authorized a trade, not a gas price; on the generic signing
 * path the fee caps ARE part of what the user approved, so a request whose
 * fields exceed them must never be signed. Omitting it keeps every existing
 * caller's behaviour byte for byte.
 *
 * Every value is a `bigint` in base units: gas UNITS for `gasLimit`, wei for
 * the prices. No floating point reaches this type.
 */
export type StagedFeeBounds =
  | {
      readonly mode: "eip1559";
      readonly gasLimit: bigint;
      readonly maxFeePerGasWei: bigint;
      readonly maxPriorityFeePerGasWei: bigint;
    }
  | {
      readonly mode: "legacy";
      readonly gasLimit: bigint;
      readonly gasPriceWei: bigint;
    };

/**
 * A prepared request exceeded the approved ceiling, so NOTHING was signed.
 *
 * Its own error type because the caller's answer is specific: this is not an
 * RPC failure and not a revert, it is a refusal, and the transaction may be
 * prepared again under caps the user chooses. `field` names which cap was
 * exceeded, and both values travel as decimal strings.
 */
export class StagedFeeBoundsExceededError extends Error {
  readonly field: string;
  readonly actual: string;
  readonly approved: string;

  constructor(field: string, actual: bigint, approved: bigint) {
    super(
      `Refusing to sign: the prepared transaction's ${field} is ${actual.toString()}, above the `
      + `approved ceiling of ${approved.toString()}. Nothing was signed and nothing was broadcast.`,
    );
    this.name = "StagedFeeBoundsExceededError";
    this.field = field;
    this.actual = actual.toString();
    this.approved = approved.toString();
  }
}

/**
 * Refuse any prepared field above its ceiling. Called on the request that is
 * about to be serialized, so what is checked is what would be signed.
 *
 * A field the request does not carry is not a hole: viem fills exactly one
 * pricing mode, and the mode the caller authorized is the mode it asked for. An
 * absent field means the node priced the transaction the other way, which is a
 * mismatch the caps cannot cover, so it refuses too.
 */
function assertWithinFeeBounds(
  request: { gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint },
  bounds: StagedFeeBounds,
): void {
  const gas = request.gas;
  if (gas === undefined || gas > bounds.gasLimit) {
    throw new StagedFeeBoundsExceededError("gas limit", gas ?? 0n, bounds.gasLimit);
  }
  if (bounds.mode === "eip1559") {
    const maxFee = request.maxFeePerGas;
    const priority = request.maxPriorityFeePerGas;
    if (maxFee === undefined || maxFee > bounds.maxFeePerGasWei) {
      throw new StagedFeeBoundsExceededError("maxFeePerGas", maxFee ?? 0n, bounds.maxFeePerGasWei);
    }
    if (priority === undefined || priority > bounds.maxPriorityFeePerGasWei) {
      throw new StagedFeeBoundsExceededError(
        "maxPriorityFeePerGas",
        priority ?? 0n,
        bounds.maxPriorityFeePerGasWei,
      );
    }
    return;
  }
  const gasPrice = request.gasPrice;
  if (gasPrice === undefined || gasPrice > bounds.gasPriceWei) {
    throw new StagedFeeBoundsExceededError("gasPrice", gasPrice ?? 0n, bounds.gasPriceWei);
  }
}

/**
 * THE DEFERRED SIGNER ARM - key material is resolved only after every awaited
 * preparation call has finished and the caller's own pre-sign gate has passed.
 *
 * WHY IT EXISTS. The eager arm takes a key-bearing `walletClient`, so the key is
 * materialized before the gas estimate, before the request preparation and
 * before the fee-bound check - a window of several network round trips in which
 * a revocation cannot stop the signature that follows. The generic signing path
 * has an authority that the user can change mid-flight (a project wallet-scope
 * edit, or locking Vex), so it needs the key to appear as late as the design
 * allows.
 *
 * THE ORDER IS THE CONTRACT, and it is what the tests assert:
 *
 *   0. THE NONCE OWNER for `(address, chain.id)` is taken FIRST, before the
 *      nonce is filled, and held through step 5 and the submit
 *      (`./nonce-owner.ts`, which also documents the lock order against the
 *      session control lock the fence takes inside this hold).
 *   1. KEYLESS PREPARATION. `address` + `chain` are the preparation identity -
 *      enough for `eth_estimateGas`, for `prepareTransactionRequest` (nonce and
 *      fees) and for the fee-bound refusal, and never enough to sign.
 *   2. `onBeforeSign` runs EXACTLY ONCE, after every awaited preparation
 *      operation and before any key is loaded. A throw from it signs, stages and
 *      submits NOTHING.
 *   3. `createSigner` resolves and decrypts the CURRENTLY authorized wallet.
 *   4. The resulting signer's account and chain must EXACTLY match the prepared
 *      request; a mismatch throws before signing.
 *   5. NO PROVIDER CALL AT ALL happens between `onBeforeSign` and the
 *      cryptographic signature - not one, and this is enforced rather than
 *      asserted by reading the code.
 *
 *      viem's `signTransaction` WALLET ACTION is not usable here for exactly
 *      that reason: it unconditionally awaits `eth_chainId` before it reaches
 *      the local account's signer (`viem/actions/wallet/signTransaction.js`),
 *      which is a provider round trip sitting between the authority fence and
 *      the signature - the window this whole arm exists to close, reopened by
 *      the library. So the deferred arm signs OFFLINE: it calls the local
 *      account's OWN `signTransaction` with the chain's own transaction
 *      serializer, exactly as the action's local-account branch does, and takes
 *      the chain id from PREPARATION instead of re-reading it. The eager arm
 *      still goes through the action and is byte-identical to before.
 */
export interface DeferredEvmSigner {
  readonly kind: "deferred";
  /** The keyless preparation identity: the address the transaction is prepared for. */
  readonly address: Address;
  /** The chain the request is prepared and signed for. */
  readonly chain: Chain;
  /**
   * The caller's pre-sign gate. Runs EXACTLY ONCE, after all preparation and
   * before `createSigner`. Throwing aborts with nothing signed.
   */
  readonly onBeforeSign: (request: FinalSignedRequest) => Promise<void>;
  /** Resolve and decrypt the currently authorized wallet. Throwing aborts. */
  readonly createSigner: () => Promise<WalletClient<Transport, Chain, Account>>;
}

/**
 * Who signs. The EAGER arm is the account-bound `WalletClient` every existing
 * venue passes and its behaviour is unchanged in every respect; the DEFERRED arm
 * is used only by the generic wallet-transaction confirm.
 */
export type StagedSigner = WalletClient<Transport, Chain, Account> | DeferredEvmSigner;

function isDeferred(signer: StagedSigner): signer is DeferredEvmSigner {
  // viem clients carry `type`/`key`/`uid`, never `kind`, so this discriminates
  // structurally without a cast and without touching the eager path.
  return "kind" in signer && signer.kind === "deferred";
}

/** A deferred signer resolved to a wallet that is not the one the request was prepared for. */
export class DeferredSignerIdentityError extends Error {
  constructor(field: "account" | "chain") {
    super(
      `Refusing to sign: the wallet resolved for signing does not match the ${field} the `
      + "transaction was prepared for. Nothing was signed and nothing was broadcast.",
    );
    this.name = "DeferredSignerIdentityError";
  }
}

/**
 * The deferred arm resolved an account that cannot sign locally.
 *
 * Only a LOCAL account can produce the signature without asking a provider, and
 * the whole point of this arm is that no provider is asked after the fence. A
 * remote or JSON-RPC account would have to be signed through the node, which is
 * the window this arm exists to close - so it is refused rather than silently
 * downgraded to the action that reopens it.
 */
export class DeferredOfflineSignerUnavailableError extends Error {
  constructor() {
    super(
      "Refusing to sign: this transaction must be signed locally, and the wallet resolved for "
      + "signing cannot produce a signature without contacting the network. Nothing was signed and "
      + "nothing was broadcast.",
    );
    this.name = "DeferredOfflineSignerUnavailableError";
  }
}

export interface StagedBroadcastHooks {
  /**
   * Reserve the nonce durably before any signature exists. The request carries
   * the node's pending count; the durable allocator may return a larger value
   * when another unresolved Vex transaction already owns that nonce.
   */
  readonly onNonceReserved: (request: {
    readonly fromAddress: Address;
    readonly chainId: number;
    readonly nodePendingNonce: number;
  }) => Promise<number>;
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
  /**
   * THE LAST GATE BEFORE THE KEY. Called exactly once, after every awaited
   * preparation step (estimate, fee filling, nonce reservation, deferred-signer
   * resolution) and immediately before the signature - a throw here means
   * NOTHING was signed and nothing was sent.
   *
   * THE HOOK ITSELF MAY READ THE CHAIN, and on the money path it must: the
   * authoritative balance and debit read belongs in THIS window, not at quote
   * time, because only here is the transaction that will be signed already
   * fixed (contract C2.6; MetaMask re-reads the live balance at submit for the
   * same reason, `strategy/server/server-submit.ts:518-565`). What the contract
   * forbids is a provider call AFTER the hook resolves and before the
   * signature: state validated at the end of the hook must still be the state
   * the bytes commit to.
   *
   * `signStageBroadcast` therefore issues NOTHING of its own between this hook
   * and the signature, and the DEFERRED arm signs offline so that literally no
   * request reaches the network in that window. The EAGER arm goes through
   * viem's wallet action, which awaits exactly one `eth_chainId` of its own
   * before it reaches the local signer (measured in viem 2.54.3,
   * `viem/_esm/actions/wallet/signTransaction.js`: `getChainId` is called
   * unconditionally); that single round trip is the whole residual window on
   * that arm, it belongs to viem rather than to any Vex gate, and
   * `staged-broadcast-offline-signature.test.ts` pins both arms so the difference
   * can never widen unnoticed. A lane that needs the window fully closed uses
   * the deferred arm, which exists for exactly that.
   *
   * The KyberSwap swap leg uses this hook to re-assert the approved price floor
   * against the calldata that is actually about to be signed, which the
   * allowance-stage checks alone cannot cover.
   *
   * The FINAL PREPARED REQUEST is passed in, and a gate about the transaction
   * must assert against it rather than against the values it handed in: those
   * are what the caller ASKED to sign, and this is what WILL be signed.
   *
   * Optional so existing callers are unchanged; a lane that has an invariant to
   * re-check supplies it.
   */
  readonly onBeforeSign?: (request: FinalSignedRequest) => Promise<void>;
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
 * `bounds` is the APPROVED fee ceiling. Supplied, the fee fields are set from it
 * rather than left to the node's suggestion, and the request that is about to be
 * serialized is re-checked against it: a field above the ceiling throws
 * `StagedFeeBoundsExceededError` BEFORE anything is signed, staged or
 * broadcast. Omitted, every existing caller keeps its exact prior behaviour.
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
  signer: StagedSigner,
  txParams: StagedTxParams,
  hooks: StagedBroadcastHooks,
  priorLeg?: ConfirmedPriorLeg,
  receiptWaitRetry?: ReceiptWaitRetryOptions,
  bounds?: StagedFeeBounds,
): Promise<StagedBroadcastOutcome> {
  // One owner covers both signer arms. The durable reservation performed below
  // makes the allocation survive restart; this live owner prevents concurrent
  // callers in the one signing process from doing redundant preparation work.
  const ownerAddress = isDeferred(signer) ? signer.address : signer.account.address;
  const ownerChainId = isDeferred(signer) ? signer.chain.id : signer.chain.id;
  const nonceOwner = await acquireEvmNonceOwner(ownerAddress, ownerChainId);
  try {
    return await runStagedBroadcast(
      publicClient, signer, txParams, hooks, nonceOwner, priorLeg, receiptWaitRetry, bounds,
    );
  } finally {
    nonceOwner.release();
  }
}

/**
 * The staged sequence itself. `nonceOwner` is released the instant the submit settles, so
 * the bounded receipt wait never serializes one wallet's next transaction on
 * block time.
 */
async function runStagedBroadcast(
  publicClient: PublicClient<Transport, Chain>,
  signer: StagedSigner,
  txParams: StagedTxParams,
  hooks: StagedBroadcastHooks,
  nonceOwner: EvmNonceOwnerLease,
  priorLeg?: ConfirmedPriorLeg,
  receiptWaitRetry?: ReceiptWaitRetryOptions,
  bounds?: StagedFeeBounds,
): Promise<StagedBroadcastOutcome> {
  const deferred = isDeferred(signer) ? signer : null;
  const eager: WalletClient<Transport, Chain, Account> | null =
    deferred === null ? (signer as WalletClient<Transport, Chain, Account>) : null;
  // The preparation identity. On the eager arm it IS the wallet client's own
  // account, exactly as before; on the deferred arm it is an address-only
  // account that cannot sign.
  const account: Account = eager === null
    ? parseAccount((deferred as DeferredEvmSigner).address)
    : eager.account;
  const chain: Chain = eager === null ? (deferred as DeferredEvmSigner).chain : eager.chain;
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

  // With approved bounds, the ceiling wins over the headroom: the headroom
  // exists to survive an estimate that is slightly low, and the cap is a number
  // the user authorized. A headroomed estimate ABOVE the cap is not silently
  // trimmed - `assertWithinFeeBounds` below refuses it, because a transaction
  // that needs more gas than was approved is a transaction nobody approved.
  const gasLimit = gasLimitWithHeadroom(gasEstimate);

  // The fee fields are supplied EXPLICITLY when bounds exist, so
  // `prepareTransactionRequest` cannot fill them from the node's own suggestion:
  // the signed bytes must commit the user to the ceiling they approved and
  // nothing above it. The assertion after it is the fail-closed half - viem may
  // still route preparation through the node, and only the request that is
  // actually serialized proves what would be signed.
  // Prepared on the WALLET client when one exists (byte-identical to the prior
  // behaviour) and on the PUBLIC client otherwise - the same viem action, and
  // nonce/fee filling needs no key.
  const prepareArgs = {
    account,
    chain,
    to: txParams.to,
    data: txParams.data,
    value,
    gas: gasLimit,
    ...(bounds === undefined
      ? {}
      : bounds.mode === "eip1559"
        ? {
            maxFeePerGas: bounds.maxFeePerGasWei,
            maxPriorityFeePerGas: bounds.maxPriorityFeePerGasWei,
          }
        : { gasPrice: bounds.gasPriceWei }),
  } as const;
  const request = eager === null
    ? await publicClient.prepareTransactionRequest(prepareArgs)
    : await eager.prepareTransactionRequest(prepareArgs);
  const nodePendingNonce = request.nonce;
  if (nodePendingNonce === undefined) {
    throw new Error("signStageBroadcast: prepared transaction request has no nonce");
  }
  const nonce = await hooks.onNonceReserved({
    fromAddress: account.address,
    chainId: chain.id,
    nodePendingNonce,
  });
  if (!Number.isSafeInteger(nonce) || nonce < nodePendingNonce) {
    throw new Error("signStageBroadcast: durable nonce reservation returned an invalid nonce");
  }
  // THE OBJECT THAT IS SIGNED, built once and used for the fee assertion, the
  // pre-sign gates and both signer arms. It was previously respread at each of
  // those points, which is how a gate could end up validating something other
  // than the bytes - see `FinalSignedRequest`.
  const signedRequest = { ...request, nonce, gas: gasLimit };
  const finalRequest: FinalSignedRequest = {
    to: signedRequest.to,
    data: signedRequest.data,
    value: signedRequest.value ?? 0n,
    gas: gasLimit,
    nonce,
    // Read off the prepared request, not off `bounds`: the ceiling is what was
    // ASKED for and this is what viem is about to serialize. `??` never appears
    // here - an absent price is reported absent, because a gate told `0n` would
    // price the transaction as free.
    gasPrice: signedRequest.gasPrice,
    maxFeePerGas: signedRequest.maxFeePerGas,
    maxPriorityFeePerGas: signedRequest.maxPriorityFeePerGas,
  };
  if (bounds !== undefined) {
    assertWithinFeeBounds(signedRequest, bounds);
  }
  // Re-asserted on the request that is actually serialized: when fees/nonce
  // still need filling, viem may route preparation through the node's
  // `wallet_fillTransaction`, whose reply overwrites `gas` with the node's own
  // unbuffered figure. The signed bytes are what the chain enforces, so the
  // headroom has to survive to exactly here.
  // THE PRE-SIGN GATE, then the key, then the signature - with nothing awaited
  // in between that could reach a provider. See `DeferredEvmSigner`.
  const walletClient = eager ?? await resolveDeferredSigner(
    deferred as DeferredEvmSigner,
    account,
    chain,
    finalRequest,
  );

  // THE LAST GATE. On BOTH arms, and the LAST awaited call this function makes
  // before the signature: nothing below reaches a provider from here. The hook
  // itself may read the chain (that is where the authoritative debit read
  // lives); what must not happen is a read AFTER it. It is given the request
  // that is about to be serialized, never the caller's inputs.
  await hooks.onBeforeSign?.(finalRequest);

  // THE SIGNATURE. The eager arm keeps viem's wallet action verbatim; the
  // deferred arm signs offline so that nothing at all reaches a provider between
  // `onBeforeSign` and this line. See `DeferredEvmSigner` step 5.
  const serializedTransaction = deferred === null
    ? await walletClient.signTransaction(signedRequest)
    : await signPreparedTransactionOffline(walletClient, chain, signedRequest);
  const txHash = keccak256(serializedTransaction);

  await hooks.onHashStaged({
    txHash,
    fromAddress: account.address,
    nonce,
  });

  try {
    await publicClient.sendRawTransaction({ serializedTransaction });
  } catch (err) {
    return { kind: "ambiguous", txHash, stage: "send", reason: describeFailureForLog(err) };
  } finally {
    // THE SUBMIT HAS SETTLED, in either direction. The raw transaction either
    // reached the node - which moves the pending count the next preparation
    // reads - or it did not, and in both cases this wallet's nonce is no longer
    // being decided here. Released before the receipt wait for exactly that
    // reason; the caller's `finally` makes a second release a no-op.
    nonceOwner.release();
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

/**
 * Steps 2 to 4 of the deferred contract: the caller's gate, then the key, then
 * the identity proof. Kept in one function so no call site can reorder them.
 */
async function resolveDeferredSigner(
  deferred: DeferredEvmSigner,
  preparedAccount: Account,
  preparedChain: Chain,
  finalRequest: FinalSignedRequest,
): Promise<WalletClient<Transport, Chain, Account>> {
  await deferred.onBeforeSign(finalRequest);
  const walletClient = await deferred.createSigner();
  if (walletClient.account.address.toLowerCase() !== preparedAccount.address.toLowerCase()) {
    throw new DeferredSignerIdentityError("account");
  }
  if (walletClient.chain.id !== preparedChain.id) {
    throw new DeferredSignerIdentityError("chain");
  }
  return walletClient;
}

/**
 * Step 5 of the deferred contract: the signature itself, with ZERO provider
 * calls.
 *
 * This is viem's own local-account branch, taken directly instead of through the
 * wallet action that prefixes it with `eth_chainId`:
 *
 *   - the CHAIN ID comes from PREPARATION, not from the node. The prepared
 *     request already carries one (viem fills `chainId` by default), and it is
 *     asserted equal to the chain the request was prepared and identity-checked
 *     against rather than trusted - a request prepared for another chain is a
 *     `DeferredSignerIdentityError`, not something to sign;
 *   - the SERIALIZER is the prepared chain's own
 *     (`chain.serializers.transaction`), which is precisely what viem would have
 *     passed. A chain that declares none gets viem's default serializer inside
 *     the account, exactly as before, so no chain type loses coverage here;
 *   - `account` and `chain` are stripped from the request for the same reason
 *     viem's action destructures them out: they are client identity, not
 *     transaction fields.
 */
async function signPreparedTransactionOffline(
  walletClient: WalletClient<Transport, Chain, Account>,
  preparedChain: Chain,
  request: Parameters<WalletClient<Transport, Chain, Account>["signTransaction"]>[0],
): Promise<Hex> {
  const account = walletClient.account;
  if (account.type !== "local") throw new DeferredOfflineSignerUnavailableError();

  const { account: _unusedAccount, chain: _unusedChain, ...transaction } = request;
  const preparedChainId = (transaction as { chainId?: unknown }).chainId;
  if (preparedChainId !== undefined && preparedChainId !== preparedChain.id) {
    throw new DeferredSignerIdentityError("chain");
  }

  return await account.signTransaction(
    // The account's signer takes the serializable transaction; the request came
    // out of viem's own `prepareTransactionRequest` and every field it carries
    // is one that function produced, so this narrows a structural union rather
    // than asserting an unvalidated shape.
    { ...transaction, chainId: preparedChain.id } as Parameters<typeof account.signTransaction>[0],
    { serializer: preparedChain.serializers?.transaction },
  );
}
