/**
 * Pure functions for extracting token IDs from transaction receipt logs.
 * ERC-721 mint detection (shared with the generic `ChainRead` tool's
 * `erc721_mint` action — see `tools/internal/chain-read.ts`).
 */

// ── ERC-721 mint extraction from receipt ────────────────────────

const ERC721_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDR_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Extract NFT position ID from transaction receipt logs.
 *
 * Priority:
 * 1. Direct mint: Transfer(from=0x0, to=wallet, tokenId) — standard mint
 * 2. Router-intermediated: Transfer(from=any, to=wallet, tokenId) — router mints to
 *    itself first, then transfers to wallet. Only matches logs with 4 indexed topics
 *    (ERC-721, not ERC-20).
 */
export function extractMintedNftId(
  logs: Array<{ address: string; topics: string[]; data: string }>,
  recipientAddress: string,
  expectedContract?: string,
): string | undefined {
  const recipientPadded = `0x000000000000000000000000${recipientAddress.slice(2).toLowerCase()}`;
  const expectedLower = expectedContract?.toLowerCase();

  // Pass 1: direct mint (from=0x0 → wallet)
  for (const log of logs) {
    if (
      log.topics[0] === ERC721_TRANSFER_TOPIC &&
      log.topics.length === 4 &&
      log.topics[1] === ZERO_ADDR_PADDED &&
      log.topics[2]?.toLowerCase() === recipientPadded &&
      (!expectedLower || log.address.toLowerCase() === expectedLower)
    ) {
      return BigInt(log.topics[3]).toString();
    }
  }

  // Pass 2: router-intermediated (any → wallet, 4 topics = ERC-721)
  for (const log of logs) {
    if (
      log.topics[0] === ERC721_TRANSFER_TOPIC &&
      log.topics.length === 4 &&
      log.topics[1] !== ZERO_ADDR_PADDED &&
      log.topics[2]?.toLowerCase() === recipientPadded &&
      (!expectedLower || log.address.toLowerCase() === expectedLower)
    ) {
      return BigInt(log.topics[3]).toString();
    }
  }

  return undefined;
}
