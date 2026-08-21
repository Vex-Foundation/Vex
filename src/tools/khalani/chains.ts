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

/**
 * The live chain registry, cached 24h.
 *
 * A FETCH failure is the one genuinely TRANSIENT condition in this module, and
 * it is the only one that tells the agent to retry. Every other refusal here
 * concerns a registry we DID read, where retrying changes nothing. Keeping the
 * two apart is what stops "retry this tool later" being said about a chain
 * Khalani has never served.
 */
export async function getCachedKhalaniChains(forceRefresh = false): Promise<KhalaniChain[]> {
  if (cachedChains && !forceRefresh && !isCacheExpired()) {
    return cachedChains;
  }

  try {
    cachedChains = await getKhalaniClient().getChains();
  } catch (cause) {
    throw Object.assign(
      new VexError(
        ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
        "Khalani's chain registry could not be read.",
        "This is a transport failure, not a statement about any chain: retry this tool later.",
      ),
      { cause, retryable: true },
    );
  }
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
    "Call `TokenFind` or `WalletBalances` without a chain filter to see the chains Khalani "
    + "currently covers, or pass the numeric chain id `TokenFind` returned."
  );
}

/** The alias spelling for a chain id, when the alias table has one. */
function aliasNameForChainId(chainId: number): string | undefined {
  return Object.keys(CHAIN_ALIASES).find((alias) => CHAIN_ALIASES[alias] === chainId);
}

/**
 * A chain from the live registry, or a refusal that says what is actually true.
 *
 * Reaching here means the registry WAS read (the caller holds the list), so the
 * chain is one Khalani does not serve - not a transient gap. The old wording
 * said "retry this tool later", which was correct for a fetch failure and wrong
 * for the 26 alias-table entries the live registry has never served: it sent
 * the agent back to burn turns on a chain that was never coming. The retry
 * framing now lives ONLY on the fetch failure in `getCachedKhalaniChains`, and
 * this refusal names Relay, which the bridge venue router reaches automatically.
 *
 * The alias table itself is left intact. An alias is a harmless string-to-id
 * mapping used by every Khalani entry point, and pruning entries would only
 * turn a precise "Khalani does not serve Sonic" into a vague "unsupported
 * chain: sonic".
 */
export function getChain(chainId: number, chains: KhalaniChain[]): KhalaniChain {
  const chain = chains.find((entry) => entry.id === chainId);
  if (!chain) {
    const name = aliasNameForChainId(chainId) ?? `chain ${chainId}`;
    throw new VexError(
      ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
      `Chain ${chainId} is not in the current Khalani registry.`,
      `Khalani does not serve ${name}; Relay may - the bridge router picks the venue `
      + "automatically, so bridge with `BridgeQuote` / `BridgeExecute` rather than calling a "
      + "`khalani.*` tool directly. Retrying this call will not change the answer."
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
