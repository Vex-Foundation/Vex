/**
 * `WalletWrapConfirm` - the call that signs and broadcasts a wrap or unwrap.
 *
 * Everything before the signature is `./gate.ts`; this module owns the staged
 * execution and the settlement of its outcome:
 *
 *   8. claim the intent and write both durable rows, then COMMIT;
 *   9. `signStageBroadcast` with the APPROVED gas caps, then decode the receipt
 *      and settle.
 *
 * WHY THE WHOLE TRIPLE IS COMPARED IN THE GATE. `deposit()` calldata is the
 * CONSTANT `0xd0e30db0` on every chain and for every amount: the amount lives in
 * `value`. Comparing calldata alone would pass while the transaction moved a
 * different quantity of the user's funds.
 *
 * NOTHING RETRIES. A send whose reply never confirmed the mempool and a receipt
 * that could not be read are both `confirmation_unknown` - a normal return that
 * settles the intent to `broadcast_unconfirmed` and leaves the chain evidence to
 * the repair lane.
 */

import { createHash } from "node:crypto";

import {
  signStageBroadcast,
  StagedFeeBoundsExceededError,
  type DeferredEvmSigner,
  type StagedBroadcastOutcome,
  type StagedFeeBounds,
} from "@tools/evm-chains/staged-broadcast.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";
import { walletScopeErrorToResult } from "../resolve.js";
import { summarizeWalletError } from "../send-types.js";
import {
  recheckAuthority,
  recheckAuthorityWith,
  type AuthorityAnchor,
} from "../transaction/authority-fence.js";
import {
  defaultEvmSignerClientsFactory,
  type EvmSignerClients,
  type EvmSignerClientsFactory,
} from "../transaction/confirm-evm.js";
import type { TransactionExecution } from "../transaction/execution-outcome.js";

import { claimWrapIntent, type WrapActivity } from "./activity-writer.js";
import type { WrapTransaction } from "./calldata.js";
import { defaultWrapChainFactory, type WrapChain, type WrapChainFactory } from "./chain.js";
import {
  gateWrapConfirm,
  revalidateWrapAtCommit,
  type WrapSignerLoad,
} from "./gate.js";
import { verifyFinalWrapRequest } from "./final-request.js";
import { formatWrapAmountHuman, isWrapEvmFeeBounds } from "./preview.js";
import { accept, refuse, type WrapOutcome, type WrapRefusal } from "./refusal.js";
import { decodeWrapSettlement, type WrapReceiptVerdict } from "./receipt-decode.js";

/**
 * The verdict every arm that never reached a receipt reports. Those arms
 * learned nothing about the legs, which is exactly `undecodable` - and NOT
 * the amount anomaly, which requires a receipt to have contradicted us.
 */
const UNDECODED: WrapReceiptVerdict = { kind: "undecodable" };
import { settleWrapExecution } from "./settlement.js";
import { wrapRefusalToResult } from "./tool-io.js";

/**
 * The pre-signature gate lives in `./gate.ts`. Re-exported here so this module
 * stays the one public entry point for the confirm contract, and its callers
 * and tests do not have to know where the split falls.
 */
export { revalidateWrapIntentRow, revalidateWrapAtCommit } from "./gate.js";


export interface WrapConfirmDeps {
  readonly chainFactory: WrapChainFactory;
  readonly signerClientsFactory: EvmSignerClientsFactory;
}

const DEFAULT_DEPS: WrapConfirmDeps = {
  chainFactory: defaultWrapChainFactory,
  signerClientsFactory: defaultEvmSignerClientsFactory,
};

/** Thrown to unwind `signStageBroadcast` when the authority fence refuses. */
class FenceRefused extends Error {}

/** The approved caps, in the vocabulary the signing primitive enforces. */
function stagedBoundsOf(intent: WalletWrapIntent): StagedFeeBounds | null {
  const bounds = intent.feeBounds;
  if (!isWrapEvmFeeBounds(bounds)) return null;
  if (bounds.mode === "eip1559") {
    return {
      mode: "eip1559",
      gasLimit: BigInt(bounds.gasLimit),
      maxFeePerGasWei: BigInt(bounds.maxFeePerGasWei),
      maxPriorityFeePerGasWei: BigInt(bounds.maxPriorityFeePerGasWei),
    };
  }
  return {
    mode: "legacy",
    gasLimit: BigInt(bounds.gasLimit),
    gasPriceWei: BigInt(bounds.gasPriceWei),
  };
}


// ── Steps 8 and 9 ────────────────────────────────────

// ── Steps 8 and 9 ─────────────────────────────────────────────────────

export async function handleWalletWrapConfirm(
  params: Record<string, unknown>,
  context: InternalToolContext,
  deps: WrapConfirmDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  const gate = await gateWrapConfirm(params, context);
  if (gate.kind === "return") return gate.result;
  const { intent, anchor, loadSigner } = gate;

  const bounds = stagedBoundsOf(intent);
  if (bounds === null) {
    return wrapRefusalToResult({
      code: "missing_fee_bounds",
      message:
        `Refusing to sign: wrap intent ${intent.intentId} does not carry EVM gas caps, so the caps `
        + "that were approved cannot be enforced. Nothing was signed.",
      details: { intentId: intent.intentId },
    });
  }

  let chain: WrapChain;
  try {
    chain = await deps.chainFactory(intent.chainAlias);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const revalidated = revalidateWrapAtCommit(intent, chain);
  if (!revalidated.ok) return wrapRefusalToResult(revalidated.refusal);
  const transaction = revalidated.value;

  const simulated = await chain.simulate({
    from: intent.walletAddress,
    to: transaction.to,
    data: transaction.data,
    valueWei: transaction.valueWei,
  });
  if (!simulated.ok) return wrapRefusalToResult(simulated.refusal);

  const amountHuman = formatWrapAmountHuman(intent.amountRaw, intent.contract.decimals);

  const claimed = await claimWrapIntent(
    intent,
    intent.proposalDigest,
    { symbol: chain.nativeSymbol, decimals: chain.nativeDecimals },
    amountHuman,
    (client) => recheckAuthorityWrapped(anchor, client),
  );
  if (!claimed.ok) {
    if (claimed.reason === "fence_refused") return wrapRefusalToResult(claimed.refusal);
    return wrapRefusalToResult({
      code: "invalid_input",
      message:
        `Refusing to sign: wrap intent ${intent.intentId} could not be claimed because `
        + `${claimed.detail}. Nothing was signed and no funds moved.`,
      details: { intentId: intent.intentId },
    });
  }

  const executed = await executeWrap({
    intent: claimed.intent,
    transaction,
    loadSigner,
    anchor,
    bounds,
    activity: claimed.activity,
    deps,
  });

  return settleWrapExecution(
    claimed.intent,
    claimed.activity,
    executed.execution,
    executed.verdict,
    {
      chain: intent.chainAlias,
      chainId: intent.chainId,
      direction: intent.direction,
      amountRaw: intent.amountRaw,
      amountHuman,
      wrappedNativeContract: intent.contract,
      approvedFeeBounds: intent.feeBounds,
    },
  );
}

/** The authority recheck, in the shape the wrap claim transaction expects. */
async function recheckAuthorityWrapped(
  anchor: AuthorityAnchor,
  client: Parameters<typeof recheckAuthorityWith>[0],
): Promise<WrapOutcome<void>> {
  const fenced = await recheckAuthorityWith(client, anchor, "claim");
  if (fenced.ok) return accept(undefined);
  return refuse("invalid_input", fenced.refusal.message, fenced.refusal.details);
}

/**
 * Sign, stage, submit, classify, and decode the receipt.
 *
 * The receipt decode happens HERE, on the confirmed arm, because this is the
 * only place the real logs exist. Its result travels to the settlement so a wrap
 * row is confirmed WITH both executed legs, which `confirmActivityEvent`
 * requires for this kind.
 */
async function executeWrap(args: {
  readonly intent: WalletWrapIntent;
  readonly transaction: WrapTransaction;
  readonly loadSigner: () => WrapSignerLoad;
  readonly anchor: AuthorityAnchor;
  readonly bounds: StagedFeeBounds;
  readonly activity: WrapActivity;
  readonly deps: WrapConfirmDeps;
}): Promise<{
  readonly execution: TransactionExecution;
  readonly verdict: WrapReceiptVerdict;
}> {
  const { intent, transaction, loadSigner, anchor, bounds, activity, deps } = args;

  let clients: EvmSignerClients;
  try {
    clients = await deps.signerClientsFactory(intent.chainAlias);
  } catch (cause) {
    return {
      execution: preBroadcast(
        cause,
        "The conversion could not be prepared for signing because its chain clients could not be "
        + "built. Nothing was signed and nothing was broadcast.",
      ),
      verdict: UNDECODED,
    };
  }

  let stagingFailed = false;
  let fenceRefusal: WrapRefusal | null = null;

  const deferredSigner: DeferredEvmSigner = {
    kind: "deferred",
    address: intent.walletAddress as `0x${string}`,
    chain: clients.chain,
    // FENCE POINT (b). After the estimate, the request preparation and the
    // fee-bound check, and BEFORE any key exists.
    //
    // TWO questions are asked here, and they are different questions. The
    // authority fence asks "may this actor still sign anything at all"; the
    // final-request gate asks "are these the BYTES that were approved". The
    // second is asked of the object the signature is taken over, because the
    // request that reaches the signer comes out of `prepareTransactionRequest`
    // and is not the triple this closure captured. Authority is checked first:
    // a revoked actor is refused without any comparison being reported.
    onBeforeSign: async (request) => {
      const fenced = await recheckAuthority(anchor, "pre_sign");
      if (!fenced.ok) {
        fenceRefusal = {
          code: "invalid_input",
          message: fenced.refusal.message,
          details: fenced.refusal.details,
        };
        throw new FenceRefused("authority fence refused before signing");
      }
      const drift = verifyFinalWrapRequest(request, intent, bounds);
      if (drift !== null) {
        fenceRefusal = drift;
        throw new FenceRefused("the final request does not match the approved wrap");
      }
    },
    // The key is decrypted HERE and nowhere earlier, immediately before the
    // signature, with no provider call in between.
    createSigner: async () => {
      const loaded = loadSigner();
      if (loaded.kind === "return") {
        fenceRefusal = {
          code: "invalid_input",
          message:
            "Refusing to sign: the wallet this conversion was approved for could not be resolved for "
            + "signing. Nothing was signed and no funds moved.",
          details: { intentId: intent.intentId },
        };
        throw new FenceRefused("signer could not be loaded");
      }
      return clients.createWalletClient(loaded.signer);
    },
  };

  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(
      clients.publicClient,
      deferredSigner,
      {
        to: transaction.to,
        data: transaction.data,
        value: BigInt(transaction.valueWei),
      },
      {
        onNonceReserved: (request) => activity.reserveEvmNonce(request),
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
          // succeeded, and what stopped the broadcast is the authority being
          // revoked while it was being written. Nothing has been submitted.
          const fenced = await recheckAuthority(anchor, "pre_submit");
          if (!fenced.ok) {
            fenceRefusal = {
              code: "invalid_input",
              message: fenced.refusal.message,
              details: fenced.refusal.details,
            };
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
    if (cause instanceof FenceRefused && fenceRefusal !== null) {
      const refusal: WrapRefusal = fenceRefusal;
      return {
        execution: {
          kind: "pre_broadcast_failed",
          errorKind: "AuthorityFenceRefused",
          errorHash: createHash("sha256")
            .update(`wrap-fence:${intent.intentId}:${refusal.details?.fencePoint ?? "unknown"}`)
            .digest("hex")
            .slice(0, 16),
          message: refusal.message,
        },
        verdict: UNDECODED,
      };
    }
    // EVERY throw out of `signStageBroadcast` is PRE-SUBMISSION: the estimate,
    // the bounds check, the preparation, the signature, or the staging hook.
    if (cause instanceof StagedFeeBoundsExceededError) {
      logger.warn("wallet.wrap.fee_bounds_exceeded", {
        intentId: intent.intentId,
        field: cause.field,
      });
      return {
        execution: preBroadcast(
          cause,
          `Refusing to sign: the prepared conversion's ${cause.field} is ${cause.actual}, above the `
          + `${cause.approved} that was approved. Nothing was signed and nothing was broadcast. `
          + "Prepare the conversion again with caps that cover the current network price, and the "
          + "user will see and approve the new ceiling.",
        ),
        verdict: UNDECODED,
      };
    }
    if (stagingFailed) {
      return {
        execution: {
          ...preBroadcast(
            cause,
            "The durable record of this conversion could not be written, so Vex refused to broadcast "
            + "it. Nothing was broadcast and no funds moved. This is a Vex-side audit failure, not a "
            + "chain rejection.",
          ),
          auditFailed: true,
        },
        verdict: UNDECODED,
      };
    }
    return {
      execution: preBroadcast(
        cause,
        "The conversion failed before it was broadcast, so nothing reached the network and no funds "
        + "moved. Preparing it again is safe.",
      ),
      verdict: UNDECODED,
    };
  }

  if (outcome.kind === "ambiguous") {
    return {
      execution: {
        kind: "confirmation_unknown",
        txHash: outcome.txHash,
        chain: clients.chainName,
        errorKind: "ConfirmationUnknown",
        errorHash: createHash("sha256")
          .update(`wrap-ambiguous:${outcome.stage}:${outcome.reason}`)
          .digest("hex")
          .slice(0, 16),
      },
      verdict: UNDECODED,
    };
  }

  if (outcome.kind === "reverted") {
    return {
      execution: {
        kind: "chain_failed",
        txHash: outcome.txHash,
        chain: clients.chainName,
        errorKind: "ChainRevert",
        errorHash: createHash("sha256").update(`wrap-revert:${outcome.txHash}`).digest("hex").slice(0, 16),
      },
      verdict: UNDECODED,
    };
  }

  // The receipt's own logs, decoded against the bound contract and wallet. The
  // declared value is the signed transaction's own, which is what makes a wrap's
  // native input provable: a native movement emits no log.
  const decoded = decodeWrapSettlement({
    logs: outcome.receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
    })),
    walletAddress: intent.walletAddress,
    contractAddress: intent.contract.address,
    direction: intent.direction,
    amountRaw: intent.amountRaw,
    declaredValueRaw: transaction.valueWei,
  });

  return {
    execution: {
      kind: "confirmed",
      txHash: outcome.txHash,
      data: { chain: clients.chainName },
    },
    verdict: decoded,
  };
}

function preBroadcast(
  cause: unknown,
  message: string,
): Extract<TransactionExecution, { kind: "pre_broadcast_failed" }> {
  const sum = summarizeWalletError(cause);
  return {
    kind: "pre_broadcast_failed",
    errorKind: sum.errorKind,
    errorHash: sum.errorHash,
    message,
  };
}
