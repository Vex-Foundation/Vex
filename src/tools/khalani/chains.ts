import { VexError, ErrorCodes } from "../../errors.js";
import type { ChainFamily, KhalaniChain } from "./types.js";
import { getKhalaniClient } from "./client.js";

export const CHAIN_ALIASES: Record<string, number> = {
  // Major L1s
  eth: 1,
  ethereum: 1,
  sol: 20011000000,
  solana: 20011000000,
  bsc: 56,
  bnb: 56,
  avax: 43114,
  avalanche: 43114,
  poly: 137,
  polygon: 137,
  tron: 728126428,

  // Major L2s / Rollups
  arb: 42161,
  arbitrum: 42161,
  base: 8453,
  op: 10,
  optimism: 10,
  scroll: 534352,
  linea: 59144,
  zksync: 324,
  mantle: 5000,
  blast: 81457,
  mode: 34443,
  zora: 7777777,

  // Newer / Emerging
  monad: 143,
  unichain: 130,
  sonic: 146,
  berachain: 80094,
  bera: 80094,
  abstract: 2741,
  ink: 57073,
  lens: 232,
  sei: 1329,
  story: 1514,
  worldchain: 480,
  world: 480,
  lisk: 1135,
  bob: 60808,
  redstone: 690,
  soneium: 1868,

  // Other supported
  gnosis: 100,
  cronos: 25,
  flow: 747,
  hyperevm: 999,
  injective: 2525,
  jovay: 5734951,
  katana: 747474,
  neon: 245022934,
  plasma: 9745,
  sophon: 50104,
  zilliqa: 32769,
};

const CHAIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let cachedChains: KhalaniChain[] | null = null;
let cachedAt = 0;

function isCacheExpired(): boolean {
  return Date.now() - cachedAt > CHAIN_CACHE_TTL_MS;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export async function getCachedKhalaniChains(forceRefresh = false): Promise<KhalaniChain[]> {
  if (cachedChains && !forceRefresh && !isCacheExpired()) {
    return cachedChains;
  }

  cachedChains = await getKhalaniClient().getChains();
  cachedAt = Date.now();
  return cachedChains;
}

export function clearKhalaniChainsCache(): void {
  cachedChains = null;
  cachedAt = 0;
}

export function resolveChainId(input: string, chains?: KhalaniChain[]): number {
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, "Chain value cannot be empty.");
  }
  if (normalized in CHAIN_ALIASES) {
    return CHAIN_ALIASES[normalized];
  }

  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric;
  }

  if (chains) {
    const slug = slugify(normalized);
    const matched = chains.find((chain) => slugify(chain.name) === slug);
    if (matched) {
      return matched.id;
    }
  }

  throw new VexError(
    ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
    `Unsupported chain: ${input}`,
    "Call token_find or wallet_balances without a chain filter to see the chains Khalani "
    + "currently covers, or pass the numeric chain id token_find returned."
  );
}

export function getChain(chainId: number, chains: KhalaniChain[]): KhalaniChain {
  const chain = chains.find((entry) => entry.id === chainId);
  if (!chain) {
    throw new VexError(
      ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
      `Chain ${chainId} is not in the current Khalani registry.`,
      "The registry is fetched per run; if the chain was expected, retry this tool later. "
      + "Otherwise use a chain the registry covers."
    );
  }
  return chain;
}

export function getChainFamily(chainId: number, chains: KhalaniChain[]): ChainFamily {
  return getChain(chainId, chains).type;
}

export function getChainRpcUrl(chainId: number, chains: KhalaniChain[]): string {
  const rpcUrl = getChain(chainId, chains).rpcUrls?.default?.http?.[0];
  if (!rpcUrl) {
    throw new VexError(
      ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
      `Chain ${chainId} does not expose an RPC URL in Khalani metadata.`,
    );
  }
  return rpcUrl;
}

export function getChainExplorerUrl(chainId: number, chains: KhalaniChain[]): string | undefined {
  return getChain(chainId, chains).blockExplorers?.default?.url;
}
