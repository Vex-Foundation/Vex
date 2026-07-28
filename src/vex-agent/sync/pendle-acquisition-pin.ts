/**
 * Pendle acquisition auto-pin (Batch B, card B2).
 *
 * Pendle's own tokens (PT / YT / LP) are exotic ERC-20s that no upstream
 * balance scan discovers on its own. Before this card the enrichment path
 * rediscovered them by scanning `proj_activity` for hex addresses — a source
 * that disappears the moment the Pendle tools stop writing capture rows
 * (`capture: "none"`, same commit-atom). The durable replacement is the same
 * one KyberSwap/Uniswap/Relay already use for an acquired token: pin it into
 * `tracked_tokens` IMMEDIATELY after on-chain confirmation.
 *
 * Called by the Pendle handlers after a confirmed acquisition. FAIL-SOFT by
 * construction: a pin failure must never fail (or unwind) a settled on-chain
 * action — the worst case is a token missing from the next balance scan, which
 * the user can still pin by hand via `wallet_track_token`.
 *
 * `source: "swap"` is deliberate: the `tracked_tokens.source` CHECK constraint
 * (migration 036) allows only `agent | swap | bridge`, and a Pendle acquisition
 * is the swap-shaped one of those three. A dedicated `yield` provenance value
 * would need its own migration; this card is expand-only on the code side.
 */

import { getAddress } from "viem";

import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import logger from "@utils/logger.js";

/**
 * One acquired Pendle token. `symbol`/`decimals` are carried by the callers'
 * confirmation payloads and accepted here so the call site needs no reshaping;
 * `tracked_tokens` stores identity only, so only `address` is persisted.
 */
export interface PendleAcquiredToken {
  address: string;
  symbol: string | null;
  decimals: number | null;
}

/**
 * Pin every acquired PT/YT/LP token for a CONFIRMED Pendle action. Idempotent
 * (the repo's insert is `ON CONFLICT DO NOTHING`) and never throws.
 */
export async function pinConfirmedPendleAcquisition(
  walletAddress: string,
  chainId: number,
  tokens: readonly PendleAcquiredToken[],
): Promise<void> {
  if (pendleChainSlug(chainId) === undefined) return;

  for (const token of tokens) {
    let tokenAddress: string;
    try {
      tokenAddress = getAddress(token.address);
    } catch {
      logger.warn("sync.pendle_acquisition_pin.invalid_address", { chainId });
      continue;
    }
    try {
      await pinTrackedToken({ walletAddress, chainId, tokenAddress, source: "swap" });
    } catch (err) {
      logger.warn("sync.pendle_acquisition_pin.failed", {
        chainId,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
}
