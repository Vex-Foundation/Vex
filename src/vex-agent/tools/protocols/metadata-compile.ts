/**
 * Compiles fully-resolved ToolDiscoveryMetadata for a manifest by merging:
 *   1. Per-tool `manifest.discovery` overrides (highest priority)
 *   2. Per-facet defaults from matching navigation facets (medium)
 *   3. Namespace-level defaults (lowest)
 *
 * Manifests without `discovery` get all values from inheritance.
 * PR2 defines and fills; PR3 wires into the scorer.
 */

import type { ToolDiscoveryMetadata, ProtocolToolManifest } from "./types.js";
import type {
  ProtocolNamespaceNavigation,
  ProtocolNavigationFacet,
  ProtocolNavigationGroupId,
} from "./navigation/types.js";

// ── Ecosystem derivation from groupId ──────────────────────────

const GROUP_ECOSYSTEMS: Record<ProtocolNavigationGroupId, readonly string[]> = {
  "evm-trading": ["evm"],
  "solana": ["solana"],
  "perps": ["hyperliquid", "perpetuals", "derivatives"],
  "cross-chain": ["evm", "solana", "crosschain"],
  "prediction-markets": ["evm", "solana"],
  "market-research": ["multichain"],
};

// ── sourceClass derivation from namespace ──────────────────────

type SourceClass = ToolDiscoveryMetadata["sourceClass"];

const NAMESPACE_SOURCE_CLASS: Record<string, SourceClass> = {
  dexscreener: "specialized_market",
  polymarket: "specialized_market",
  hyperliquid: "specialized_market",
  khalani: "protocol_native",
  kyberswap: "protocol_native",
  solana: "protocol_native",
};

// ── Operation derivation ───────────────────────────────────────

type Operation = NonNullable<ToolDiscoveryMetadata["operation"]>[number];

function deriveOperation(manifest: ProtocolToolManifest): Operation[] {
  const id = manifest.toolId;
  if (manifest.mutating) {
    if (id.includes("bridge") || id.includes("swap") || id.includes("buy") || id.includes("sell")) return ["execute"];
    return ["execute"];
  }
  if (id.includes("quote")) return ["quote"];
  return ["research"];
}

// ── Main compile function ──────────────────────────────────────

export function compileToolDiscoveryMetadata(
  manifest: ProtocolToolManifest,
  namespaceNav: ProtocolNamespaceNavigation | undefined,
): ToolDiscoveryMetadata {
  const facets = namespaceNav ? matchFacets(namespaceNav.facets, manifest.toolId) : [];
  const override = manifest.discovery ?? {};

  const facetHints = facets.flatMap((f) => [...f.hints]);
  const paramKeywords = manifest.params.map((p) => p.key);
  const inheritedEcosystems = namespaceNav ? [...GROUP_ECOSYSTEMS[namespaceNav.groupId]] : undefined;

  const inherited: ToolDiscoveryMetadata = {
    aliases: namespaceNav ? [...namespaceNav.aliases] : undefined,
    exampleIntents: facetHints.length > 0 ? facetHints : undefined,
    paramKeywords: paramKeywords.length > 0 ? paramKeywords : undefined,
    ecosystems: inheritedEcosystems,
    sourceClass: NAMESPACE_SOURCE_CLASS[manifest.namespace],
    sideEffectLevel: manifest.mutating ? "high" : "none",
    operation: deriveOperation(manifest),
  };

  return mergeMetadata(inherited, override);
}

// ── Merge: override wins per-field, arrays concatenate if both present ─

function mergeMetadata(
  base: ToolDiscoveryMetadata,
  override: ToolDiscoveryMetadata,
): ToolDiscoveryMetadata {
  const result: ToolDiscoveryMetadata = {};

  const stringArrayKeys = [
    "aliases", "exampleIntents", "paramKeywords", "resourceTypes",
    "ecosystems", "preferredFor", "avoidFor",
  ] as const;

  for (const key of stringArrayKeys) {
    const overrideVal = override[key];
    const baseVal = base[key];
    if (overrideVal !== undefined && baseVal !== undefined) {
      result[key] = dedupeStrings([...baseVal, ...overrideVal]);
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    } else if (baseVal !== undefined) {
      result[key] = baseVal;
    }
  }

  // `chains` is `readonly string[]`; merge by deduped concatenation when both
  // sides supply values (rare — chains are typically declared per-manifest).
  if (override.chains !== undefined && base.chains !== undefined) {
    result.chains = dedupeStrings([...base.chains, ...override.chains]);
  } else if (override.chains !== undefined) {
    result.chains = override.chains;
  } else if (base.chains !== undefined) {
    result.chains = base.chains;
  }

  result.canonicalSummary = override.canonicalSummary ?? base.canonicalSummary;
  result.embeddingText = override.embeddingText ?? base.embeddingText;
  result.operation = override.operation ?? base.operation;
  result.sourceClass = override.sourceClass ?? base.sourceClass;
  result.sideEffectLevel = override.sideEffectLevel ?? base.sideEffectLevel;

  return stripUndefined(result);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function stripUndefined(obj: ToolDiscoveryMetadata): ToolDiscoveryMetadata {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result as ToolDiscoveryMetadata;
}

function matchFacets(
  facets: readonly ProtocolNavigationFacet[],
  toolId: string,
): ProtocolNavigationFacet[] {
  return facets.filter((facet) =>
    facet.toolPrefixes.some((prefix) => toolId === prefix || toolId.startsWith(`${prefix}.`)),
  );
}
