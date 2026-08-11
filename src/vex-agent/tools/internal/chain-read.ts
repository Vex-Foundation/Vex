/**
 * Chain read tool — on-chain EVM forensics via inclusive chain discovery + viem
 * public client.
 *
 * Read-only, scoped actions:
 *   tx_receipt    - transaction receipt (status, gasUsed, logs count)
 *   erc721_mint   - extract minted NFT IDs from receipt logs
 *   erc20_balance - direct `balanceOf` for one token and one owner
 *
 * `erc20_balance` is the ONE-contract question `wallet_balances` cannot answer:
 * that tool reports a scan-set projection, while this asks the token itself.
 * The live TOM incident (2026-08-10) turned on that difference - a confirmed
 * buy with a decodable Transfer log and a wallet balance of zero.
 *
 * Native balances are owned by `wallet_balances`; token symbol/name by
 * `token_find` (khalani.tokens.search).
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
import { readErc20Balance, readErc20Decimals } from "@tools/evm-chains/erc20-reads.js";
import {
  resolveSelectedAddressForRead,
  walletScopeErrorToResult,
} from "@vex-agent/tools/internal/wallet/resolve.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { formatUnits, getAddress, type Address } from "viem";

type DynamicPublicClient = ReturnType<typeof createDynamicPublicClient>;

function str(p: Record<string, unknown>, k: string): string {
  const v = p[k]; return typeof v === "string" ? v : "";
}

/**
 * Model-supplied addresses are untrusted text. A rejection therefore names the
 * PARAMETER and the expected shape, never the value: echoing it back would put
 * arbitrary attacker-authored content into the next turn's context.
 */
function parseAddressParam(raw: string): Address | null {
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

export async function handleChainRead(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const action = str(params, "action");
  const chainRaw = str(params, "chain");

  if (!action) {
    return {
      success: false,
      output: missingOrWrongTypeMessage(params, "action", 'a string ("tx_receipt", "erc721_mint" or "erc20_balance")'),
    };
  }
  // W6a renamed `chainId` → `chain`. Internal tools have no strict unknown-key
  // gate, so an unrenamed call would silently drop the value and be answered
  // with "Missing required: chain" — an accusation the caller cannot act on,
  // because it DID send a chain. Refuse the old spelling by name and name the
  // replacement, which is correctable in one turn.
  if (!chainRaw && params["chainId"] !== undefined) {
    return {
      success: false,
      output:
        'chain_read no longer takes "chainId" — the key said Id while the value was usually a slug. '
        + 'Resend it as "chain" (a chain slug or the STRING spelling of a chain id, e.g. "base" or "8453").',
    };
  }
  if (!chainRaw) {
    return {
      success: false,
      output: missingOrWrongTypeMessage(
        params,
        "chain",
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
    const resolved = await resolveInclusiveEvmChain(chainRaw);
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

    case "erc20_balance": {
      const tokenRaw = str(params, "tokenAddress");
      if (!tokenRaw) return { success: false, output: "Missing required: tokenAddress" };
      const token = parseAddressParam(tokenRaw);
      if (!token) {
        return { success: false, output: "tokenAddress must be a 0x-prefixed 20-byte EVM address." };
      }

      const ownerRaw = str(params, "owner");
      let owner: Address;
      if (ownerRaw) {
        const parsedOwner = parseAddressParam(ownerRaw);
        if (!parsedOwner) {
          return { success: false, output: "owner must be a 0x-prefixed 20-byte EVM address, or omitted to read your own wallet." };
        }
        owner = parsedOwner;
      } else {
        // Address-only resolution: this action never touches key material, and
        // a mission-scope refusal fails the read closed rather than widening it.
        try {
          owner = getAddress(resolveSelectedAddressForRead(context.walletResolution, context.walletPolicy, "eip155"));
        } catch (err) {
          return walletScopeErrorToResult(err);
        }
      }

      let balance: bigint;
      try {
        balance = await readErc20Balance(client, token, owner);
      } catch (err) {
        return { success: false, output: summarizeProtocolError(err).message };
      }

      // Money-path rule: a raw amount travels with the decimals needed to read
      // it, or it is not presented as a human amount at all. A token whose
      // `decimals()` cannot be read still returns its raw balance, with the
      // gap NAMED, rather than a number that could be off by a thousandfold.
      let decimals: number | null = null;
      let decimalsError: string | null = null;
      try {
        decimals = await readErc20Decimals(client, token);
      } catch (err) {
        decimalsError = `decimals() could not be read (${summarizeProtocolError(err).message}); balanceRaw is in the token's smallest unit and has NOT been converted.`;
      }

      return {
        success: true,
        output: JSON.stringify({
          chain: chainName,
          chainId,
          tokenAddress: token,
          owner,
          balanceRaw: balance.toString(),
          decimals,
          balance: decimals === null ? null : formatUnits(balance, decimals),
          ...(decimalsError ? { decimalsError } : {}),
        }, null, 2),
      };
    }

    default:
      return { success: false, output: `Unknown action: ${action}. Valid: tx_receipt, erc721_mint, erc20_balance` };
  }
}
