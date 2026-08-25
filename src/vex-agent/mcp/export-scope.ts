/**
 * The ONE predicate for what the local Studio MCP server exports.
 *
 * Encodes the owner decision recorded in
 * `tool-surface-spec/mcp-export-scope.md`: the whole agent tool surface EXCEPT
 * the session-bound groups. Memory and engine/runtime tools are agent-session
 * concerns (missions, plan mode, session memory, compaction) bound to the
 * in-app session lifecycle; an external coding agent brings its own planning
 * and memory, and MCP 2026-07-28 requires a `tools/list` that does not vary by
 * connection state, which a session-bound tool cannot satisfy. `execute_tool`
 * is an internal approval-resume envelope and never exports. `ToolSearch`
 * exports as a READ-ONLY catalog search (owner decision D2) through its own
 * adapter, never through the in-app dispatch lane.
 *
 * Written as an EXCLUSION list on purpose. A new tool is exported by default,
 * so adding one that IS session-bound fails the parity test by name and forces
 * the decision to be recorded here and in the doc, rather than silently
 * shipping an unreviewed name to external agents.
 *
 * Stage A4's inventory (`tools/list`) consumes this module; the executor's
 * admission refuses everything it excludes.
 */

import { getAllTools, getToolDef } from "../tools/registry.js";
import { PROTOCOL_TOOLS, getProtocolManifest } from "../tools/protocols/catalog.js";

/**
 * The internal approval-resume envelope. It has no `ToolDef` at all any more,
 * so it can never be `getToolDef`-resolved; it is named here because admission
 * must refuse it BY NAME with the real reason instead of the generic
 * unknown-tool answer.
 */
export const EXECUTE_TOOL_ENVELOPE_NAME = "execute_tool";

/**
 * Session-bound internal tools that are NOT exported. Grouped exactly as the
 * export-scope doc groups them so the parity test can check both directions.
 */
export const NON_EXPORTED_INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  // Memory: session narrative recall and the long-term memory surface.
  "SessionMemorySearch",
  "SessionMemoryResolve",
  "MemorySuggest",
  "MemorySearch",
  "MemoryGet",
  "MemoryHistory",
  // Engine / runtime: mission lifecycle, autonomy loop, compaction, plan mode.
  "MissionDraftUpdate",
  "MissionStop",
  "LoopDefer",
  "CompactApply",
  "PlanWrite",
]);

/** The read-only catalog-search tool, exported through its own adapter. */
export const EXPORTED_TOOL_SEARCH_NAME = "ToolSearch";

/**
 * True iff `name` is a registered internal tool the MCP surface exports.
 *
 * FALSE for an unregistered name: "not a tool" and "not exported" are answered
 * differently by admission, and this predicate decides only the second question
 * for names the registry knows.
 */
export function isExportedInternalTool(name: string): boolean {
  if (name === EXECUTE_TOOL_ENVELOPE_NAME) return false;
  if (NON_EXPORTED_INTERNAL_TOOLS.has(name)) return false;
  return getToolDef(name) !== undefined;
}

/**
 * True iff `toolId` is a protocol manifest the MCP surface exports.
 *
 * EVERY namespace exports (doc: "Protocol tools YES, all namespaces"), so the
 * question is only whether the catalog registers the id. Reachability is a
 * separate concern the runtime owns: a reserved or deprecated namespace still
 * refuses execution, and an env-unmet manifest answers
 * `configuration_unavailable` rather than disappearing from the list.
 */
export function isExportedProtocolTool(toolId: string): boolean {
  return getProtocolManifest(toolId) !== undefined;
}

/** One entry of the exported surface. */
export type ExportedTool =
  | { readonly kind: "internal"; readonly name: string }
  | { readonly kind: "protocol"; readonly toolId: string; readonly publicName: string };

/**
 * The complete exported surface, deterministic in order: internal tools in
 * registry order, then protocol tools in catalog order. Deterministic because
 * `tools/list` must be identical across projects, clients and environments.
 */
export function listExportedTools(): readonly ExportedTool[] {
  const internal: ExportedTool[] = getAllTools()
    .filter((tool) => isExportedInternalTool(tool.name))
    .map((tool) => ({ kind: "internal", name: tool.name }));
  const protocol: ExportedTool[] = PROTOCOL_TOOLS
    .filter((manifest) => isExportedProtocolTool(manifest.toolId))
    .map((manifest) => ({
      kind: "protocol",
      toolId: manifest.toolId,
      publicName: manifest.publicName,
    }));
  return [...internal, ...protocol];
}
