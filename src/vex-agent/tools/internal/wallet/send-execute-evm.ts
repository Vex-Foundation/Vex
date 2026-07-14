/**
 * Wallet send — EVM executor (multi-chain via Khalani).
 *
 * Refactor of the pre-phase-4 `executeEvmTransfer`: `hash` lives in the
 * outer scope so a `waitForTransactionReceipt` failure can return
 * `chain_failed` / `confirmation_unknown` with the hash intact (Codex
 * puzzle-5 phase-4 review v3 acceptance).
 */

import { createHash } from "node:crypto";

import type { EvmWallet } from "@tools/wallet/multi-auth.js";

import type { WalletIntent } from "@vex-agent/db/repos/wallet-intents.js";

import {
  preBroadcastFailed,
  summarizeWalletError,
  type ExecuteOutcome,
} from "./send-types.js";

export async function executeEvmTransfer(
  intent: WalletIntent,
  wallet: EvmWallet,
): Promise<ExecuteOutcome> {
  let publicClient;
  let chainName: string;
  let tokenSymbol: string;
  let hash: `0x${string}`;
  let isNftTransfer = false;

  // Setup + broadcast — any throw is pre-broadcast.
  try {
    const { parseUnits, getAddress } = await import("viem");
    const { resolveInclusiveEvmChain } = await import(
      "@tools/evm-chains/resolver.js"
    );

    if (intent.chainAlias === null) {
      return preBroadcastFailed(
        new Error("Missing chain for eip155 transfer"),
      );
    }

    // Inclusive resolver (LOCKED correction #2): a Khalani-registered chain keeps
    // the Khalani client path (byte-identical to before); a local-registry chain
    // (e.g. Robinhood Chain 4663) resolves a viem wallet client with NO Khalani
    // dependency.
    const resolved = await resolveInclusiveEvmChain(intent.chainAlias);
    let walletClient;
    let nativeDecimals: number;
    if (resolved.source === "khalani") {
      const { createDynamicPublicClient, createDynamicWalletClient } =
        await import("@tools/khalani/evm-client.js");
      publicClient = createDynamicPublicClient(
        resolved.khalaniChain,
        resolved.khalaniChains,
      );
      walletClient = createDynamicWalletClient(
        resolved.khalaniChain,
        resolved.khalaniChains,
        wallet.privateKey as `0x${string}`,
      );
      chainName = resolved.khalaniChain.name || intent.chainAlias;
      tokenSymbol = resolved.khalaniChain.nativeCurrency.symbol;
      nativeDecimals = resolved.khalaniChain.nativeCurrency.decimals;
    } else {
      const { getLocalEvmClients } = await import(
        "@tools/evm-chains/evm-client.js"
      );
      const clients = getLocalEvmClients(
        resolved.config,
        wallet.privateKey as `0x${string}`,
      );
      publicClient = clients.publicClient;
      walletClient = clients.walletClient;
      chainName = resolved.config.name || intent.chainAlias;
      tokenSymbol = resolved.config.nativeCurrency.symbol;
      nativeDecimals = resolved.config.nativeCurrency.decimals;
    }

    const isNft = intent.token?.startsWith("nft:");
    isNftTransfer = isNft === true;
    const isNative = intent.token === null || intent.token === "native";

    if (isNative) {
      const value = parseUnits(intent.amount, nativeDecimals);
      hash = await walletClient.sendTransaction({
        to: getAddress(intent.toAddress),
        value,
        chain: undefined,
      });
    } else if (isNft) {
      const parts = intent.token!.split(":");
      const nftContract = getAddress(parts[1]);
      const nftTokenId = BigInt(parts[2]);
      tokenSymbol = `NFT#${nftTokenId}`;
      hash = await walletClient.writeContract({
        address: nftContract,
        abi: [
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
        ] as const,
        functionName: "safeTransferFrom",
        args: [
          wallet.address as `0x${string}`,
          getAddress(intent.toAddress),
          nftTokenId,
        ],
        chain: undefined,
      });
    } else {
      const tokenAddress = getAddress(intent.token!);
      tokenSymbol = intent.token!;
      const decimals = await publicClient.readContract({
        address: tokenAddress,
        abi: [
          {
            inputs: [],
            name: "decimals",
            outputs: [{ type: "uint8" }],
            stateMutability: "view",
            type: "function",
          },
        ] as const,
        functionName: "decimals",
      });
      const value = parseUnits(intent.amount, decimals);
      hash = await walletClient.writeContract({
        address: tokenAddress,
        abi: [
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
        ] as const,
        functionName: "transfer",
        args: [getAddress(intent.toAddress), value],
        chain: undefined,
      });
    }
  } catch (cause) {
    return preBroadcastFailed(cause);
  }

  // Broadcast happened — `hash` is set. Receipt-wait throws are
  // confirmation_unknown; receipt.status !== 'success' is chain_failed.
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      const errorHash = createHash("sha256")
        .update(`evm-revert:${hash}`)
        .digest("hex")
        .slice(0, 16);
      return {
        kind: "chain_failed",
        txHash: hash,
        chain: chainName,
        errorKind: "ChainRevert",
        errorHash,
      };
    }
    return {
      kind: "confirmed",
      txHash: hash,
      data: {
        // Curated, cross-network-normalised projection (see
        // formatWalletSendOutput in send/finalize.ts): `txHash` + `chain` +
        // `status` mirror the Solana executor; `blockNumber` is EVM-specific
        // and always present on a confirmed receipt. `chain` is the
        // human-readable network name, consistent with _tradeCapture.chain.
        txHash: hash,
        chain: chainName,
        status: "confirmed",
        blockNumber: Number(receipt.blockNumber),
        // Full capture stays intact for the sync/activity pipeline — it keeps
        // the dropped-from-output fields (signature, in/out token+amount,
        // walletAddress) under _tradeCapture.
        _tradeCapture: {
          type: isNftTransfer ? "send" : "transfer",
          chain: chainName,
          status: "executed",
          inputToken: tokenSymbol,
          inputAmount: intent.amount,
          outputToken: tokenSymbol,
          outputAmount: intent.amount,
          signature: hash,
          walletAddress: wallet.address,
        },
      },
    };
  } catch (cause) {
    const sum = summarizeWalletError(cause);
    return {
      kind: "confirmation_unknown",
      txHash: hash,
      chain: chainName,
      errorKind: sum.errorKind,
      errorHash: sum.errorHash,
    };
  }
}
