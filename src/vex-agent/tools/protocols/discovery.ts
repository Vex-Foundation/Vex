import {
  PROTOCOL_TOOLS,
  isAdvertisedProtocolNamespace,
  isKnownProtocolNamespace,
  isProtocolToolAvailable,
} from "./catalog.js";
import { buildDiscoverNamespaceDescription } from "./descriptions.js";
import { denseScore } from "./dense-score.js";
import type {
  ProtocolDiscoveryItem,
  ProtocolDiscoveryRequest,
  ProtocolDiscoveryResult,
  ProtocolDiscoveryRetrievalMeta,
} from "./types.js";
import type { ScoredManifest } from "./lexical-score.js";
import { isUniswapPairRevealed } from "../registry/uniswap-reveal.js";

const DEFAULT_DISCOVERY_LIMIT = 5;

/**
 * The canonical dotted Uniswap swap toolIds (FIX-SPINE round 1, finding
 * 8/C3) — mirrors `runtime.ts`'s `REVEAL_GATED_UNISWAP_TOOL_IDS`. Filtered
 * out of discovery results for a session that has not revealed them, so
 * `discover_tools` never advertises a manifest `executeProtocolTool` would
 * then hard-reject.
 */
const REVEAL_GATED_UNISWAP_TOOL_IDS: ReadonlySet<string> = new Set([
  "uniswap.swap.quote",
  "uniswap.swap.execute",
]);

function toDiscoveryItem(
  entry: ScoredManifest,
  contextUsageBand: ProtocolDiscoveryRequest["contextUsageBand"],
  preparationBypassesBarrier: boolean,
): ProtocolDiscoveryItem {
  const item: ProtocolDiscoveryItem = {
    toolId: entry.manifest.toolId,
    namespace: entry.manifest.namespace,
    description: entry.manifest.description,
    mutating: entry.manifest.mutating,
    params: entry.manifest.params,
    score: entry.score,
    whyMatched: entry.whyMatched,
  };
  // Only emit the advisory flag when it would be true — keeps payloads
  // minimal and gives the model a clear "absent = available" rule.
  // While a live preparation bypasses the barrier the dispatcher WILL allow
  // these calls, so tagging them unavailable would be a lie that steers the
  // model away from tools it can actually use. `critical` still tags — the
  // bypass never extends there.
  const bypassed = preparationBypassesBarrier && contextUsageBand === "barrier";
  if (
    entry.manifest.mutating &&
    (contextUsageBand === "barrier" || contextUsageBand === "critical") &&
    !bypassed
  ) {
    item.unavailable_at_pressure = true;
  }
  return item;
}

function buildDiscoveryFailure(message: string): ProtocolDiscoveryResult {
  return {
    success: false,
    count: 0,
    totalCount: 0,
    hasMore: false,
    tools: [],
    warnings: [message],
  };
}

function resolveRequestedNamespace(rawNamespace: string | undefined): string | ProtocolDiscoveryResult | null {
  if (typeof rawNamespace !== "string" || rawNamespace.trim().length === 0) return null;

  const namespace = rawNamespace.trim();
  if (!isKnownProtocolNamespace(namespace)) {
    return buildDiscoveryFailure(`Unknown namespace "${namespace}". ${buildDiscoverNamespaceDescription()}`);
  }
  if (!isAdvertisedProtocolNamespace(namespace)) {
    return buildDiscoveryFailure(`Namespace "${namespace}" is reserved and not available through discover_tools. ${buildDiscoverNamespaceDescription()}`);
  }
  return namespace;
}

export async function discoverProtocolCapabilities(
  request: ProtocolDiscoveryRequest,
): Promise<ProtocolDiscoveryResult> {
  const limit = typeof request.limit === "number" && Number.isFinite(request.limit)
    ? Math.max(1, Math.floor(request.limit))
    : DEFAULT_DISCOVERY_LIMIT;

  const resolvedNamespace = resolveRequestedNamespace(request.namespace);
  if (resolvedNamespace && typeof resolvedNamespace !== "string") {
    return resolvedNamespace;
  }

  const query = typeof request.query === "string" ? request.query.trim() : "";
  // Availability is strictly `isProtocolToolAvailable` (lifecycle + env).
  // Execute-time safety still lives in `runtime.ts`; discovery must not hide
  // mutating tools or the agent cannot find them and trigger approval flow.
  const uniswapRevealed = isUniswapPairRevealed(request.sessionId);
  const filteredTools = PROTOCOL_TOOLS
    .filter((manifest) => isAdvertisedProtocolNamespace(manifest.namespace))
    .filter((manifest) => resolvedNamespace ? manifest.namespace === resolvedNamespace : true)
    .filter((manifest) => isProtocolToolAvailable(manifest))
    // FIX-SPINE round 1, finding 8/C3 — hide the canonical hidden Uniswap
    // swap manifests from discovery until this session revealed them.
    .filter((manifest) => uniswapRevealed || !REVEAL_GATED_UNISWAP_TOOL_IDS.has(manifest.toolId));

  let scoredTools: ScoredManifest[];
  let retrievalMeta: ProtocolDiscoveryRetrievalMeta;

  if (query.length === 0) {
    scoredTools = filteredTools.map((manifest) => ({ manifest, score: 0, whyMatched: [] }));
    retrievalMeta = {
      method: "catalog",
      denseFailed: false,
      candidateCount: filteredTools.length,
    };
  } else {
    const outcome = await denseScore(query, filteredTools);
    scoredTools = outcome.scored;
    retrievalMeta = outcome.meta;
  }

  const tools = scoredTools.slice(0, limit).map((entry) => toDiscoveryItem(
    entry,
    request.contextUsageBand,
    request.preparationBypassesBarrier === true,
  ));
  const warnings: string[] = [];
  if (tools.length === 0) {
    warnings.push("No protocol capabilities matched the query/filter.");
  }
  if (scoredTools.length > tools.length) {
    warnings.push(`Showing first ${tools.length} of ${scoredTools.length} matching capabilities. Increase limit to see more.`);
  }

  return {
    success: true,
    count: tools.length,
    totalCount: scoredTools.length,
    hasMore: scoredTools.length > tools.length,
    tools,
    warnings,
    retrieval: retrievalMeta,
  };
}
