/**
 * Wallet send - EVM executor (multi-chain via Khalani).
 *
 * STAGED SINCE MIGRATION 084. This executor no longer calls `sendTransaction` /
 * `writeContract`, which sign and submit in one indivisible step and therefore
 * cannot produce a durable record before the funds move. It now:
 *
 *   1. resolves ONE exact plan (numeric chain id, token identity, and the atomic
 *      amount as a single `bigint`);
 *   2. opens the durable `agent_activity` row BEFORE anything is signed;
 *   3. signs LOCALLY, stages the hash + sender + nonce, and only THEN submits
 *      the signed bytes, once - through `signStageBroadcast`, the same
 *      venue-agnostic primitive every EVM protocol handler here already uses;
 *   4. finalizes from a DEFINITIVE receipt, and leaves the row `pending` when
 *      the outcome is ambiguous. Nothing is ever re-sent.
 *
 * WHAT CHANGED ABOUT GAS, stated rather than buried: `signStageBroadcast`
 * estimates explicitly and signs with headroom, where `sendTransaction` signed
 * viem's bare estimate. That raises the gas LIMIT - a ceiling - and not the fee,
 * which the chain charges on gas USED either way. It is the same treatment every
 * other signing path in this repository already gets.
 *
 * `hash` still lives in the outer scope so a receipt failure can return
 * `chain_failed` / `confirmation_unknown` with the hash intact.
 */

import { createHash } from "node:crypto";

import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import {
  signStageBroadcast,
  type StagedBroadcastOutcome,
} from "@tools/evm-chains/staged-broadcast.js";

import type { WalletIntent } from "@vex-agent/db/repos/wallet-intents.js";
import logger from "@utils/logger.js";

import {
  preBroadcastFailed,
  summarizeWalletError,
  type ExecuteOutcome,
} from "./send-types.js";
import {
  proveErc20Transfer,
  proveErc721Transfer,
  type ReceiptLog,
} from "./send/transfer-settlement.js";
import {
  openWalletTransferActivity,
  recordWalletTransferPlanFailure,
  type WalletTransferActivity,
  type WalletTransferPlan,
} from "./send/activity-writer.js";

const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const ERC721_SAFE_TRANSFER_ABI = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    name: "safeTransferFrom",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const ERC20_DECIMALS_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export async function executeEvmTransfer(
  intent: WalletIntent,
  wallet: EvmWallet,
): Promise<ExecuteOutcome> {
  const resolved = await resolveEvmTransferPlan(intent, wallet);
  if (!resolved.ok) {
    // No intent row exists yet, so this is the ONE arm that writes a hashless
    // terminal row. Nothing was signed and nothing was sent.
    await recordWalletTransferPlanFailure(intent, {
      failureCode: resolved.failureCode,
      failureReason: resolved.failureReason,
      chainId: resolved.chainId,
      chainFamily: "eip155",
    });
    return preBroadcastFailed(resolved.cause);
  }

  const { plan, chainName, publicClient, walletClient, txParams, proof: txProof } = resolved;

  // The durable row BEFORE anything is signed. A failure here means we have no
  // record, so we must not sign: returning pre-broadcast is the safe direction.
  let activity: WalletTransferActivity;
  try {
    activity = await openWalletTransferActivity(intent, plan);
  } catch (cause) {
    logger.warn("wallet.send.activity_intent_write_failed", {
      intentId: intent.intentId, ...summarizeWalletError(cause),
    });
    return preBroadcastFailed(cause);
  }

  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(
      publicClient,
      walletClient,
      txParams,
      {
        // Persist hash + sender + nonce BEFORE the signed bytes are sent. A CAS
        // miss THROWS out of here, and `signStageBroadcast` has not submitted
        // anything at that point - refusing to broadcast an untracked transfer.
        onHashStaged: (handles) => activity.stageEvm(handles),
        onAccepted: () => activity.noteAccepted(),
      },
    );
  } catch (cause) {
    // Every throw from `signStageBroadcast` is PRE-submission (estimate,
    // prepare, sign, or the staging hook). "Definitely not attempted" is a
    // definitive outcome, so it finalizes the EXISTING row - never a second one.
    const sum = summarizeWalletError(cause);
    await activity.fail({
      failureCode: "broadcast_error",
      failureReason: `PreBroadcast:${sum.errorKind}:${sum.errorHash}`,
    });
    await activity.completeExecution({ kind: "failed_before_broadcast" });
    return preBroadcastFailed(cause);
  }

  if (outcome.kind === "ambiguous") {
    // NOTHING TERMINAL, on EITHER stage. A send whose RPC reply never confirmed
    // it reached the mempool and a receipt that could not be read are both
    // unknown, not failed, and the transaction may be settling right now. The
    // ACTIVITY row stays `pending` for the repair sweep, and nothing is
    // re-sent, ever.
    //
    // The EXECUTION row is completed all the same: the tool attempt is over
    // the moment this returns, and the compaction
    // safe-moment gate selects an `execution_status = 'intent'` row on its own,
    // so leaving it open would block compaction forever - even after the sweep
    // resolved the activity row. `success: false` plus a structural
    // `confirmation_unknown` records what the tool reported; the pending
    // activity row is what still says the CHAIN state is unknown.
    await activity.completeExecution({
      kind: "confirmation_unknown",
      txHash: outcome.txHash,
    });
    return {
      kind: "confirmation_unknown",
      txHash: outcome.txHash,
      chain: chainName,
      errorKind: "ConfirmationUnknown",
      errorHash: createHash("sha256")
        .update(`evm-ambiguous:${outcome.stage}:${outcome.reason}`)
        .digest("hex")
        .slice(0, 16),
    };
  }

  if (outcome.kind === "reverted") {
    await activity.fail({
      failureCode: "mined_revert",
      failureReason: "the transfer transaction reverted on-chain",
    });
    await activity.completeExecution({ kind: "reverted", txHash: outcome.txHash });
    return {
      kind: "chain_failed",
      txHash: outcome.txHash,
      chain: chainName,
      errorKind: "ChainRevert",
      errorHash: createHash("sha256")
        .update(`evm-revert:${outcome.txHash}`)
        .digest("hex")
        .slice(0, 16),
    };
  }

  // WHAT THE RECEIPT PROVES depends on the asset. A native send moves exactly
  // `tx.value` by protocol rule, so inclusion is
  // proof. An ERC-20 `transfer` returns `bool`: a nonconforming token can answer
  // `false`, and a fee-on-transfer token can deliver less, WITHOUT reverting -
  // so its amount is proven only by the receipt's own `Transfer` log. Unproven
  // is recorded as unproven, never as the requested amount.
  const provenAmountRaw = proveEvmTransferAmount(plan, txProof, outcome.receipt.logs);
  const blockTimeIso = await readBlockTimeIso(publicClient, outcome.receipt.blockNumber);
  await activity.confirm({
    txHash: outcome.txHash,
    provenAmountRaw,
    ...(blockTimeIso === null ? {} : { blockTimeIso }),
  });
  await activity.completeExecution({
    kind: "confirmed",
    txHash: outcome.txHash,
    ...(blockTimeIso === null ? {} : { blockTimeIso }),
  });

  return {
    kind: "confirmed",
    txHash: outcome.txHash,
    data: {
      // Curated, cross-network-normalised projection (see formatWalletSendOutput
      // in send/finalize.ts): `txHash` + `chain` + `status` mirror the Solana
      // executor; `blockNumber` is EVM-specific and always present on a
      // confirmed receipt. `chain` is the human-readable network name.
      txHash: outcome.txHash,
      chain: chainName,
      status: "confirmed",
      blockNumber: Number(outcome.receipt.blockNumber),
      // The durable record of this transfer is its own `agent_activity` row
      // (migration 084), written by `send/activity-writer.ts` before the
      // transaction was signed. `_executionId` names the `protocol_executions`
      // row this path already opened AND completed itself - the internal tool
      // route never reaches `protocols/runtime/capture.ts`, which is why the
      // writer owns that completion. It rides here for correlation, and so that
      // any future consumer of the standard threading contract reuses this row
      // instead of creating a second one.
      _executionId: activity.executionId,
      // The explorer link, through the EXPLICIT channel the failure arms
      // already use. It replaces the `_tradeCapture` blob this path used to
      // emit: that blob's comment claimed it fed "the sync/activity pipeline",
      // which never ran on the internal tool route - `deriveExplorerRefs` was
      // its only reader, and this states the same fact without the fiction.
      _explorerRefs: [{ chain: chainName, txRef: outcome.txHash }],
    },
  };
}

/** The block's own time, or `null` when the node will not give it. Never a guess. */
async function readBlockTimeIso(
  publicClient: { getBlock: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }> },
  blockNumber: bigint,
): Promise<string | null> {
  try {
    const block = await publicClient.getBlock({ blockNumber });
    return new Date(Number(block.timestamp) * 1000).toISOString();
  } catch (cause) {
    // Precision of a later report, never a money fact - see
    // `agent-activity/settled-block-time.ts`.
    logger.warn("wallet.send.block_time_read_failed", summarizeWalletError(cause));
    return null;
  }
}

/** The receipt evidence that settles each asset kind. See `transfer-settlement.ts`. */
type EvmTransferProof =
  /** Inclusion IS the proof: the protocol moves `tx.value` itself. */
  | { readonly asset: "native" }
  | { readonly asset: "erc20"; readonly tokenAddress: string; readonly from: string; readonly to: string }
  | {
      readonly asset: "erc721";
      readonly contractAddress: string;
      readonly from: string;
      readonly to: string;
      readonly tokenId: bigint;
    };

/**
 * The amount this receipt PROVED moved, or `null` when it proved none.
 *
 * Native is proven by inclusion. ERC-20 and ERC-721 are proven only by a
 * matching `Transfer` log, because neither `transfer` returning `false` nor a
 * fee-on-transfer shortfall reverts the transaction.
 */
function proveEvmTransferAmount(
  plan: WalletTransferPlan,
  proof: EvmTransferProof,
  logs: readonly ReceiptLog[],
): bigint | null {
  switch (proof.asset) {
    case "native":
      return plan.amountRaw;
    case "erc20":
      return proveErc20Transfer({
        logs,
        tokenAddress: proof.tokenAddress,
        from: proof.from,
        to: proof.to,
        expectedAmountRaw: plan.amountRaw,
      });
    case "erc721":
      return proveErc721Transfer({
        logs,
        contractAddress: proof.contractAddress,
        from: proof.from,
        to: proof.to,
        tokenId: proof.tokenId,
      });
  }
}

type ResolvedEvmTransfer =
  | {
      readonly ok: true;
      readonly plan: WalletTransferPlan;
      readonly chainName: string;
      // Typed from the primitive that consumes them, so the resolver cannot
      // hand `signStageBroadcast` a client shape it does not accept.
      readonly publicClient: Parameters<typeof signStageBroadcast>[0];
      readonly walletClient: Parameters<typeof signStageBroadcast>[1];
      readonly txParams: Parameters<typeof signStageBroadcast>[2];
      /**
       * What a confirmed receipt has to show before this transfer's amount may
       * be recorded as EXECUTED. Carried from the resolver because only it knows
       * which asset was built, and matched against the receipt's own logs at
       * confirmation time (`proveEvmTransferAmount`).
       */
      readonly proof: EvmTransferProof;
    }
  | {
      readonly ok: false;
      readonly cause: unknown;
      readonly failureCode: "chain_unsupported" | "unknown";
      readonly failureReason: string;
      /** `0` when the chain itself is what could not be resolved - the row records that it is unknown. */
      readonly chainId: number;
    };

/**
 * Resolve EXACTLY ONE unsigned transfer: chain identity, token identity, the
 * atomic amount, and the calldata that spends it. Everything the durable row
 * needs and everything the transaction needs, derived together from the same
 * values, so the row can never describe a different transfer from the one that
 * is signed.
 */
async function resolveEvmTransferPlan(
  intent: WalletIntent,
  wallet: EvmWallet,
): Promise<ResolvedEvmTransfer> {
  const { parseUnits, formatUnits, getAddress, encodeFunctionData } = await import("viem");
  const { resolveInclusiveEvmChain } = await import("@tools/evm-chains/resolver.js");

  if (intent.chainAlias === null) {
    const cause = new Error("Missing chain for eip155 transfer");
    return {
      ok: false, cause, chainId: 0,
      failureCode: "chain_unsupported",
      failureReason: "no chain was named for an eip155 transfer",
    };
  }

  let chainId = 0;
  try {
    // Inclusive resolver: a Khalani-registered chain keeps the Khalani client
    // path; a local-registry chain (e.g. Robinhood Chain 4663) resolves a viem
    // wallet client with NO Khalani dependency.
    const resolved = await resolveInclusiveEvmChain(intent.chainAlias);
    chainId = resolved.chainId;

    let publicClient;
    let walletClient;
    let chainName: string;
    let nativeSymbol: string;
    let nativeDecimals: number;
    if (resolved.source === "khalani") {
      const { createDynamicPublicClient, createDynamicWalletClient } =
        await import("@tools/khalani/evm-client.js");
      publicClient = createDynamicPublicClient(resolved.khalaniChain, resolved.khalaniChains);
      walletClient = createDynamicWalletClient(
        resolved.khalaniChain,
        resolved.khalaniChains,
        wallet.privateKey as `0x${string}`,
      );
      chainName = resolved.khalaniChain.name || intent.chainAlias;
      nativeSymbol = resolved.khalaniChain.nativeCurrency.symbol;
      nativeDecimals = resolved.khalaniChain.nativeCurrency.decimals;
    } else {
      const { getLocalEvmClients } = await import("@tools/evm-chains/evm-client.js");
      const clients = getLocalEvmClients(resolved.config, wallet.privateKey as `0x${string}`);
      publicClient = clients.publicClient;
      walletClient = clients.walletClient;
      chainName = resolved.config.name || intent.chainAlias;
      nativeSymbol = resolved.config.nativeCurrency.symbol;
      nativeDecimals = resolved.config.nativeCurrency.decimals;
    }

    const to = getAddress(intent.toAddress);
    const token = intent.token;
    const isNative = token === null || token === "native";

    const base = {
      chainId,
      chainSlug: intent.chainAlias,
      chainFamily: "eip155",
    } as const;

    if (isNative) {
      // The ONE bigint: signed as `value`, recorded as `amount_in_raw`.
      const amountRaw = parseUnits(intent.amount, nativeDecimals);
      return {
        ok: true,
        chainName,
        publicClient,
        walletClient,
        txParams: { to, data: "0x", value: amountRaw },
        proof: { asset: "native" },
        plan: {
          ...base,
          // The chain-agnostic native sentinel is the right IDENTITY (one value
          // on every chain); the chain's real symbol is the right LABEL.
          tokenAddress: NATIVE_TOKEN_ADDRESS,
          tokenSymbol: nativeSymbol,
          tokenDecimals: nativeDecimals,
          amountRaw,
          amountHuman: formatUnits(amountRaw, nativeDecimals),
        },
      };
    }

    if (token.startsWith("nft:")) {
      // `nft:<contract>:<tokenId>`. Parsed with a real check rather than three
      // non-null assertions: a malformed identity must be refused by NAME here,
      // not discovered as an opaque throw from `getAddress(undefined)`.
      const [, contractPart, tokenIdPart] = token.split(":");
      if (contractPart === undefined || tokenIdPart === undefined) {
        throw new Error("malformed NFT token identity: expected nft:<contract>:<tokenId>");
      }
      const nftContract = getAddress(contractPart);
      const nftTokenId = BigInt(tokenIdPart);
      // ONE item, indivisible. The identity is the CONTRACT - never a
      // synthesized `nft:contract:id` pseudo-address, which is not an address
      // and would poison every join that reads this column - and the token id
      // travels in the symbol, where a non-fungible identity belongs.
      const amountRaw = 1n;
      return {
        ok: true,
        chainName,
        publicClient,
        walletClient,
        txParams: {
          to: nftContract,
          data: encodeFunctionData({
            abi: ERC721_SAFE_TRANSFER_ABI,
            functionName: "safeTransferFrom",
            args: [getAddress(wallet.address), to, nftTokenId],
          }),
          value: 0n,
        },
        proof: {
          asset: "erc721",
          contractAddress: nftContract,
          from: getAddress(wallet.address),
          to,
          tokenId: nftTokenId,
        },
        plan: {
          ...base,
          tokenAddress: nftContract,
          tokenSymbol: `NFT#${nftTokenId}`,
          tokenDecimals: 0,
          amountRaw,
          amountHuman: "1",
        },
      };
    }

    const tokenAddress = getAddress(token);
    const decimals = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals",
    });
    const amountRaw = parseUnits(intent.amount, decimals);
    return {
      ok: true,
      chainName,
      publicClient,
      walletClient,
      txParams: {
        to: tokenAddress,
        data: encodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [to, amountRaw],
        }),
        value: 0n,
      },
      proof: {
        asset: "erc20",
        tokenAddress,
        from: getAddress(wallet.address),
        to,
      },
      plan: {
        ...base,
        tokenAddress,
        tokenSymbol: tokenAddress,
        tokenDecimals: decimals,
        amountRaw,
        amountHuman: formatUnits(amountRaw, decimals),
      },
    };
  } catch (cause) {
    const sum = summarizeWalletError(cause);
    return {
      ok: false,
      cause,
      chainId,
      failureCode: "unknown",
      failureReason: `PlanUnresolved:${sum.errorKind}:${sum.errorHash}`,
    };
  }
}
