import { describe, expect, it } from "vitest";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../constants/solana-chain.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";
import { MORPHO_CHAINS } from "@tools/morpho/chains.js";
import { PENDLE_CHAIN_REGISTRY } from "@tools/pendle/chains.js";
import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { listUniswapDeployments } from "@tools/uniswap/deployments.js";
import { BRIDGE_FAMILY } from "@vex-agent/tools/protocols/relay/handlers/bridge/constants.js";
import { VIRTUALS_TOOLS } from "@vex-agent/tools/protocols/virtuals/manifest.js";
import { CURATED_BRIDGE_CHAIN_NAMES } from "@vex-agent/tools/protocols/khalani/capability-snapshot.js";
import {
  KHALANI_PINNED_EVM_CHAIN_IDS,
  getProjectedProtocolCoverages,
  getProtocolNamespaceCoverage,
} from "@vex-agent/engine/prompts/chain-coverage.js";

function coverage(namespace: Parameters<typeof getProtocolNamespaceCoverage>[0]): string {
  const projection = getProtocolNamespaceCoverage(namespace);
  expect(projection).toBeDefined();
  return projection?.line ?? "";
}

describe("protocol declaration chain coverage", () => {
  it("projects every runtime-owned chain source", () => {
    // Wave 2 migration rows T838 and T839: the retired combined table is now
    // one deterministic projection per namespace.
    expect(getProjectedProtocolCoverages()).toEqual(getProjectedProtocolCoverages());

    for (const chain of getKyberChains().filter((entry) => entry.aggregator)) {
      expect(coverage("kyberswap")).toContain(`(${chain.chainId})`);
    }
    for (const chain of MORPHO_CHAINS) {
      expect(coverage("morpho")).toContain(`(${chain.chainId})`);
    }
    for (const chain of PENDLE_CHAIN_REGISTRY) {
      expect(coverage("pendle")).toContain(`(${chain.chainId})`);
    }
    for (const deployment of listUniswapDeployments()) {
      expect(coverage("uniswap")).toContain(`(${deployment.chainId})`);
    }
    let hasUnnamedKhalaniChain = false;
    for (const chainId of KHALANI_PINNED_EVM_CHAIN_IDS) {
      const name = CURATED_BRIDGE_CHAIN_NAMES[chainId];
      if (name) expect(coverage("khalani")).toContain(`${name} (${chainId})`);
      else hasUnnamedKhalaniChain = true;
    }
    if (hasUnnamedKhalaniChain) expect(coverage("khalani")).toContain("and others");
    expect(coverage("trench")).toContain(String(TRENCH_CHAIN_ID));
    expect(coverage("pools")).toContain(String(POOLS_CHAIN_ID));
    expect(coverage("solana")).toContain(String(SOLANA_SYNTHETIC_CHAIN_ID));
    expect(coverage("relay")).toContain(BRIDGE_FAMILY);
    const virtualsChainEnum = VIRTUALS_TOOLS
      .flatMap((tool) => tool.params)
      .find((param) => param.key === "chain" && param.enum)?.enum;
    expect(virtualsChainEnum).toBeDefined();
    for (const chain of virtualsChainEnum ?? []) {
      expect(coverage("virtuals")).toContain(chain);
    }
  });

  it("does not invent runtime coverage for an open provider index", () => {
    expect(getProtocolNamespaceCoverage("dexscreener")).toBeUndefined();
  });

  it("keeps removed Etherlink absent", () => {
    // Wave 2 migration rows T026 and T027.
    const joined = getProjectedProtocolCoverages().map((entry) => entry.line).join("\n");
    expect(joined).not.toContain("Etherlink");
    expect(joined).not.toContain("42793");
  });
});
