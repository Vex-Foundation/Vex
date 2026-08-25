/**
 * The compact model-facing row projection for discovery results.
 *
 * Extracted MOVE-ONLY from `dispatcher/tool-search.ts` (Vex Studio stage A2) so
 * the in-app `ToolSearch` lane and the read-only Studio MCP export adapter
 * project a row through the SAME code. It lives under `protocols/discovery/`
 * rather than in the dispatcher precisely so the MCP surface can import it
 * without importing the in-app lane, which owns select mode and the session
 * working set (`src/__tests__/architecture/mcp-boundary.test.ts` pins that).
 *
 * THE PROJECTION IS THE POINT OF THE MERGE. Discovery still produces FULL rows
 * internally - telemetry logs them, and `recordDiscoveredTools` needs the
 * `toolId` the model no longer sees. {@link toModelDiscoveryResult} is the one
 * place a row becomes model-facing, and it strips the parameter schema
 * (`params`, `required`, `constraints`, `exampleParams`) along with the
 * telemetry-only retrieval mechanics. Those fields now travel exclusively in
 * the injected function schema, which is the channel a provider can enforce.
 *
 * Pure: no session state, no recording, no telemetry.
 */

import type {
  ProtocolDiscoveryItem,
  ProtocolDiscoveryListItem,
  ProtocolDiscoveryModelResult,
  ProtocolDiscoveryResult,
  ToolSearchNamespaceRow,
  ToolSearchQueryRow,
} from "../types.js";
import { isRankedDiscoveryItem } from "../discovery.js";

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

export function toQueryRow(item: ProtocolDiscoveryItem): ToolSearchQueryRow {
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

export function toNamespaceRow(item: ProtocolDiscoveryListItem): ToolSearchNamespaceRow {
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
