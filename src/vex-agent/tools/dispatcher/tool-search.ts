/**
 * The `ToolSearch` dispatch lane - all three modes, one owner.
 *
 * `dispatcher/protocol-route.ts` delegates here so the router keeps stating
 * ROUTE SELECTION and this module owns what the merged meta-tool actually does:
 * parse and derive the mode (`./tool-search-args.ts`), run it, project the
 * result down to the model-facing shape, record the working set, and name what
 * the recording displaced.
 *
 * THE PROJECTION IS THE POINT OF THE MERGE. Discovery still produces FULL rows
 * internally - telemetry logs them, and `recordDiscoveredTools` needs the
 * `toolId` the model no longer sees. {@link toModelDiscoveryResult} is the one
 * place a row becomes model-facing, and it strips the parameter schema
 * (`params`, `required`, `constraints`, `exampleParams`) along with the
 * telemetry-only retrieval mechanics. Those fields now travel exclusively in
 * the injected function schema, which is the channel a provider can enforce;
 * stating them here as well is the duplication `toolsearch-design.md` §3.1
 * removes, and it was the bulk of a ~4 KB tool description.
 *
 * WORKING SET AND DISPLACEMENT ARE UNCHANGED (design §8). The cap stays
 * `MAX_DISCOVERED_TOOLS_PER_SESSION`, displacement stays FIFO, and displaced
 * names stay NAMED to the model. Query mode and select mode now reach the same
 * `buildDisplacementWarning`, which removes the divergence where the same cap
 * took a capability away silently on one path and loudly on the other.
 *
 * NAMESPACE MODE RECORDS NOTHING, deliberately. A listing is a menu; select is
 * the order. It carries no param schema, so injecting its rows would advertise
 * tools with no parameters - which is exactly why the old `list: true` rows
 * were already excluded from recording. The model can therefore browse a large
 * namespace without disturbing its working set.
 */

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "../internal/types.js";
import type {
  ProtocolDiscoveryItem,
  ProtocolDiscoveryListItem,
  ProtocolDiscoveryModelResult,
  ProtocolDiscoveryResult,
  ToolSearchNamespaceRow,
  ToolSearchQueryRow,
} from "../protocols/types.js";
import { discoverProtocolCapabilities } from "../protocols/runtime.js";
import { buildDisplacementWarning, isRankedDiscoveryItem } from "../protocols/discovery.js";
import {
  logDiscoveryTelemetry,
  logSelectTelemetry,
  newDiscoveryRunId,
} from "../protocols/discovery.telemetry.js";
import { toResultData } from "../protocols/handler-helpers.js";
import { recordDiscoveredTools } from "../registry/discovered-tools.js";
import { parseToolSearchArgs, type ToolSearchArgs } from "./tool-search-args.js";
import { selectProtocolTools } from "./tool-search-select.js";

/**
 * The next-request statement carried on every ranked result.
 *
 * Mechanical property of the serving path, not an inference the model can make:
 * the working set is written during dispatch of THIS call, and `getOpenAITools`
 * reads it while assembling the tools array for the NEXT request. Stated so the
 * model does not try to call a fresh name in the same assistant turn and get an
 * unknown-tool refusal for a tool it was just promised.
 */
const QUERY_NEXT_STEP =
  "Each row below is now in your tool list with its full parameter schema, "
  + "callable by its `publicName` from your NEXT message - not from this one. "
  + "The exception is a row tagged `unavailable_at_pressure`: that tool is "
  + "recorded but NOT injected while the context band withholds it, so it does "
  + "not become callable until the band lifts.";

/**
 * One line from a manifest description: everything up to the first sentence
 * break, whitespace-normalized.
 *
 * Sentence 1 is the manifest's own statement of what the tool does - the
 * description style guide makes that the load-bearing sentence - so a search
 * hit can be decidable without carrying the whole paragraph. A description with
 * no sentence break is returned whole rather than truncated mid-word: a summary
 * that ends in a fragment is worse than a slightly long one.
 */
export function toSummaryLine(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  const match = /^(.*?[.!?])(\s|$)/.exec(normalized);
  return match ? match[1]! : normalized;
}

function toQueryRow(item: ProtocolDiscoveryItem): ToolSearchQueryRow {
  return {
    publicName: item.publicName,
    summary: toSummaryLine(item.description),
    whyMatched: item.whyMatched,
    mutating: item.mutating,
    actionKind: item.actionKind,
    // Absent means available - kept as an emit-only-when-true flag so the model
    // has one clear rule and payloads stay minimal.
    ...(item.unavailable_at_pressure === true ? { unavailable_at_pressure: true } : {}),
  };
}

function toNamespaceRow(item: ProtocolDiscoveryListItem): ToolSearchNamespaceRow {
  return {
    publicName: item.publicName,
    summary: toSummaryLine(item.description),
    mutating: item.mutating,
    actionKind: item.actionKind,
    requiredParams: item.requiredParams,
  };
}

/**
 * Project a discovery result into its model-facing shape: slim every row, and
 * strip the telemetry-only `embeddingModel`/`embeddingDim` from `retrieval`.
 *
 * The input `result` is NOT mutated - telemetry/logging downstream still reads
 * the full rows and the full meta (`discovery.telemetry.ts` logs both embedding
 * fields), and the caller still reads `result.tools[].toolId` to record the
 * working set.
 */
export function toModelDiscoveryResult(
  result: ProtocolDiscoveryResult,
): ProtocolDiscoveryModelResult {
  const tools = result.tools.map((item) =>
    isRankedDiscoveryItem(item) ? toQueryRow(item) : toNamespaceRow(item),
  );
  if (!result.retrieval) {
    // Preserve the original (absent) retrieval key rather than forcing it on.
    const { retrieval: _retrieval, ...rest } = result;
    return { ...rest, tools };
  }
  const { embeddingModel: _model, embeddingDim: _dim, ...modelRetrieval } = result.retrieval;
  return { ...result, tools, retrieval: modelRetrieval };
}

/**
 * Compact, NOT pretty-printed: indentation was 15-25% of this payload and the
 * model reads JSON structure, not whitespace.
 */
function toOutput(success: boolean, payload: unknown): ToolResult {
  return { success, output: JSON.stringify(payload), data: toResultData(payload) };
}

async function runRankedOrListing(
  args: Extract<ToolSearchArgs, { mode: "query" | "namespace" }>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const isListing = args.mode === "namespace";
  const discoveryRequest = {
    ...(args.mode === "query" ? { query: args.query } : {}),
    ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
    ...(args.mode === "query" && args.limit !== undefined ? { limit: args.limit } : {}),
    list: isListing,
    contextUsageBand: context.contextUsageBand,
    // C8 mirror: the advisory flag must agree with the gate that will actually
    // run. `=== true` keeps every context without the field on today's tagging.
    preparationBypassesBarrier: context.preparationBypassesBarrier === true,
    // Query mode RECORDS what it returns against the session, which is what
    // admits those manifests to the next request's injected `tools` array.
    sessionId: context.sessionId,
  };

  const result = await discoverProtocolCapabilities(discoveryRequest);
  // Telemetry reads the FULL result (incl. embeddingModel/embeddingDim).
  logDiscoveryTelemetry({
    request: discoveryRequest, result, discoveryRunId: newDiscoveryRunId(),
    sourceSurface: context.sourceSurface, sourceSession: context.sourceSession,
  });

  // Recording BEFORE projection: the model copy no longer carries `toolId`, and
  // the working set is keyed on it. RANKED rows only — a listing row has no
  // param schema, so injecting it would advertise a tool with no parameters.
  const displaced = recordDiscoveredTools(
    context.sessionId,
    result.tools.filter(isRankedDiscoveryItem).map((tool) => tool.toolId),
  );

  const modelResult = toModelDiscoveryResult(result);
  // A new array, because `toModelDiscoveryResult` shares `warnings` with the
  // telemetry result.
  const displacementWarning = buildDisplacementWarning(displaced);
  if (displacementWarning !== null) {
    modelResult.warnings = [...modelResult.warnings, displacementWarning];
  }
  // The listing builds its own `nextStep` (how to select from the menu); a
  // ranked result states the next-request injection fact instead. Empty ranked
  // results get no pointer — there is nothing to call.
  if (!isListing && modelResult.count > 0) {
    modelResult.nextStep = QUERY_NEXT_STEP;
  }

  return toOutput(modelResult.success, modelResult);
}

/**
 * Handle one `ToolSearch` call end to end.
 *
 * Argument rejection returns BEFORE anything runs and before anything is
 * recorded, so a malformed call can never leave the session's working set in a
 * state the model was not told about.
 */
export async function handleToolSearch(
  rawArgs: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const validated = parseToolSearchArgs(rawArgs);
  if (!validated.ok) {
    return { success: false, output: validated.message };
  }

  if (validated.args.mode === "select") {
    const requestedCount = validated.args.publicNames.length;
    const result = selectProtocolTools(validated.args.publicNames, {
      sessionId: context.sessionId,
      contextUsageBand: context.contextUsageBand,
      preparationBypassesBarrier: context.preparationBypassesBarrier === true,
    });
    const output = toOutput(result.success, result);
    logSelectTelemetry({
      requestedCount,
      result,
      payloadChars: output.output.length,
      sourceSurface: context.sourceSurface,
      sourceSession: context.sourceSession,
    });
    return output;
  }

  return runRankedOrListing(validated.args, context);
}
