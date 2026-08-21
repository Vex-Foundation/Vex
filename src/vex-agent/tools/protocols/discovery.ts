import {
  PROTOCOL_TOOLS,
  getMissingEnvForNamespace,
  getProtocolManifest,
  isAdvertisedProtocolNamespace,
  isKnownProtocolNamespace,
} from "./catalog.js";
import {
  MAX_DISCOVERED_TOOLS_PER_SESSION,
  getDiscoveredToolIds,
  recordDiscoveredTools,
} from "../registry/discovered-tools.js";
import { buildDiscoverNamespaceDescription } from "./descriptions.js";
import { denseScore } from "./dense-score.js";
import { pinExactToolIdMatch } from "./toolid-pin.js";
import { describeParamGroupConstraints } from "./runtime/params.js";
import type {
  ManifestRow,
  ProtocolDiscoveryItem,
  ProtocolDiscoveryListItem,
  ProtocolDiscoveryRequest,
  ProtocolDiscoveryResult,
  ProtocolDiscoveryRetrievalMeta,
} from "./types.js";
import type { ProtocolNamespace, ProtocolToolManifest } from "./types.js";
import type { ScoredManifest } from "./lexical-score.js";

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
 * Max public names one `ToolSearch` select may name. Rejected BY NAME above it,
 * never sliced.
 *
 * DERIVED, not chosen. The owner's flow (directive D2, 2026-08-04) is "agent
 * może pobrać pełny namespace protokołu", so the bound must fit the LARGEST
 * advertised namespace — solana, 34 tools. 40 = 34 + a six-tool tail, so a
 * whole-namespace select can be mixed with a little earlier work without being
 * refused. `tool-search-select.test.ts` derives both facts from
 * `PROTOCOL_TOOLS`, so a future 41-tool namespace fails the suite instead of
 * silently refusing.
 *
 * A bound is still required, and is a real safety property rather than caution:
 * fetching all 107 advertised manifests in one call costs 461,857 chars (~45% of
 * a 256k window) before history. The measured ceiling AT this bound is 322,594
 * chars for the 40 largest manifests in the catalog — a set no real namespace
 * contains (`probes/worst-legal-flow.ts`).
 *
 * `MAX_DISCOVERED_TOOLS_PER_SESSION` must be >= this value, which is what
 * guarantees a single call can never evict its own results. They are SEPARATE
 * constants and the invariant is `>=`, not equality: retention policy and
 * response-size policy must be able to move independently. They are equal at 40
 * today.
 */
export const MAX_SELECT_TOOL_NAMES = 40;

/** The manifest's required param keys, in declaration order. */
function requiredParamKeys(manifest: ProtocolToolManifest): string[] {
  return manifest.params.filter((param) => param.required === true).map((param) => param.key);
}

/**
 * The one place a manifest becomes a model-facing row.
 *
 * Ranked discovery spreads it and appends `score`/`whyMatched`;
 * every consumer that needs the full manifest shape reads it. Owner directive
 * D3: the paths must be indistinguishable, so there is exactly ONE builder. The
 * last time this projection had two implementations, W7's
 * `exampleParams`/`required`/`constraints` reached the ranked row and the
 * listing was left behind.
 */
export function toManifestRow(
  manifest: ProtocolToolManifest,
  contextUsageBand: ProtocolDiscoveryRequest["contextUsageBand"],
  preparationBypassesBarrier: boolean,
): ManifestRow {
  const row: ManifestRow = {
    toolId: manifest.toolId,
    publicName: manifest.publicName,
    namespace: manifest.namespace,
    description: manifest.description,
    mutating: manifest.mutating,
    actionKind: manifest.actionKind,
    params: manifest.params,
    required: requiredParamKeys(manifest),
    exampleParams: manifest.exampleParams,
  };
  // Absent unless the manifest declares a cross-param group (exactly-one,
  // at-most-one, or at-least-one) — a tool without them pays nothing.
  const constraints = describeParamGroupConstraints(manifest);
  if (constraints.length > 0) row.constraints = constraints;
  // Only emit the advisory flag when it would be true — keeps payloads
  // minimal and gives the model a clear "absent = available" rule.
  // While a live preparation bypasses the barrier the dispatcher WILL allow
  // these calls, so tagging them unavailable would be a lie that steers the
  // model away from tools it can actually use. `critical` still tags — the
  // bypass never extends there.
  const bypassed = preparationBypassesBarrier && contextUsageBand === "barrier";
  if (
    manifest.mutating &&
    (contextUsageBand === "barrier" || contextUsageBand === "critical") &&
    !bypassed
  ) {
    row.unavailable_at_pressure = true;
  }
  return row;
}

function toDiscoveryItem(
  entry: ScoredManifest,
  contextUsageBand: ProtocolDiscoveryRequest["contextUsageBand"],
  preparationBypassesBarrier: boolean,
): ProtocolDiscoveryItem {
  return {
    ...toManifestRow(entry.manifest, contextUsageBand, preparationBypassesBarrier),
    score: entry.score,
    whyMatched: entry.whyMatched,
  };
}

/**
 * Why a manifest may or may not be reached through discovery — the FOUR gates
 * `discoverProtocolCapabilities` applies to its candidates, shared so
 * select mode cannot become a bypass that hands the model a manifest
 * `executeProtocolTool` would then hard-reject.
 *
 * A discriminated result rather than a boolean, deliberately: a boolean cannot
 * tell select mode WHY a name failed, so the caller would have to re-derive
 * every gate to write a real-cause rejection — duplicating exactly what this
 * extraction unifies. `missingEnv` carries env var NAMES only; a name
 * is configuration, a value is a secret (rule 06).
 */
export type ManifestDiscoverability =
  | { ok: true }
  | {
    ok: false;
    reason: "not_advertised" | "env_missing" | "inactive";
    missingEnv?: string[];
  };

export function evaluateManifestDiscoverability(
  manifest: ProtocolToolManifest,
): ManifestDiscoverability {
  if (!isAdvertisedProtocolNamespace(manifest.namespace)) {
    return { ok: false, reason: "not_advertised" };
  }
  if (manifest.lifecycle !== "active") return { ok: false, reason: "inactive" };
  if (manifest.requiresEnv && !process.env[manifest.requiresEnv]?.trim()) {
    return { ok: false, reason: "env_missing", missingEnv: [manifest.requiresEnv] };
  }
  return { ok: true };
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
    publicName: manifest.publicName,
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
/**
 * The pointer that turns a listing into a two-step flow (owner directive D2:
 * "na samej górze każdego listowania"). Built from the FIRST returned public
 * name so the example is always concretely correct for the namespace just
 * listed, rather than a hard-coded name that may not exist in it.
 */
function buildListNextStep(firstPublicName: string): string {
  return "These rows are names + one-line summaries only. To get the FULL parameter schema of any"
    + " of them — and make them callable — select them by name:"
    + ` ToolSearch(query="select:${firstPublicName}") (up to ${MAX_SELECT_TOOL_NAMES} names per`
    + " call, comma-separated, the whole namespace at once is fine)."
    + " A selected tool is callable from your NEXT message, not from this one.";
}

function buildNamespaceListing(
  namespace: ProtocolNamespace,
  manifests: readonly ProtocolToolManifest[],
): ProtocolDiscoveryResult {
  const tools = manifests.map(toDiscoveryListItem);
  const firstPublicName = tools[0]?.publicName;
  return {
    // FIRST key of the envelope: `JSON.stringify` preserves insertion order and
    // the model reads the string front-to-back. An empty listing gets no
    // pointer — there is nothing to describe.
    ...(firstPublicName === undefined ? {} : { nextStep: buildListNextStep(firstPublicName) }),
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
    return buildDiscoveryFailure(`Namespace "${namespace}" is reserved and not available through ToolSearch. ${buildDiscoverNamespaceDescription()}`);
  }
  return namespace;
}

/**
 * The sentence that keeps "nothing is silently dropped" true when the session
 * cap evicts an earlier round.
 *
 * Shared by BOTH recording paths — `ToolSearch` query mode and select mode —
 * because the eviction is a property of the session cap, not of the mode that
 * happened to trigger it. Surfacing it on only one path is what let a tool the
 * model had been told was callable stop being callable with no signal, and one
 * owner for the sentence is what keeps the two modes word-for-word identical.
 *
 * Returns `null` when nothing was displaced, so a caller can never manufacture
 * a warning for a call that evicted nothing.
 *
 * The input is toolIds (that is what the session records); the sentence names
 * the PUBLIC NAMES, because "no longer callable by name" is a statement about
 * the name the model would have typed. An id with no live manifest is named
 * as-is rather than dropped: a warning about a vanished tool must not itself
 * vanish.
 */
export function buildDisplacementWarning(displaced: readonly string[]): string | null {
  if (displaced.length === 0) return null;
  const names = displaced.map((id) => getProtocolManifest(id)?.publicName ?? id);
  return (
    `${names.map((name) => `"${name}"`).join(", ")} ${displaced.length === 1 ? "is" : "are"} `
    + "no longer callable by name — this session keeps the most recent "
    + `${MAX_DISCOVERED_TOOLS_PER_SESSION} discovered tools. Search for or select them again if `
    + "you still need them."
  );
}

/**
 * One rejection sentence naming the tool and the REAL reason it cannot be made
 * callable.
 *
 * Exported because `ToolSearch` select mode is the only caller and it lives in
 * the dispatcher lane (`dispatcher/tool-search-select.ts`), while the gate it
 * explains — {@link evaluateManifestDiscoverability} — is owned here. Keeping
 * the gate and its wording in one module is what stops a rejection reason from
 * drifting away from the condition that produced it.
 */
export function describeManifestRejection(
  publicName: string,
  outcome: Exclude<ManifestDiscoverability, { ok: true }>,
): string {
  switch (outcome.reason) {
    case "env_missing":
      // Env var NAMES only — a name is configuration, a value is a secret.
      return `"${publicName}" is unavailable right now: set ${outcome.missingEnv?.join(", ")} to enable it.`;
    case "not_advertised":
      return `"${publicName}" is not reachable through ToolSearch. `
        + "Use the SwapQuote / BridgeQuote shortcuts for that capability instead.";
    case "inactive":
      return `"${publicName}" is retired and no longer executable.`;
  }
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
  const filteredTools = PROTOCOL_TOOLS
    .filter((manifest) => resolvedNamespace ? manifest.namespace === resolvedNamespace : true)
    // The advertised / lifecycle+env gates, shared verbatim with select mode
    // so neither path can reach a manifest the other hides.
    // This consumes `.ok` only; the reason is for the id-by-id caller.
    .filter((manifest) => evaluateManifestDiscoverability(manifest).ok);

  if (request.list === true) {
    if (typeof resolvedNamespace !== "string") {
      return buildDiscoveryFailure(
        `A listing requires a namespace — listing every protocol at once is not available. ${buildDiscoverNamespaceDescription()}`,
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
