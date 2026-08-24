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

import type { Account, Chain, PublicClient, Transport, WalletClient } from "viem";

import {
  signStageBroadcast,
  StagedFeeBoundsExceededError,
  type DeferredEvmSigner,
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
import { recheckAuthority, type AuthorityAnchor } from "./authority-fence.js";
import {
  claimOrRefuse,
  gateConfirm,
  settleExecution,
  type SignerLoad,
  type TransactionExecution,
} from "./confirm-shared.js";
import type { TransactionRefusal } from "./refusal.js";
import {
  defaultEvmPrepareChainFactory,
  type EvmPrepareChain,
  type EvmPrepareChainFactory,
} from "./chain-seams.js";
import { decodeEvmTransaction } from "./decode-evm.js";
import { refusalToResult } from "./tool-io.js";
import { revalidateDecodedEffects, revalidateEvmChainIdentity } from "./revalidate.js";

/**
 * The clients the staged primitive needs, behind a seam so the whole confirm
 * path is provable without a chain.
 *
 * KEYLESS BY CONSTRUCTION. The factory builds the read client and the chain
 * identity from the chain name alone; the key-bearing wallet client is produced
 * later by `createWalletClient`, which the staged primitive calls only after its
 * pre-sign hook has passed. Nothing in this module holds key material across a
 * network round trip.
 */
export interface EvmSignerClients {
  readonly publicClient: EvmReadClient;
  /** The chain the request is prepared and signed for. */
  readonly chain: EvmChainDescriptor;
  /** Build the account-bound signing client from an already-decrypted wallet. */
  readonly createWalletClient: (wallet: EvmWallet) => EvmWalletClient;
  /** Human-readable chain name, for the explorer ref. */
  readonly chainName: string;
}

/**
 * The two viem client shapes NAMED DIRECTLY rather than projected out of
 * `Parameters<typeof signStageBroadcast>`.
 *
 * The projection is what forced the `as unknown as` casts below: TypeScript
 * cannot name the anonymous positional parameter type at this module's
 * boundary, so every factory return had to be laundered through `unknown` to
 * reach it. Both real factories (`@tools/khalani/evm-client.js`,
 * `@tools/evm-chains/evm-client.js`) already DECLARE these exact viem types, so
 * naming them here makes the seam assignable with no cast at all - and the
 * signature is still checked against the primitive, because
 * `signStageBroadcast` takes `PublicClient<Transport, Chain>` and
 * `WalletClient<Transport, Chain, Account>` and a drift in either would fail
 * the call site.
 */
type EvmReadClient = PublicClient<Transport, Chain>;

/** The account-bound client shape `signStageBroadcast`'s eager arm accepts. */
type EvmWalletClient = WalletClient<Transport, Chain, Account>;

/** The viem chain object the deferred signer contract compares against. */
type EvmChainDescriptor = DeferredEvmSigner["chain"];

export type EvmSignerClientsFactory = (chainInput: string) => Promise<EvmSignerClients>;

export interface EvmConfirmDeps {
  readonly chainFactory: EvmPrepareChainFactory;
  readonly signerClientsFactory: EvmSignerClientsFactory;
}

/**
 * The real adapter. Same inclusive resolver the transfer executor uses, so a
 * Khalani-registered chain and a local-registry chain both work.
 */
export const defaultEvmSignerClientsFactory: EvmSignerClientsFactory = async (chainInput) => {
  const { resolveInclusiveEvmChain } = await import("@tools/evm-chains/resolver.js");
  const resolved = await resolveInclusiveEvmChain(chainInput);
  if (resolved.source === "khalani") {
    const { createDynamicPublicClient, createDynamicWalletClient } = await import(
      "@tools/khalani/evm-client.js"
    );
    const publicClient = createDynamicPublicClient(
      resolved.khalaniChain,
      resolved.khalaniChains,
    );
    return {
      publicClient,
      chain: publicClient.chain,
      createWalletClient: (wallet) =>
        createDynamicWalletClient(
          resolved.khalaniChain,
          resolved.khalaniChains,
          wallet.privateKey as `0x${string}`,
        ),
      chainName: resolved.khalaniChain.name || chainInput,
    };
  }
  const { getLocalEvmClients, getLocalPublicClient } = await import(
    "@tools/evm-chains/evm-client.js"
  );
  const publicClient = getLocalPublicClient(resolved.config);
  return {
    publicClient,
    chain: publicClient.chain,
    createWalletClient: (wallet) =>
      getLocalEvmClients(resolved.config, wallet.privateKey as `0x${string}`).walletClient,
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
  const { intent, loadSigner, anchor } = gate;
  if (intent.payload.family !== "eip155") {
    // Unreachable: the gate proved it. Stated rather than asserted, because a
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

  const claimed = await claimOrRefuse(intent, anchor);
  if (claimed.kind === "return") return claimed.result;

  const execution = await executeEvmTransaction({
    intent,
    payload,
    loadSigner,
    anchor,
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
  readonly loadSigner: () => SignerLoad;
  readonly anchor: AuthorityAnchor;
  readonly bounds: StagedFeeBounds;
  readonly activity: TransactionActivity;
  readonly deps: EvmConfirmDeps;
}): Promise<TransactionExecution> {
  const { intent, payload, loadSigner, anchor, bounds, activity, deps } = args;

  let clients: EvmSignerClients;
  try {
    clients = await deps.signerClientsFactory(intent.chainAlias ?? "");
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
  // A refused AUTHORITY FENCE is told apart from BOTH: it is not our audit
  // breaking and not the chain refusing, it is the user having replaced the
  // authority this dispatch was approved under.
  let fenceRefusal: TransactionRefusal | null = null;

  const deferredSigner: DeferredEvmSigner = {
    kind: "deferred",
    address: intent.walletAddress as `0x${string}`,
    chain: clients.chain,
    // FENCE POINT (b). Runs after the estimate, the request preparation and the
    // fee-bound check, and before any key exists. A refusal here means NOTHING
    // was decrypted, signed, staged or broadcast.
    onBeforeSign: async () => {
      const fenced = await recheckAuthority(anchor, "pre_sign");
      if (!fenced.ok) {
        fenceRefusal = fenced.refusal;
        throw new FenceRefused("authority fence refused before signing");
      }
    },
    // The key is decrypted HERE and nowhere earlier, immediately before the
    // signature, with no provider call in between.
    createSigner: async () => {
      const loaded = loadSigner();
      if (loaded.kind === "return") {
        fenceRefusal = {
          code: "forbidden_field",
          message:
            "Refusing to sign: the wallet this transaction was approved for could not be resolved "
            + "for signing. Nothing was signed and no funds moved.",
          details: { intentId: intent.intentId },
        };
        throw new FenceRefused("signer could not be loaded");
      }
      if (loaded.signer.family !== "eip155") {
        fenceRefusal = {
          code: "invalid_input",
          message:
            `Refusing to sign: intent ${intent.intentId} is not an EVM intent. Nothing was signed.`,
          details: { intentId: intent.intentId },
        };
        throw new FenceRefused("signer family mismatch");
      }
      return clients.createWalletClient(loaded.signer);
    },
  };

  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(
      clients.publicClient,
      deferredSigner,
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
          // FENCE POINT (c), DELIBERATELY OUTSIDE the catch above. A refusal
          // here is a fence refusal, never `audit_failed`: our audit write
          // succeeded, and what stopped the broadcast is that the authority was
          // revoked while it was being written. Nothing has been submitted.
          const fenced = await recheckAuthority(anchor, "pre_submit");
          if (!fenced.ok) {
            fenceRefusal = fenced.refusal;
            throw new FenceRefused("authority fence refused before submission");
          }
        },
        onAccepted: () => activity.noteAccepted(),
      },
      undefined,
      undefined,
      bounds,
    );
  } catch (cause) {
    // Checked FIRST, and before `stagingFailed`: at the post-stage point BOTH
    // flags are reachable, and a fence refusal must never be classified as an
    // audit failure. `instanceof` rather than the flag alone, so the branch is
    // about the error that actually propagated.
    if (cause instanceof FenceRefused && fenceRefusal !== null) {
      const refusal: TransactionRefusal = fenceRefusal;
      return {
        kind: "pre_broadcast_failed",
        errorKind: "AuthorityFenceRefused",
        errorHash: createHash("sha256")
          .update(`evm-fence:${intent.intentId}:${refusal.details?.fencePoint ?? "unknown"}`)
          .digest("hex")
          .slice(0, 16),
        message: refusal.message,
      };
    }
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

/**
 * Thrown out of a `signStageBroadcast` hook so the primitive aborts, while the
 * REFUSAL that caused it travels back on `fenceRefusal`. The error itself
 * carries no message worth reading: the refusal is the sentence the user gets.
 */
class FenceRefused extends Error {}

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
