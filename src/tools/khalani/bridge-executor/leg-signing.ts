/**
 * Staged per-leg SIGNING — sign locally, hand the caller the computed
 * hash/signature to persist BEFORE it reaches the network, broadcast, then wait
 * a bounded receipt. A crash between sign and send leaves a discoverable
 * pending row, never a silently lost transaction.
 *
 * This module holds the signing keys (it lives under `src/tools/khalani`,
 * outside the `src/vex-agent/tools` signer-import allowlist walk); the handler
 * passes a resolved `ChainWallet` and receives only computed hashes back
 * through the staging hooks, so no key material crosses into `src/vex-agent`.
 *
 * SOLANA LEG (W5 design `w5-design.md` §2/R2/R2b, migration 049): Khalani's
 * provider-built Solana transaction carries no separate blockhash-height
 * evidence (no `blockhashWithMetadata`-style field, unlike Jupiter `/build`),
 * so it follows the same MANDATORY-HEIGHT/REPLACE doctrine K2 built for
 * Jupiter lend/prediction: `prepareVersionedTx` (the shared
 * `src/tools/solana-ecosystem/shared/solana-transaction` primitive) enforces
 * the STRICT sole-signer check, runs the shared pre-sign compute-budget gates,
 * fetches a FRESH `{blockhash, lastValidBlockHeight}` pair from Khalani's own
 * already-trusted per-chain RPC (`getChainRpcUrl` — the same endpoint this
 * module already uses to broadcast and confirm), and bakes it into the
 * transaction BEFORE signing. Both values are surfaced through `onHashStaged`
 * alongside the signature so the caller can persist them via
 * `markActivitySolanaBroadcast`'s evidence-carrying CAS.
 */

import { getAddress, keccak256, type Hex } from "viem";
import { Connection, Keypair } from "@solana/web3.js";

import { VexError, ErrorCodes } from "../../../errors.js";
import { getChainRpcUrl } from "../chains.js";
import { gasLimitForProviderHintedCall } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  estimateGasForPlanLeg,
  priorLegAnchorFrom,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { createDynamicPublicClient, createDynamicWalletClient } from "../evm-client.js";
import { broadcastSignedSolanaTransaction, confirmSolanaSignature } from "../solana-signer.js";
import { prepareVersionedTx } from "@tools/solana-ecosystem/shared/solana-transaction.js";
import { buildSolanaBridgeFeeTransfer } from "@tools/bridge-fee/index.js";
import {
  checkNativeValueAuthorizedForCall,
  type NativeValueAuthorization,
} from "@tools/evm-chains/native-value-authorization/index.js";
import type { KhalaniChain } from "../types.js";
import type { ChainWallet } from "../../wallet/multi-auth.js";
import {
  khalaniLegNativeValueCall,
  type KhalaniStagedLeg,
  type KhalaniStagedOutcome,
  type KhalaniStageHooks,
  type NormalizedEvmTx,
} from "./staged-leg.js";

async function signStageEvmLeg(
  tx: NormalizedEvmTx,
  nativeValue: NativeValueAuthorization,
  chain: KhalaniChain,
  chains: KhalaniChain[],
  privateKey: Hex,
  hooks: KhalaniStageHooks,
  priorLeg: ConfirmedPriorLeg | undefined,
): Promise<KhalaniStagedOutcome> {
  // THE LAST GATE. Re-validated here, against the exact transaction about to be
  // serialized, rather than trusted from plan time: the authorization is bound
  // to a `(chain, to, calldata, value)` fingerprint, so a value that grew — or
  // a target that changed — after classification cannot be signed. A leg whose
  // native charge was never proven fails here too, which is what makes
  // "never sign a value you could not classify" a property of the signer and
  // not a convention callers have to remember.
  const authorized = checkNativeValueAuthorizedForCall(
    nativeValue,
    khalaniLegNativeValueCall(chain.id, tx),
  );
  if (!authorized.ok) {
    throw new VexError(
      ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
      `Refused before signing: ${authorized.reason}.`,
      "Nothing was signed. Re-quote the bridge; do not retry this deposit plan.",
    );
  }

  const walletClient = createDynamicWalletClient(chain, chains, privateKey);
  const publicClient = createDynamicPublicClient(chain, chains);
  const account = walletClient.account;

  if (tx.expectedFrom && getAddress(account.address) !== tx.expectedFrom) {
    throw new VexError(
      ErrorCodes.KHALANI_ADDRESS_MISMATCH,
      `Approval sender ${tx.expectedFrom} does not match the configured EVM wallet.`,
    );
  }

  // Estimated explicitly for EVERY leg (allowance AND bridge deposit) rather
  // than signing either Khalani's `tx.gas` verbatim or viem's bare estimate —
  // both are the out-of-gas defect `gasLimitWithHeadroom` documents. Same call
  // shape as the signed transaction (`value` included), so a leg that can no
  // longer execute still throws HERE, before anything is signed, staged, or
  // broadcast, and the raw error reaches the handler's classifier unchanged.
  // `priorLeg` (the approval leg this plan just confirmed) additionally lets
  // the estimate survive a node that has not applied that approval yet —
  // bounded, and never at the cost of signing an unestimated leg
  // (`dependent-leg-gas-estimate.ts`).
  const gasEstimate = await estimateGasForPlanLeg(
    publicClient,
    {
      account,
      to: tx.to,
      ...(tx.data ? { data: tx.data } : {}),
      value: tx.value ?? 0n,
    },
    priorLeg,
  );
  const gasLimit = gasLimitForProviderHintedCall(gasEstimate, tx.gas);

  const request = await walletClient.prepareTransactionRequest({
    account,
    chain: walletClient.chain,
    to: tx.to,
    ...(tx.data ? { data: tx.data } : {}),
    value: tx.value ?? 0n,
    gas: gasLimit,
    ...(tx.nonce !== undefined ? { nonce: tx.nonce } : {}),
  });
  // Re-asserted on the request that is actually serialized: when fees/nonce
  // still need filling, viem may route preparation through the node's
  // `wallet_fillTransaction`, whose reply overwrites `gas` with the node's own
  // unbuffered figure. The signed bytes are what the chain enforces, so the
  // limit has to survive to exactly here.
  const serializedTransaction = await walletClient.signTransaction({ ...request, gas: gasLimit });
  const txHash = keccak256(serializedTransaction);
  const nonce = request.nonce;
  if (nonce === undefined) {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Prepared Khalani transaction has no nonce.");
  }

  await hooks.onHashStaged({ txHash, fromAddress: account.address, nonce });

  try {
    await publicClient.sendRawTransaction({ serializedTransaction });
  } catch {
    return { kind: "ambiguous", txHash, stage: "send" };
  }

  try {
    await hooks.onAccepted();
  } catch {
    // Best-effort bookkeeping — the transaction is already in flight.
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    // Same validator the estimator uses, so a receipt without a usable block
    // number degrades to "no anchor" rather than to a bad one.
    const settledAtBlock = priorLegAnchorFrom(receipt.blockNumber)?.blockNumber ?? null;
    return receipt.status === "success"
      ? { kind: "confirmed", txHash, settledAtBlock }
      : { kind: "reverted", txHash };
  } catch {
    return { kind: "ambiguous", txHash, stage: "confirm" };
  }
}

async function signStageSolanaLeg(
  base64Tx: string,
  chain: KhalaniChain,
  chains: KhalaniChain[],
  signer: Extract<ChainWallet, { family: "solana" }>,
  hooks: KhalaniStageHooks,
): Promise<KhalaniStagedOutcome> {
  const rpcUrl = getChainRpcUrl(chain.id, chains);
  // Sole-signer check + fresh-blockhash REPLACE (module doc) — refuses a
  // transaction that is not exactly sole-signed by `signer`, then signs over a
  // FRESH blockhash fetched from Khalani's own per-chain RPC. The derived
  // signature (base58) is available BEFORE broadcast, so it stages exactly
  // like the EVM hash. Khalani's `txHash` field carries this Solana signature
  // by API contract; the row's chain_family is 'solana' and its nonce stays
  // NULL (B1) — now paired with the blockhash evidence W5 §2/R2b requires.
  const prepared = await prepareVersionedTx(base64Tx, Keypair.fromSecretKey(signer.secretKey), {
    connection: new Connection(rpcUrl, "confirmed"),
  });
  const signedBase64 = Buffer.from(prepared.serialized).toString("base64");
  const signature = prepared.signature;

  await hooks.onHashStaged({
    txHash: signature,
    fromAddress: signer.address,
    nonce: null,
    recentBlockhash: prepared.recentBlockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  });

  try {
    await broadcastSignedSolanaTransaction(rpcUrl, signedBase64);
  } catch {
    return { kind: "ambiguous", txHash: signature, stage: "send" };
  }

  try {
    await hooks.onAccepted();
  } catch {
    // Best-effort bookkeeping — the transaction is already in flight.
  }

  try {
    const confirmation = await confirmSolanaSignature(rpcUrl, signature);
    // Mirror the EVM receipt mapping: a mined-but-failed transaction (non-null
    // `value.err`, surfaced as `reverted`) is a revert, never a confirmed deposit.
    return confirmation.status === "reverted"
      ? { kind: "reverted", txHash: signature }
      : { kind: "confirmed", txHash: signature, settledAtBlock: null };
  } catch {
    return { kind: "ambiguous", txHash: signature, stage: "confirm" };
  }
}

/**
 * Sign, stage (via `hooks.onHashStaged`), broadcast, and await a bounded receipt
 * for ONE planned leg. The leg's family selects the signer path; the caller's
 * `signer` MUST match that family (fail-closed otherwise).
 *
 * `priorLeg` is the `settledAtBlock` anchor of the leg this plan confirmed
 * immediately before (the allowance leg). It only affects gas ESTIMATION for
 * EVM legs — see `signStageEvmLeg`.
 */
export async function signStageKhalaniLeg(
  leg: KhalaniStagedLeg,
  sourceChain: KhalaniChain,
  chains: KhalaniChain[],
  signer: ChainWallet,
  hooks: KhalaniStageHooks,
  priorLeg?: ConfirmedPriorLeg,
): Promise<KhalaniStagedOutcome> {
  if (leg.kind === "evm") {
    if (signer.family !== "eip155") {
      throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "EVM deposit requires an EVM signing wallet.");
    }
    return signStageEvmLeg(leg.tx, leg.nativeValue, sourceChain, chains, signer.privateKey, hooks, priorLeg);
  }
  if (signer.family !== "solana") {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Solana deposit requires a Solana signing wallet.");
  }
  if (leg.kind === "solana_fee") {
    // Materialized here, not in the planner: resolving the mint's owner
    // program and the treasury ATA's existence are network reads, and the
    // planner is network-free. The RPC is the same per-chain endpoint this
    // module already signs and broadcasts on.
    const fee = await buildSolanaBridgeFeeTransfer({
      connection: new Connection(getChainRpcUrl(sourceChain.id, chains), "confirmed"),
      mint: leg.mint,
      feeRaw: leg.feeRaw,
      owner: signer.address,
    });
    return signStageSolanaLeg(fee.base64Tx, sourceChain, chains, signer, hooks);
  }
  return signStageSolanaLeg(leg.base64Tx, sourceChain, chains, signer, hooks);
}
