/**
 * `WalletEvmTransactionConfirm` - the call that signs and broadcasts.
 *
 * Everything before the signature is `confirm-shared.ts`'s gate order; this
 * module owns the EVM half of commit-time revalidation and the staged
 * execution:
 *
 *   a. the chain the intent NAMES must still resolve to the chain id it was
 *      approved on - a re-registered alias is a different chain;
 *   b. the calldata is DECODED AGAIN against current chain state, which is also
 *      where `eth_getCode(to)` is re-read: an address that grew code since
 *      prepare turns `data = 0x` from a plain transfer into a fallback
 *      invocation, and that is a different transaction;
 *   c. the fresh decode must produce the effects the approval described;
 *   d. a fresh `eth_call` from the selected wallet;
 *   e. T2 claims the intent and writes both durable rows, then COMMITS;
 *   f. `signStageBroadcast` with the APPROVED FEE BOUNDS: it sets the fee
 *      fields from the ceiling instead of letting the node fill them, refuses
 *      any prepared field above it before signing, stages the hash BEFORE
 *      submitting, and submits once.
 *
 * NOTHING RETRIES. A send whose reply never confirmed the mempool and a receipt
 * that could not be read are both `confirmation_unknown` - a normal return that
 * settles the intent to `broadcast_unconfirmed` and leaves the chain evidence
 * to the repair lane.
 */

import { createHash } from "node:crypto";

import {
  signStageBroadcast,
  StagedFeeBoundsExceededError,
  type StagedBroadcastOutcome,
  type StagedFeeBounds,
} from "@tools/evm-chains/staged-broadcast.js";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import type {
  EvmTransactionPayload,
  WalletTransactionFeeBounds,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";
import { summarizeWalletError } from "../send-types.js";

import type { TransactionActivity } from "./activity-writer.js";
import {
  claimOrRefuse,
  gateConfirm,
  settleExecution,
  type TransactionExecution,
} from "./confirm-shared.js";
import {
  defaultEvmPrepareChainFactory,
  type EvmPrepareChain,
  type EvmPrepareChainFactory,
} from "./chain-seams.js";
import { decodeEvmTransaction } from "./decode-evm.js";
import { refusalToResult } from "./tool-io.js";
import { revalidateDecodedEffects, revalidateEvmChainIdentity } from "./revalidate.js";

/**
 * The account-bound clients the staged primitive needs, behind a seam so the
 * whole confirm path is provable without a chain. It is the ONLY place in this
 * module that sees key material, and it receives it from the caller's already
 * resolved signing wallet rather than resolving one of its own.
 */
export interface EvmSignerClients {
  readonly publicClient: Parameters<typeof signStageBroadcast>[0];
  readonly walletClient: Parameters<typeof signStageBroadcast>[1];
  /** Human-readable chain name, for the explorer ref. */
  readonly chainName: string;
}

export type EvmSignerClientsFactory = (
  chainInput: string,
  wallet: EvmWallet,
) => Promise<EvmSignerClients>;

export interface EvmConfirmDeps {
  readonly chainFactory: EvmPrepareChainFactory;
  readonly signerClientsFactory: EvmSignerClientsFactory;
}

/**
 * The real adapter. Same inclusive resolver the transfer executor uses, so a
 * Khalani-registered chain and a local-registry chain both work.
 */
export const defaultEvmSignerClientsFactory: EvmSignerClientsFactory = async (
  chainInput,
  wallet,
) => {
  const { resolveInclusiveEvmChain } = await import("@tools/evm-chains/resolver.js");
  const resolved = await resolveInclusiveEvmChain(chainInput);
  if (resolved.source === "khalani") {
    const { createDynamicPublicClient, createDynamicWalletClient } = await import(
      "@tools/khalani/evm-client.js"
    );
    return {
      publicClient: createDynamicPublicClient(
        resolved.khalaniChain,
        resolved.khalaniChains,
      ) as unknown as EvmSignerClients["publicClient"],
      walletClient: createDynamicWalletClient(
        resolved.khalaniChain,
        resolved.khalaniChains,
        wallet.privateKey as `0x${string}`,
      ) as unknown as EvmSignerClients["walletClient"],
      chainName: resolved.khalaniChain.name || chainInput,
    };
  }
  const { getLocalEvmClients } = await import("@tools/evm-chains/evm-client.js");
  const clients = getLocalEvmClients(resolved.config, wallet.privateKey as `0x${string}`);
  return {
    publicClient: clients.publicClient as unknown as EvmSignerClients["publicClient"],
    walletClient: clients.walletClient as unknown as EvmSignerClients["walletClient"],
    chainName: resolved.config.name || chainInput,
  };
};

const DEFAULT_DEPS: EvmConfirmDeps = {
  chainFactory: defaultEvmPrepareChainFactory,
  signerClientsFactory: defaultEvmSignerClientsFactory,
};

/** The approved caps, in the vocabulary the signing primitive enforces. */
function stagedBoundsOf(bounds: WalletTransactionFeeBounds): StagedFeeBounds | null {
  if (bounds.mode === "eip1559") {
    return {
      mode: "eip1559",
      gasLimit: BigInt(bounds.gasLimit),
      maxFeePerGasWei: BigInt(bounds.maxFeePerGasWei),
      maxPriorityFeePerGasWei: BigInt(bounds.maxPriorityFeePerGasWei),
    };
  }
  if (bounds.mode === "legacy") {
    return { mode: "legacy", gasLimit: BigInt(bounds.gasLimit), gasPriceWei: BigInt(bounds.gasPriceWei) };
  }
  return null;
}

export async function handleWalletEvmTransactionConfirm(
  params: Record<string, unknown>,
  context: InternalToolContext,
  deps: EvmConfirmDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  const gate = await gateConfirm(params, context, "eip155");
  if (gate.kind === "return") return gate.result;
  const { intent, signer } = gate;
  if (signer.family !== "eip155" || intent.payload.family !== "eip155") {
    // Unreachable: the gate proved both. Stated rather than asserted, because a
    // non-null assertion on the money path is exactly what this repository does
    // not do.
    return refusalToResult({
      code: "invalid_input",
      message: `Refusing to sign: intent ${intent.intentId} is not an EVM intent. Nothing was signed.`,
      details: { intentId: intent.intentId },
    });
  }
  const payload: EvmTransactionPayload = intent.payload.evm;

  const bounds = stagedBoundsOf(intent.feeBounds);
  if (bounds === null) {
    return refusalToResult({
      code: "invalid_input",
      message:
        `Refusing to sign: intent ${intent.intentId} carries Solana fee bounds on an EVM proposal, so `
        + "the caps that were approved cannot be enforced. Nothing was signed.",
      details: { intentId: intent.intentId },
    });
  }

  const chain = await deps.chainFactory(intent.chainAlias ?? "");

  const revalidated = await revalidateEvmAtCommit(intent, payload, chain);
  if (revalidated !== null) return revalidated;

  const claimed = await claimOrRefuse(intent);
  if (claimed.kind === "return") return claimed.result;

  const execution = await executeEvmTransaction({
    intent,
    payload,
    wallet: signer,
    bounds,
    activity: claimed.claim.activity,
    deps,
  });

  return settleExecution(claimed.claim.intent, claimed.claim.activity, execution, {
    chain: intent.chainAlias,
    chainId: intent.chainId,
    approvedFeeBounds: intent.feeBounds,
  });
}

/** Steps a to d. `null` means every check passed. */
async function revalidateEvmAtCommit(
  intent: WalletTransactionIntent,
  payload: EvmTransactionPayload,
  chain: EvmPrepareChain,
): Promise<ToolResult | null> {
  const identity = revalidateEvmChainIdentity(intent, {
    chainId: chain.chainId,
    chainAlias: chain.chainAlias,
  });
  if (!identity.ok) return refusalToResult(identity.refusal);

  // Re-decoding is ALSO the `eth_getCode(to)` re-check: the decoder refuses
  // `data = 0x` to an address that has code, so an address that became a
  // contract between prepare and now refuses here by name.
  const decoded = await decodeEvmTransaction(
    { to: payload.to, data: payload.data, valueWei: payload.valueWei, chainId: chain.chainId },
    chain,
  );
  if (!decoded.ok) return refusalToResult(decoded.refusal);

  const effects = revalidateDecodedEffects(intent, decoded.value);
  if (!effects.ok) return refusalToResult(effects.refusal);

  const simulated = await chain.simulate({
    from: intent.walletAddress,
    to: payload.to,
    data: payload.data,
    valueWei: payload.valueWei,
  });
  if (!simulated.ok) return refusalToResult(simulated.refusal);

  return null;
}

/**
 * Sign, stage, submit, and classify. The staged primitive is the same one every
 * EVM venue here uses; the only addition on this path is the approved ceiling.
 */
async function executeEvmTransaction(args: {
  readonly intent: WalletTransactionIntent;
  readonly payload: EvmTransactionPayload;
  readonly wallet: EvmWallet;
  readonly bounds: StagedFeeBounds;
  readonly activity: TransactionActivity;
  readonly deps: EvmConfirmDeps;
}): Promise<TransactionExecution> {
  const { intent, payload, wallet, bounds, activity, deps } = args;

  let clients: EvmSignerClients;
  try {
    clients = await deps.signerClientsFactory(intent.chainAlias ?? "", wallet);
  } catch (cause) {
    return preBroadcast(
      cause,
      "The transaction could not be prepared for signing because its chain clients could not be "
      + "built. Nothing was signed and nothing was broadcast.",
    );
  }

  // The staging hook is the one failure that must be told apart from every
  // other pre-broadcast throw: it means the durable evidence write failed while
  // the intent was already `consuming`, which is the `audit_failed` status.
  let stagingFailed = false;

  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(
      clients.publicClient,
      clients.walletClient,
      { to: payload.to as `0x${string}`, data: payload.data as `0x${string}`, value: BigInt(payload.valueWei) },
      {
        onHashStaged: async (handles) => {
          try {
            await activity.stageEvm({
              txHash: handles.txHash,
              fromAddress: handles.fromAddress,
              nonce: handles.nonce,
            });
          } catch (cause) {
            stagingFailed = true;
            throw cause;
          }
        },
        onAccepted: () => activity.noteAccepted(),
      },
      undefined,
      undefined,
      bounds,
    );
  } catch (cause) {
    // EVERY throw out of `signStageBroadcast` is PRE-SUBMISSION: the estimate,
    // the bounds check, the preparation, the signature, or the staging hook.
    // Nothing reached the network on any of them.
    if (cause instanceof StagedFeeBoundsExceededError) {
      logger.warn("wallet.transaction.fee_bounds_exceeded", {
        intentId: intent.intentId,
        field: cause.field,
      });
      return preBroadcast(
        cause,
        `Refusing to sign: the prepared transaction's ${cause.field} is ${cause.actual}, above the `
        + `${cause.approved} that was approved. Nothing was signed and nothing was broadcast. `
        + "Prepare the transaction again with caps that cover the current network price, and the "
        + "user will see and approve the new ceiling.",
      );
    }
    if (stagingFailed) {
      return {
        ...preBroadcast(
          cause,
          "The durable record of this transaction could not be written, so Vex refused to broadcast "
          + "it. Nothing was broadcast and no funds moved. This is a Vex-side audit failure, not a "
          + "chain rejection.",
        ),
        auditFailed: true,
      };
    }
    return preBroadcast(
      cause,
      "The transaction failed before it was broadcast, so nothing reached the network and no funds "
      + "moved. Preparing it again is safe.",
    );
  }

  if (outcome.kind === "ambiguous") {
    return {
      kind: "confirmation_unknown",
      txHash: outcome.txHash,
      chain: clients.chainName,
      errorKind: "ConfirmationUnknown",
      errorHash: createHash("sha256")
        .update(`evm-ambiguous:${outcome.stage}:${outcome.reason}`)
        .digest("hex")
        .slice(0, 16),
    };
  }

  if (outcome.kind === "reverted") {
    return {
      kind: "chain_failed",
      txHash: outcome.txHash,
      chain: clients.chainName,
      errorKind: "ChainRevert",
      errorHash: createHash("sha256")
        .update(`evm-revert:${outcome.txHash}`)
        .digest("hex")
        .slice(0, 16),
    };
  }

  return {
    kind: "confirmed",
    txHash: outcome.txHash,
    data: {
      txHash: outcome.txHash,
      chain: clients.chainName,
      status: "confirmed",
      blockNumber: Number(outcome.receipt.blockNumber),
      _executionId: activity.executionId,
      _explorerRefs: [{ chain: clients.chainName, txRef: outcome.txHash }],
    },
  };
}

/** A pre-broadcast outcome whose cause is reduced to a structural fingerprint. */
function preBroadcast(cause: unknown, message: string): Extract<
  TransactionExecution,
  { kind: "pre_broadcast_failed" }
> {
  const sum = summarizeWalletError(cause);
  return {
    kind: "pre_broadcast_failed",
    errorKind: sum.errorKind,
    errorHash: sum.errorHash,
    message: `${message} Error hash: ${sum.errorHash}.`,
  };
}
