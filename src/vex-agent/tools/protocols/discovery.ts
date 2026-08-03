import {
  PROTOCOL_TOOLS,
  getMissingEnvForNamespace,
  isAdvertisedProtocolNamespace,
  isKnownProtocolNamespace,
  isProtocolToolAvailable,
} from "./catalog.js";
import { buildDiscoverNamespaceDescription } from "./descriptions.js";
import { denseScore } from "./dense-score.js";
import { pinExactToolIdMatch } from "./toolid-pin.js";
import { describeExclusiveParamGroups } from "./runtime/params.js";
import type {
  ProtocolDiscoveryItem,
  ProtocolDiscoveryListItem,
  ProtocolDiscoveryRequest,
  ProtocolDiscoveryResult,
  ProtocolDiscoveryRetrievalMeta,
} from "./types.js";
import type { ProtocolNamespace, ProtocolToolManifest } from "./types.js";
import type { ScoredManifest } from "./lexical-score.js";
import { isUniswapPairRevealed } from "../registry/uniswap-reveal.js";

/**
 * Ranked rows returned when the caller names no limit. Owner decree
 * (2026-08-03, revised same day): default 5, because every ranked row now
 * carries the FULL manifest (params with required/enum/unit, exampleParams,
 * constraints) and is injected as a callable function schema — five complete
 * manifests are a working set, not a shortlist. The agent RAISES the limit
 * itself (up to MAX_DISCOVERY_LIMIT) whenever the job needs more; the limit
 * param description says so explicitly.
 */
export const DEFAULT_DISCOVERY_LIMIT = 5;

/**
 * Hard ceiling on a caller-supplied `limit` (owner clarification 2026-08-03:
 * the default of 10 is an EXAMPLE — the agent asks for as many tools as the
 * job needs, up to this maximum).
 *
 * 20 is not arbitrary: every ranked row is re-materialized as a real function
 * schema for the rest of the session
 * (`registry/injected-protocol-tools.ts`), and the injected-set cap
 * (`MAX_DISCOVERED_TOOLS_PER_SESSION = 24`) is sized so that ONE round at this
 * maximum is never partially evicted. Raising this ceiling without raising
 * that cap would silently truncate the working set the agent just asked for.
 *
 * Enforced by REJECTION at the model boundary
 * (`dispatcher/discover-tools-args.ts` — a supplied param is answered by name,
 * never silently clamped) and clamped here as defense-in-depth for internal
 * callers that bypass that boundary.
 */
export const MAX_DISCOVERY_LIMIT = 20;

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

/** The manifest's required param keys, in declaration order. */
function requiredParamKeys(manifest: ProtocolToolManifest): string[] {
  return manifest.params.filter((param) => param.required === true).map((param) => param.key);
}

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
    actionKind: entry.manifest.actionKind,
    params: entry.manifest.params,
    required: requiredParamKeys(entry.manifest),
    exampleParams: entry.manifest.exampleParams,
    score: entry.score,
    whyMatched: entry.whyMatched,
  };
  // Absent unless the manifest declares XOR groups — a tool without them pays
  // nothing for the field.
  const constraints = describeExclusiveParamGroups(entry.manifest);
  if (constraints.length > 0) item.constraints = constraints;
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

/**
 * Discriminator for `ProtocolDiscoveryResult.tools`: ranked/catalog rows carry
 * `params`, `score`, and `whyMatched`; list-mode rows do not.
 */
export function isRankedDiscoveryItem(
  item: ProtocolDiscoveryItem | ProtocolDiscoveryListItem,
): item is ProtocolDiscoveryItem {
  return "params" in item;
}

function toDiscoveryListItem(manifest: ProtocolToolManifest): ProtocolDiscoveryListItem {
  return {
    toolId: manifest.toolId,
    mutating: manifest.mutating,
    actionKind: manifest.actionKind,
    description: manifest.description,
    requiredParams: requiredParamKeys(manifest),
  };
}

/**
 * Why a namespace is empty, when we can say. `solana` listed as empty with no
 * reason and no remedy while `getMissingEnvForNamespace` — the function that
 * produces both — sat unused. Env var NAMES only: a name is configuration, a
 * value is a secret (rule 06).
 */
function describeEmptyNamespace(namespace: ProtocolNamespace): string {
  const missingEnv = getMissingEnvForNamespace(namespace);
  if (missingEnv.length === 0) {
    return `Namespace "${namespace}" has no available tools right now.`;
  }
  return `Namespace "${namespace}" has no available tools right now: `
    + `set ${missingEnv.join(", ")} to enable it.`;
}

/**
 * Namespace list mode: the COMPLETE advertised, available surface of one
 * protocol as lean rows. No ranking (a list has no query to rank against) and
 * no `limit` truncation — a partial list would defeat its only purpose, which
 * is letting the model see everything a namespace offers in one cheap read.
 */
function buildNamespaceListing(
  namespace: ProtocolNamespace,
  manifests: readonly ProtocolToolManifest[],
): ProtocolDiscoveryResult {
  const tools = manifests.map(toDiscoveryListItem);
  return {
    success: true,
    count: tools.length,
    totalCount: tools.length,
    hasMore: false,
    tools,
    warnings: tools.length === 0 ? [describeEmptyNamespace(namespace)] : [],
    retrieval: { method: "list", denseFailed: false, candidateCount: tools.length },
  };
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

function resolveRequestedNamespace(
  rawNamespace: string | undefined,
): ProtocolNamespace | ProtocolDiscoveryResult | null {
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
  // Model-supplied limits are REJECTED above `MAX_DISCOVERY_LIMIT` at the
  // boundary; this clamp is the defense-in-depth for internal callers.
  const limit = typeof request.limit === "number" && Number.isFinite(request.limit)
    ? Math.min(MAX_DISCOVERY_LIMIT, Math.max(1, Math.floor(request.limit)))
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

  if (request.list === true) {
    if (typeof resolvedNamespace !== "string") {
      return buildDiscoveryFailure(
        `list mode requires a namespace — listing every protocol at once is not available. ${buildDiscoverNamespaceDescription()}`,
      );
    }
    return buildNamespaceListing(resolvedNamespace, filteredTools);
  }

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
    // A query that IS a toolId (or uniquely prefixes one) names its answer;
    // dense similarity is the wrong instrument for that. Everything after the
    // pinned row keeps the ranking retrieval produced.
    scoredTools = pinExactToolIdMatch(query, filteredTools, scoredTools);
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
