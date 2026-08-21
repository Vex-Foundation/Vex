/**
 * WalletTrackToken — explicit token pinning for LOCAL (non-Khalani) chains.
 *
 * Khalani-covered chains discover holdings automatically; LOCAL chains (e.g.
 * Robinhood 4663) scan a fixed set: the chain's seed tokens ∪ the pins in
 * `tracked_tokens`. This tool manages those pins so tokens received by
 * transfer/airdrop become visible to `WalletBalances` and the portfolio.
 * Swap (uniswap) and bridge (relay) executes auto-pin their tokens — manual
 * pinning covers everything else. DB-only: no on-chain transaction, no
 * approval needed (`actionKind: local_write`, mirrors session-memory writes).
 */

import { getAddress, isAddress } from "viem";
import { z } from "zod";

import { getLocalChain, resolveLocalChainId } from "@tools/evm-chains/registry.js";
import * as trackedTokensRepo from "@vex-agent/db/repos/tracked-tokens.js";
import { resolveSelectedAddressForRead } from "./resolve.js";
import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail, ok } from "../types.js";
import { formatZodIssueForModel } from "../arg-validation.js";

const TrackArgs = z.object({
  action: z.enum(["pin", "unpin", "list"]),
  chain: z.string().trim().min(1, { message: "chain is required (e.g. 'robinhood' or '4663')" }),
  // Required for pin/unpin; ignored for list.
  token: z.string().trim().optional(),
}).strict();

export async function handleWalletTrackToken(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = TrackArgs.safeParse(params);
  if (!parsed.success) {
    return fail(`WalletTrackToken: ${formatZodIssueForModel(parsed.error.issues[0], params)}`);
  }
  const { action, chain, token } = parsed.data;

  const chainId = resolveLocalChainId(chain);
  const config = chainId !== undefined ? getLocalChain(chainId) : undefined;
  if (chainId === undefined || !config) {
    return fail(
      `WalletTrackToken: '${chain}' is not a local chain. Pinning only applies to local chains (e.g. robinhood / 4663) — Khalani-covered chains discover tokens automatically.`,
    );
  }

  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddressForRead(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return fail(`WalletTrackToken: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (action === "list") {
    const pinned = await trackedTokensRepo.listTrackedTokens({ walletAddress, chainId });
    return ok({
      chain: config.name,
      chainId,
      wallet: walletAddress,
      seedTokens: config.seedTokens.map((t) => ({ address: t.address, label: t.label })),
      pinned: pinned.map((p) => ({ address: p.tokenAddress, source: p.source, createdAt: p.createdAt })),
    });
  }

  if (!token || !isAddress(token)) {
    return fail(
      "WalletTrackToken: `token` must be the ERC-20 contract ADDRESS (0x…). Resolve a symbol to its address first (e.g. dexscreener.search).",
    );
  }
  const checksummed = getAddress(token);

  if (action === "pin") {
    const isSeed = config.seedTokens.some(
      (t) => t.address.toLowerCase() === checksummed.toLowerCase(),
    );
    if (isSeed) {
      return ok({ chain: config.name, chainId, token: checksummed, pinned: false, note: "Already in the chain's seed set — always scanned; no pin needed." });
    }
    const { inserted } = await trackedTokensRepo.pinTrackedToken({
      walletAddress,
      chainId,
      tokenAddress: checksummed,
      source: "agent",
    });
    return ok({
      chain: config.name,
      chainId,
      token: checksummed,
      pinned: true,
      note: inserted ? "Pinned — balance reads and portfolio now track it." : "Was already pinned.",
    });
  }

  const removed = await trackedTokensRepo.unpinTrackedToken({ walletAddress, chainId, tokenAddress: checksummed });
  return ok({ chain: config.name, chainId, token: checksummed, unpinned: removed > 0 });
}
