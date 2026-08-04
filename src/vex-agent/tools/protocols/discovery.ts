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
  ProtocolManifestResult,
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
 * Max toolIds one `describe_tools` call may name. Rejected BY NAME above it,
 * never sliced.
 *
 * DERIVED, not chosen. The owner's flow (directive D2, 2026-08-04) is "agent
 * może pobrać pełny namespace protokołu", so the bound must fit the LARGEST
 * advertised namespace — solana, 34 tools. 40 = 34 + a six-tool tail, so a
 * whole-namespace fetch can be mixed with a little earlier work without being
 * refused. `describe-tools.test.ts` derives both facts from `PROTOCOL_TOOLS`,
 * so a future 41-tool namespace fails the suite instead of silently refusing.
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
export const MAX_DESCRIBE_TOOL_IDS = 40;

/**
 * The dotted-toolId grammar `describe_tools` accepts, applied BEFORE an id is
 * echoed into a rejection message.
 *
 * The count bound bounds the COUNT, not the payload: forty arbitrary strings
 * echoed back would make an unbounded result despite it. 64 is an ECHO bound
 * chosen with headroom over the longest real toolId (30, measured) — it is
 * deliberately NOT "the provider grammar", whose own
 * `^[a-zA-Z0-9_-]{1,64}$` applies to the TRANSFORMED `__` function name rather
 * than to this dotted input. Asserted catalog-wide, so a manifest can never be
 * listable yet unfetchable.
 */
export const DESCRIBE_TOOL_ID_PATTERN = /^[a-zA-Z0-9]+(\.[a-zA-Z0-9_]+)+$/;
export const DESCRIBE_TOOL_ID_MAX_LENGTH = 64;

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

/**
 * The one place a manifest becomes a model-facing row.
 *
 * Ranked discovery spreads it and appends `score`/`whyMatched`;
 * `describe_tools` returns it verbatim. Owner directive D3: the two paths must
 * be indistinguishable, so there is exactly ONE builder. The last time this
 * projection had two implementations, W7's `exampleParams`/`required`/
 * `constraints` reached the ranked row and list mode was left behind.
 */
export function toManifestRow(
  manifest: ProtocolToolManifest,
  contextUsageBand: ProtocolDiscoveryRequest["contextUsageBand"],
  preparationBypassesBarrier: boolean,
): ManifestRow {
  const row: ManifestRow = {
    toolId: manifest.toolId,
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
 * `describe_tools` cannot become a bypass that hands the model a manifest
 * `executeProtocolTool` would then hard-reject.
 *
 * A discriminated result rather than a boolean, deliberately: a boolean cannot
 * tell `describe_tools` WHY an id failed, so the handler would have to
 * re-derive every gate to write a real-cause rejection — duplicating exactly
 * what this extraction unifies. `missingEnv` carries env var NAMES only; a name
 * is configuration, a value is a secret (rule 06).
 */
export type ManifestDiscoverability =
  | { ok: true }
  | {
    ok: false;
    reason: "not_advertised" | "env_missing" | "reveal_gated" | "inactive";
    missingEnv?: string[];
  };

export function evaluateManifestDiscoverability(
  manifest: ProtocolToolManifest,
  sessionId: string | undefined,
): ManifestDiscoverability {
  if (!isAdvertisedProtocolNamespace(manifest.namespace)) {
    return { ok: false, reason: "not_advertised" };
  }
  if (manifest.lifecycle !== "active") return { ok: false, reason: "inactive" };
  if (manifest.requiresEnv && !process.env[manifest.requiresEnv]?.trim()) {
    return { ok: false, reason: "env_missing", missingEnv: [manifest.requiresEnv] };
  }
  // FIX-SPINE round 1, finding 8/C3 — the canonical hidden Uniswap swap
  // manifests stay hidden until this session revealed them.
  if (REVEAL_GATED_UNISWAP_TOOL_IDS.has(manifest.toolId) && !isUniswapPairRevealed(sessionId)) {
    return { ok: false, reason: "reveal_gated" };
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
 * "na samej górze każdego listowania"). Built from the FIRST returned toolId so
 * the example is always concretely correct for the namespace just listed,
 * rather than a hard-coded id that may not exist in it.
 *
 * This is the ONE place on the pre-reveal surface that may name the hidden tool:
 * it is a runtime result, not always-visible prose, so it cannot defeat the
 * reveal the way a static description would.
 */
function buildListNextStep(firstToolId: string): string {
  return "These rows are names + descriptions only. To get the FULL parameter schema of any of them"
    + " — and make them immediately callable by name — call describe_tools with their toolIds"
    + ` (up to ${MAX_DESCRIBE_TOOL_IDS} per call, the whole namespace at once is fine), e.g.`
    + ` describe_tools(toolIds=["${firstToolId}"]).`
    + " A fetched tool is callable on your very next step.";
}

function buildNamespaceListing(
  namespace: ProtocolNamespace,
  manifests: readonly ProtocolToolManifest[],
): ProtocolDiscoveryResult {
  const tools = manifests.map(toDiscoveryListItem);
  const firstToolId = tools[0]?.toolId;
  return {
    // FIRST key of the envelope: `JSON.stringify` preserves insertion order and
    // the model reads the string front-to-back. An empty listing gets no
    // pointer — there is nothing to describe.
    ...(firstToolId === undefined ? {} : { nextStep: buildListNextStep(firstToolId) }),
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

/** What `describeProtocolTools` needs from the calling session. */
export interface ProtocolManifestContext {
  sessionId?: string;
  contextUsageBand?: ProtocolDiscoveryRequest["contextUsageBand"];
  preparationBypassesBarrier?: boolean;
}

/**
 * The sentence that keeps "nothing is silently dropped" true when the session
 * cap evicts an earlier round.
 *
 * Shared by BOTH recording paths — `describe_tools` and ranked `discover_tools`
 * — because the eviction is a property of the session cap, not of the tool that
 * happened to trigger it. Surfacing it on only one path is what let a tool the
 * model had been told was callable stop being callable with no signal.
 *
 * Returns `null` when nothing was displaced, so a caller can never manufacture
 * a warning for a call that evicted nothing.
 */
export function buildDisplacementWarning(displaced: readonly string[]): string | null {
  if (displaced.length === 0) return null;
  return (
    `${displaced.map((id) => `"${id}"`).join(", ")} ${displaced.length === 1 ? "is" : "are"} `
    + "no longer callable by name — this session keeps the most recent "
    + `${MAX_DISCOVERED_TOOLS_PER_SESSION} discovered tools. Discover or describe them again if `
    + "you still need them."
  );
}

/** One rejection sentence naming the id and the REAL reason it could not be returned. */
function describeManifestRejection(
  toolId: string,
  outcome: Exclude<ManifestDiscoverability, { ok: true }>,
): string {
  switch (outcome.reason) {
    case "env_missing":
      // Env var NAMES only — a name is configuration, a value is a secret.
      return `"${toolId}" is unavailable right now: set ${outcome.missingEnv?.join(", ")} to enable it.`;
    case "not_advertised":
    case "reveal_gated":
      return `"${toolId}" is not reachable through discover_tools/describe_tools. `
        + "Use the swap_quote / bridge_quote shortcuts for that capability instead.";
    case "inactive":
      return `"${toolId}" is retired and no longer executable.`;
  }
}

/**
 * `describe_tools` — the full model-facing manifests of explicitly named
 * toolIds, recorded so they are callable by name on the very next step.
 *
 * Resolution is an EXACT `getProtocolManifest` lookup and never
 * `pinExactToolIdMatch`: that is a retrieval heuristic with a unique-prefix
 * fallback, and on an explicitly supplied identifier it would answer
 * `["solana.lend"]` with `solana.lend.deposit` — silent substitution of a
 * different tool, which the reject-by-name decree forbids.
 *
 * Every id passes the SAME gates ranked discovery applies
 * (`evaluateManifestDiscoverability`), so this can never become a bypass that
 * hands the model a manifest `executeProtocolTool` would then hard-reject.
 *
 * Callers must have validated the id array first (count, grammar, shape) —
 * `internal/describe-tools.ts` owns that boundary.
 */
export function describeProtocolTools(
  toolIds: readonly string[],
  ctx: ProtocolManifestContext,
): ProtocolManifestResult {
  const warnings: string[] = [];

  const unique = [...new Set(toolIds)];
  if (unique.length !== toolIds.length) {
    const repeated = [...new Set(toolIds.filter((id, i) => toolIds.indexOf(id) !== i))];
    warnings.push(
      `Requested ${toolIds.length} toolIds but ${repeated.map((id) => `"${id}"`).join(", ")} `
      + `${repeated.length === 1 ? "was" : "were"} repeated — each tool is described once.`,
    );
  }

  const tools: ManifestRow[] = [];
  for (const toolId of unique) {
    const manifest = getProtocolManifest(toolId);
    if (!manifest) {
      warnings.push(
        `"${toolId}" is not a known toolId. Run discover_tools for the namespace and use a `
        + "toolId exactly as returned.",
      );
      continue;
    }
    const discoverability = evaluateManifestDiscoverability(manifest, ctx.sessionId);
    if (!discoverability.ok) {
      warnings.push(describeManifestRejection(toolId, discoverability));
      continue;
    }
    tools.push(toManifestRow(
      manifest,
      ctx.contextUsageBand,
      ctx.preparationBypassesBarrier === true,
    ));
  }

  // Recording is what makes a described tool CALLABLE — owner directive D2's
  // "pobrac informacje odrazu o tym toolu i go wywołać". Same call, same
  // machinery as ranked discovery, so the injected schema is byte-identical.
  const displacement = buildDisplacementWarning(
    recordDiscoveredTools(ctx.sessionId, tools.map((row) => row.toolId)),
  );
  if (displacement !== null) warnings.push(displacement);

  return {
    // A partial batch is a SUCCESS with named losses; only a call where nothing
    // resolved is a failure.
    success: tools.length > 0,
    count: tools.length,
    tools,
    warnings,
    sessionCapacity: {
      used: getDiscoveredToolIds(ctx.sessionId).length,
      max: MAX_DISCOVERED_TOOLS_PER_SESSION,
    },
  };
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
    // The advertised / lifecycle+env / Uniswap-reveal gates, shared verbatim
    // with `describe_tools` so neither path can reach a manifest the other
    // hides. This consumes `.ok` only; the reason is for the id-by-id caller.
    .filter((manifest) => evaluateManifestDiscoverability(manifest, request.sessionId).ok);

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
