/**
 * Runtime-owned chain coverage projected into protocol declarations.
 *
 * Navigation aliases, discovery hints, and declaration prose are never chain
 * truth. Every rendered row comes from the registry or constant used by the
 * corresponding runtime path.
 */

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../constants/solana-chain.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";
import { MORPHO_CHAINS } from "@tools/morpho/chains.js";
import { PENDLE_CHAIN_REGISTRY } from "@tools/pendle/chains.js";
import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { listUniswapDeployments } from "@tools/uniswap/deployments.js";
import { BRIDGE_FAMILY } from "@vex-agent/tools/protocols/relay/handlers/bridge/constants.js";
import { VIRTUALS_TOOLS } from "@vex-agent/tools/protocols/virtuals/manifest.js";
import { CURATED_BRIDGE_CHAIN_NAMES } from "@vex-agent/tools/protocols/khalani/capability-snapshot.js";
import type { ProtocolNamespace } from "@vex-agent/tools/protocols/types.js";

/** Static expectation pinned from Khalani's live registry on 2026-08-17. */
export const KHALANI_PINNED_EVM_CHAIN_IDS: readonly number[] = [
  1, 10, 56, 130, 137, 143, 324, 2741, 5000, 8453, 16661, 42161, 43114, 59144, 80094, 747474,
] as const;

export interface ProtocolNamespaceCoverage {
  readonly namespace: ProtocolNamespace;
  readonly line: string;
}

function renderNamedChains(chains: readonly { readonly name: string; readonly chainId: number }[]): string {
  return chains.map((chain) => `${chain.name} (${chain.chainId})`).join(", ");
}

function renderSluggedChains(chains: readonly { readonly slug: string; readonly chainId: number }[]): string {
  return chains.map((chain) => `${chain.slug} (${chain.chainId})`).join(", ");
}

function localChainLine(chainId: number): string {
  const chain = getLocalChain(chainId);
  return chain ? `${chain.name} (${chain.id})` : `chain ${chainId}`;
}

function renderKhalaniPinnedEvmChains(): string {
  const named: string[] = [];
  let hasUnnamed = false;
  for (const chainId of KHALANI_PINNED_EVM_CHAIN_IDS) {
    const name = CURATED_BRIDGE_CHAIN_NAMES[chainId];
    if (name) named.push(`${name} (${chainId})`);
    else hasUnnamed = true;
  }
  if (hasUnnamed) named.push("and others");
  return named.join(", ");
}

function virtualsManifestChainValues(): readonly string[] {
  const values = VIRTUALS_TOOLS
    .flatMap((tool) => tool.params)
    .find((param) => param.key === "chain" && param.enum)?.enum;
  if (!values) throw new Error("Virtuals manifest must declare its closed chain enum.");
  return values;
}

const KYBERSWAP_COVERAGE = getKyberChains()
  .filter((chain) => chain.aggregator)
  .map((chain) => ({ name: chain.name, chainId: chain.chainId }));

const UNISWAP_COVERAGE = listUniswapDeployments().map((deployment) => ({
  name: deployment.name,
  chainId: deployment.chainId,
}));

const COVERAGE_BY_NAMESPACE: Readonly<Partial<Record<ProtocolNamespace, ProtocolNamespaceCoverage>>> = {
  khalani: {
    namespace: "khalani",
    line: `Coverage: ${renderKhalaniPinnedEvmChains()}, plus Solana (${SOLANA_SYNTHETIC_CHAIN_ID}). Live bridge reach is in the turn state.`,
  },
  relay: {
    namespace: "relay",
    line: `Coverage: ${BRIDGE_FAMILY} EVM chains only. ${localChainLine(TRENCH_CHAIN_ID)} is reachable only through Relay when its live health gate passes; Solana is not supported.`,
  },
  kyberswap: {
    namespace: "kyberswap",
    line: `Coverage: ${renderNamedChains(KYBERSWAP_COVERAGE)}.`,
  },
  uniswap: {
    namespace: "uniswap",
    line: `Coverage: ${renderNamedChains(UNISWAP_COVERAGE)}.`,
  },
  morpho: {
    namespace: "morpho",
    line: `Coverage: ${renderSluggedChains(MORPHO_CHAINS)}.`,
  },
  pendle: {
    namespace: "pendle",
    line: `Coverage: ${renderNamedChains(PENDLE_CHAIN_REGISTRY)}.`,
  },
  trench: {
    namespace: "trench",
    line: `Coverage: ${localChainLine(TRENCH_CHAIN_ID)} only.`,
  },
  pools: {
    namespace: "pools",
    line: `Coverage: ${localChainLine(POOLS_CHAIN_ID)} only.`,
  },
  solana: {
    namespace: "solana",
    line: `Coverage: Solana (${SOLANA_SYNTHETIC_CHAIN_ID}) only.`,
  },
  indexify: {
    namespace: "indexify",
    line: `Coverage: Solana (${SOLANA_SYNTHETIC_CHAIN_ID}) only — trades the linked Indexify account's custodial USDC, never the session wallet.`,
  },
  virtuals: {
    namespace: "virtuals",
    // Coverage is not uniform across the four chains, and the differences are
    // MEASURED, not assumed (`src/tools/virtuals/Virtuals.md`): the API indexes
    // all four, the curve trade tape exists only where the provider's own SDK
    // numbers a chain, and candles need an indexed pool. Naming only the chain
    // list would tell the agent that every tool works everywhere, which is the
    // exact wrong thing to believe before spending a call.
    line:
      `Coverage: ${virtualsManifestChainValues().join(", ")} for screening, detail, graduations and `
      + "genesis. Narrower per capability: trade tape base and solana only; candles for graduated "
      + "agents everywhere but ethereum, and for bonding agents on solana only. Trades execute "
      + "elsewhere - kyberswap on base/ethereum, uniswap on robinhood, solana tools on solana; an "
      + "EVM bonding curve has no venue tool yet.",
  },
} as const;

export function getProtocolNamespaceCoverage(
  namespace: ProtocolNamespace,
): ProtocolNamespaceCoverage | undefined {
  return COVERAGE_BY_NAMESPACE[namespace];
}

export function getProjectedProtocolCoverages(): readonly ProtocolNamespaceCoverage[] {
  return Object.values(COVERAGE_BY_NAMESPACE);
}
