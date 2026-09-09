/**
 * Compact discovery projection. Full declarations and fee conditions stay in
 * the guide; no declaration or inventory is shortened to fit a byte budget.
 */
import { getProtocolNamespaceCoverage } from "../../engine/prompts/chain-coverage.js";
import { buildStudioInventory } from "../../mcp/inventory/index.js";
import { getAdvertisedProtocolNavigation } from "../../tools/protocols/descriptions.js";
import type { ProtocolNamespace } from "../../tools/protocols/types.js";
import type { ProtocolNamespaceNavigation } from "../../tools/protocols/navigation/types.js";
import type { StudioInstallationEnvironment } from "./installation-environment.js";
import { isStudioEnvironmentKeyConfigured } from "./installation-environment.js";
import { STUDIO_NAMESPACE_FEES } from "./protocol-blocks.js";

export const STUDIO_PROTOCOL_MAP_MAX_BYTES = 2_800;

/** Whole capability phrases from the declarations, checked before rendering. */
const CAPABILITY_PHRASES: Readonly<Record<ProtocolNamespace, readonly string[]>> = {
  dexscreener: ["read-only market research"],
  khalani: ["cross-chain bridge", "token-resolution"],
  kyberswap: ["EVM swap aggregator"],
  lighter: ["perp-trading", "onboarding"],
  morpho: ["variable-rate lending", "Morpho vaults"],
  pendle: ["term-yield"],
  pools: ["no-curve launchpad"],
  relay: ["cross-chain bridge"],
  solana: ["swaps", "lending", "borrowing", "prediction markets"],
  launchpads: ["image locker", "public content-addressed host"],
  uniswap: ["spot-swap"],
  virtuals: ["agent tokens", "bonding-curve trading"],
};

/**
 * Parse named chain tuples from the shared runtime coverage projection. All
 * tuples are retained, with numeric IDs omitted from this discovery view.
 * Nonuniform and provider-indexed coverage gets an explicit qualification.
 */
function mapCoverage(navigation: ProtocolNamespaceNavigation): string {
  const { namespace, declaration } = navigation;
  const coverage = getProtocolNamespaceCoverage(namespace)?.line ?? declaration.coverageNote;
  if (coverage === undefined) throw new Error(`STUDIO_PROTOCOL_MAP_COVERAGE_MISSING: ${namespace}`);
  const named = [...coverage.matchAll(/([^,.:]+?) \(\d+\)/g)]
    .map((match) => (match[1] ?? "").trim().replace(/^plus /, ""));
  switch (namespace) {
    case "dexscreener":
      if (coverage.includes("provider's index")) return "provider-indexed chains";
      break;
    case "launchpads":
      if (coverage.includes("chain-agnostic")) return "chain-agnostic";
      break;
    case "lighter": {
      const environments = /Covers (.+?) with environment-specific/.exec(coverage)?.[1];
      if (environments !== undefined) return environments;
      break;
    }
    case "relay":
      if (coverage.includes("EVM chains only") && coverage.includes("live health gate")) {
        return `EVM only; ${named.join(",")} needs live health gate`;
      }
      break;
    case "virtuals": {
      const indexed = /^Coverage: (.+?) for screening/.exec(coverage)?.[1];
      const trading = /Curve trading is (.+?) only:/.exec(coverage)?.[1];
      const launching = /LAUNCHING an agent is (.+?) only,/.exec(coverage)?.[1];
      if (indexed !== undefined && trading !== undefined && launching === trading) {
        return `${indexed}; buy/sell/launch ${trading} only`;
      }
      break;
    }
    default:
      if (named.length === 0) throw new Error(`STUDIO_PROTOCOL_MAP_COVERAGE_MISSING: ${namespace}`);
      return named.join(",") + (namespace === "khalani" ? "; live reach" : "");
  }
  throw new Error(`STUDIO_PROTOCOL_MAP_COVERAGE_MISSING: ${namespace}; review the changed coverage declaration.`);
}

/** One row per advertised namespace, with installation key names, never values. */
export function renderStudioProtocolMap(environment: StudioInstallationEnvironment): string {
  const inventory = buildStudioInventory();
  const rows = getAdvertisedProtocolNavigation().map((navigation) => {
    const { namespace, declaration } = navigation;
    const phrases = CAPABILITY_PHRASES[namespace];
    if (phrases === undefined || phrases.some((phrase) => !declaration.identity.includes(phrase))) {
      throw new Error(`STUDIO_PROTOCOL_MAP_CAPABILITY_MISSING: ${namespace}`);
    }
    const fee = STUDIO_NAMESPACE_FEES[namespace];
    if (fee === undefined) throw new Error(`STUDIO_PROTOCOL_MAP_FEE_MISSING: ${namespace}`);
    const tools = inventory.filter((tool) => tool.namespace === namespace);
    const prefix = `${namespace}__`;
    if (tools.length === 0 || tools.some((tool) => !tool.publicName.startsWith(prefix))) {
      throw new Error(`STUDIO_PROTOCOL_MAP_PREFIX_MISMATCH: ${namespace}`);
    }
    const keys = [...new Set(tools.flatMap((tool) => tool.requiresEnv ? [tool.requiresEnv] : []))].sort();
    const keyStatus = keys.length === 0 ? "not required" : keys.map((key) =>
      `${key} ${isStudioEnvironmentKeyConfigured(environment, key) ? "configured" : "missing"}`,
    ).join(", ");
    return `- ${namespace}: ${phrases.join("/")}; ${mapCoverage(navigation)}; fee ${fee.map}; key ${keyStatus}; \`${prefix}\`.`;
  });
  const map = ["## Protocol map", "", ...rows].join("\n");
  const bytes = Buffer.byteLength(map, "utf8");
  if (bytes > STUDIO_PROTOCOL_MAP_MAX_BYTES) {
    throw new Error(`STUDIO_PROTOCOL_MAP_MAX_BYTES: ${bytes} exceeds ${STUDIO_PROTOCOL_MAP_MAX_BYTES}; move detail to the guide, never cut the map.`);
  }
  return map;
}
