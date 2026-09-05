/**
 * The ONE predicate for what the local Studio MCP server exports.
 *
 * Encodes the owner decision recorded in
 * `tool-surface-spec/mcp-export-scope.md`: the whole agent tool surface EXCEPT
 * the session-bound groups and the few tools an MCP client already carries
 * itself. Memory and engine/runtime tools are agent-session
 * concerns (missions, plan mode, session memory, compaction) bound to the
 * in-app session lifecycle; an external coding agent brings its own planning
 * and memory, and MCP 2026-07-28 requires a `tools/list` that does not vary by
 * connection state, which a session-bound tool cannot satisfy. `execute_tool`
 * is an internal approval-resume envelope and never exports. `ToolSearch`
 * exports as a READ-ONLY catalog search (owner decision D2) through its own
 * adapter, never through the in-app dispatch lane.
 *
 * Protocol tools export by namespace, with ONE named exception set
 * ({@link NON_EXPORTED_PROTOCOL_TOOLS}) for tools whose only input lives inside
 * the desktop app and which a caller without that app can therefore never
 * satisfy.
 *
 * Both lists are written as EXCLUSION lists on purpose. A new tool is exported
 * by default, so adding one that IS session-bound or app-bound fails the parity
 * test by name and forces the decision to be recorded here and in the doc,
 * rather than silently shipping an unreviewed name to external agents.
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
  // Presentation: BoardCompose attaches a rendered board to the in-app
  // assistant message and is enforced by the engine turn loop's presentation
  // gate. The MCP path has neither the renderer nor the turn loop, so an
  // external agent could only stage boards nobody can see (merge decision
  // 2026-08-25).
  "BoardCompose",
  // Research: every MCP client that connects (Claude Code, Codex CLI, Gemini
  // CLI) carries its own web search and fetch; exporting a Tavily-keyed
  // duplicate costs a key the user does not need and 2 KB of every session's
  // context. The tool itself is UNCHANGED for the in-app Vex agent, which has
  // no client search of its own (owner decision 2026-09-03).
  "WebResearch",
]);

/** The read-only catalog-search tool, exported through its own adapter. */
export const EXPORTED_TOOL_SEARCH_NAME = "ToolSearch";

/**
 * Protocol tools (by `toolId`, not publicName) that are NOT exported.
 *
 * The launchpads namespace owns the user's local IMAGE LOCKER, and these two
 * tools are the locker's own surface: `launchpads__images_list` lists the
 * pictures the user staged inside the Vex desktop app, and
 * `launchpads__image_publish` publishes locker bytes to a public
 * content-addressed host. An external coding agent on the Studio MCP surface
 * has no locker and no way to stage one - on that surface a launch tool takes
 * an `imagePath` inside the agent's OWN project directory instead. Exporting
 * the locker tools to a surface that can never satisfy them would advertise a
 * capability guaranteed to refuse, which is worse than not advertising it at
 * all: the agent spends a call and a turn to learn what `tools/list` could have
 * told it for free. Both tools are UNCHANGED for the in-app Vex agent, which
 * IS the locker's owner.
 *
 * An id here need not be registered in the catalog: an unregistered id already
 * answers false below, so this set is a second, EARLIER reason to answer false,
 * and it stays correct whether or not the manifests exist in a given tree.
 */
export const NON_EXPORTED_PROTOCOL_TOOLS: ReadonlySet<string> = new Set([
  "launchpads.images",
  "launchpads.image_publish",
]);

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
 * Two questions, in this order: is the id on the named exclusion set
 * ({@link NON_EXPORTED_PROTOCOL_TOOLS}), and does the catalog register it.
 * Every OTHER namespace exports in full. Reachability is a separate concern the
 * runtime owns: a reserved or deprecated namespace still refuses execution, and
 * an env-unmet manifest answers `configuration_unavailable` rather than
 * disappearing from the list.
 *
 * This is the ONE enumerator predicate: `listExportedTools` (which builds
 * `tools/list`), `admitStudioCall` (which dispatches) and `searchExportedTools`
 * (which advertises) all consult it, so no surface can ever show or run a tool
 * another surface withholds.
 */
export function isExportedProtocolTool(toolId: string): boolean {
  if (NON_EXPORTED_PROTOCOL_TOOLS.has(toolId)) return false;
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
