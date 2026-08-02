/**
 * Chain read tool — on-chain EVM forensics via inclusive chain discovery + viem
 * public client.
 *
 * Read-only, scoped actions:
 *   tx_receipt   — transaction receipt (status, gasUsed, logs count)
 *   erc721_mint  — extract minted NFT IDs from receipt logs
 *
 * Native balances are owned by `wallet_balances`; token metadata
 * (decimals/symbol/name) by `token_find` (khalani.tokens.search).
 *
 * Chain resolution is INCLUSIVE (`resolveInclusiveEvmChain`, same seam
 * `wallet_balances` uses): Khalani-registry chains keep the dynamic Khalani
 * client; chains only the local EVM registry knows (e.g. Robinhood Chain 4663)
 * read direct-RPC through `getLocalPublicClient`. This widens READ-ONLY
 * forensics only — quote/bridge paths must keep the STRICT Khalani resolver so
 * a local-only chain can never look Khalani-supported.
 */

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { missingOrWrongTypeMessage } from "./types.js";
import { resolveInclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { createDynamicPublicClient } from "@tools/khalani/evm-client.js";
import { extractMintedNftId } from "@tools/kyberswap/evm-utils.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";

type DynamicPublicClient = ReturnType<typeof createDynamicPublicClient>;

function str(p: Record<string, unknown>, k: string): string {
  const v = p[k]; return typeof v === "string" ? v : "";
}

export async function handleChainRead(
  params: Record<string, unknown>,
  _context: InternalToolContext,
): Promise<ToolResult> {
  const action = str(params, "action");
  const chainIdRaw = str(params, "chainId");

  if (!action) {
    return {
      success: false,
      output: missingOrWrongTypeMessage(params, "action", 'a string ("tx_receipt" or "erc721_mint")'),
    };
  }
  if (!chainIdRaw) {
    return {
      success: false,
      output: missingOrWrongTypeMessage(
        params,
        "chainId",
        'a chain slug or the STRING spelling of a chain id (e.g. "base" or "8453")',
      ),
    };
  }

  // Resolve chain (Khalani first, local registry as fallback). Any throw here
  // (unsupported chain, RPC discovery, provider/SDK error) is reduced to a
  // redacted, bounded summary so raw viem/RPC text — which can carry URLs,
  // request/response bodies, or key material — never reaches the model output
  // (B-003).
  let chainId: number;
  let chainName: string;
  let client: DynamicPublicClient;
  try {
    const resolved = await resolveInclusiveEvmChain(chainIdRaw);
    chainId = resolved.chainId;
    if (resolved.source === "khalani") {
      chainName = resolved.khalaniChain.name;
      client = createDynamicPublicClient(resolved.khalaniChain, resolved.khalaniChains);
    } else {
      chainName = resolved.config.name;
      client = getLocalPublicClient(resolved.config);
    }
  } catch (err) {
    return { success: false, output: summarizeProtocolError(err).message };
  }

  switch (action) {
    case "tx_receipt": {
      const txHash = str(params, "txHash");
      if (!txHash) return { success: false, output: "Missing required: txHash" };

      let receipt: Awaited<ReturnType<DynamicPublicClient["getTransactionReceipt"]>>;
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
      } catch (err) {
        return { success: false, output: summarizeProtocolError(err).message };
      }
      return {
        success: true,
        output: JSON.stringify({
          chain: chainName,
          chainId,
          txHash,
          status: receipt.status,
          blockNumber: Number(receipt.blockNumber),
          gasUsed: receipt.gasUsed.toString(),
          logsCount: receipt.logs.length,
          from: receipt.from,
          to: receipt.to,
          contractAddress: receipt.contractAddress,
        }, null, 2),
      };
    }

    case "erc721_mint": {
      const txHash = str(params, "txHash");
      const recipient = str(params, "address");
      if (!txHash) return { success: false, output: "Missing required: txHash" };

      let receipt: Awaited<ReturnType<DynamicPublicClient["getTransactionReceipt"]>>;
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
      } catch (err) {
        return { success: false, output: summarizeProtocolError(err).message };
      }
      const logs = receipt.logs.map(l => ({
        address: l.address,
        topics: l.topics as string[],
        data: l.data,
      }));

      // If recipient given, filter to that address; otherwise find any mint
      const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

      const mints: Array<{ contract: string; tokenId: string; to: string }> = [];
      for (const log of logs) {
        if (
          log.topics[0] === TRANSFER_TOPIC &&
          log.topics.length === 4 &&
          log.topics[1] === ZERO
        ) {
          const to = "0x" + (log.topics[2]?.slice(26) ?? "");
          if (recipient && to.toLowerCase() !== recipient.toLowerCase()) continue;
          mints.push({
            contract: log.address,
            tokenId: BigInt(log.topics[3]).toString(),
            to,
          });
        }
      }

      // Also provide filtered result via extractMintedNftId if recipient given
      const primaryNftId = recipient ? extractMintedNftId(logs, recipient) : mints[0]?.tokenId;

      return {
        success: true,
        output: JSON.stringify({
          chain: chainName,
          chainId,
          txHash,
          mintsFound: mints.length,
          primaryNftId: primaryNftId ?? null,
          mints,
        }, null, 2),
      };
    }

    default:
      return { success: false, output: `Unknown action: ${action}. Valid: tx_receipt, erc721_mint` };
  }
}
