/**
 * The Vex Studio MCP INVENTORY - the one ordered `tools/list`.
 *
 * `export-scope.ts` answers WHICH tools export; it is a SET source and its
 * order is whatever the registry and the catalog happen to hold. This module
 * answers what each exported tool LOOKS LIKE to an external agent, and it owns
 * the CANONICAL ORDER. Two owners, because the two questions change for
 * different reasons: adding a tool is an export-scope decision, and how a tool
 * is presented is a product-copy and annotation decision.
 *
 * ## The order is owned here, and it is byte-wise
 *
 * Internal tools first, sorted byte-wise by public name; then protocol tools,
 * sorted byte-wise by `(namespace, publicName)`. The comparator is a plain
 * codepoint comparison - never `localeCompare`, which reorders under a
 * different ICU build or a different `LANG` and would make `tools/list` vary by
 * machine. O20 requires one list for every project, every client and every
 * environment, and a locale-sensitive sort quietly breaks that. Every exported
 * name is ASCII (lint-gated), so codepoint order is also the order a human
 * reads.
 *
 * ## Everything else is read from the live sources
 *
 * `publicName`, `description`, `inputSchema`, `actionKind` and `requiresEnv`
 * come from the registry and the catalog AT RUNTIME, through the SAME canonical
 * projection the in-app provider `tools` array uses
 * (`registry/protocol-tool-projection.ts`). Only the `title` is authored, in
 * `titles.ts`, and only the annotations are derived, in `annotations.ts` from
 * the O7 table. Nothing is copied into this file, so a manifest edit cannot
 * leave a stale duplicate behind.
 *
 * The list NEVER varies. Not by project, not by permission, not by client
 * capability, and not by which provider keys are configured: an env-unmet tool
 * is listed with its `requiresEnv` metadata and answers
 * `configuration_unavailable` when called. Enforcement lives in the executor,
 * never in absence from this list.
 */

import { getToolDef } from "../../tools/registry.js";
import { getProtocolManifest } from "../../tools/protocols/catalog.js";
import {
  protocolToolDescription,
  protocolToolInputSchema,
} from "../../tools/registry/protocol-tool-projection.js";
import {
  EXPORTED_TOOL_SEARCH_DESCRIPTION,
  EXPORTED_TOOL_SEARCH_INPUT_SCHEMA,
  EXPORTED_TOOL_SEARCH_PUBLIC_NAME,
} from "../tool-search-export.js";
import { EXPORTED_TOOL_SEARCH_NAME, listExportedTools } from "../export-scope.js";
import { studioToolAnnotations } from "./annotations.js";
import { STUDIO_TOOL_TITLES } from "./titles.js";
import type { StudioTool } from "./types.js";

export type { StudioTool, StudioToolAnnotations } from "./types.js";
export { studioToolAnnotations, DESTRUCTIVE_ACTION_KINDS } from "./annotations.js";
export { STUDIO_TOOL_TITLES } from "./titles.js";

/**
 * Codepoint comparison. NOT `localeCompare`: the exported order is a wire
 * contract, and a locale-sensitive sort makes it depend on the machine.
 */
function byBytes(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The exported name of an internal tool.
 *
 * `ToolSearch` is the ONE internal tool whose exported name differs from its
 * registry name: it exports as `vex_ToolSearch` through its own read-only
 * adapter (owner decision D2), and admission accepts both spellings. Every
 * other internal tool exports under its registry name.
 */
function internalPublicName(registryName: string): string {
  return registryName === EXPORTED_TOOL_SEARCH_NAME
    ? EXPORTED_TOOL_SEARCH_PUBLIC_NAME
    : registryName;
}

/**
 * The authored title, or a hard failure.
 *
 * THROWS rather than falling back to the tool name. A missing title is an
 * unreviewed row on a surface external agents read, and a silent fallback would
 * ship it looking deliberate. The lint suite turns this into a failing test at
 * build time rather than a crash at connection time.
 */
function requireTitle(publicName: string): string {
  const title = STUDIO_TOOL_TITLES[publicName];
  if (title === undefined || title.trim().length === 0) {
    throw new Error(
      `studio inventory: no authored title for exported tool "${publicName}". `
        + "Add one to src/vex-agent/mcp/inventory/titles.ts in the same change "
        + "that exported the tool.",
    );
  }
  return title;
}

/**
 * Build the whole exported surface, in canonical order.
 *
 * Rebuilt on demand rather than memoized at module load: the registries are
 * module-load constants today, but a cached array would silently become the
 * source of truth for a surface whose whole point is that it is derived, and
 * the cost is a sort of 159 rows.
 */
export function buildStudioInventory(): readonly StudioTool[] {
  const internal: StudioTool[] = [];
  const protocol: StudioTool[] = [];

  for (const exported of listExportedTools()) {
    if (exported.kind === "internal") {
      const def = getToolDef(exported.name);
      if (def === undefined) continue;
      const publicName = internalPublicName(exported.name);
      const isSearch = publicName === EXPORTED_TOOL_SEARCH_PUBLIC_NAME;
      internal.push({
        kind: "internal",
        publicName,
        title: requireTitle(publicName),
        // The search adapter publishes ITS OWN contract: the in-app ToolDef
        // documents a `select:` mode this surface refuses by name.
        description: isSearch ? EXPORTED_TOOL_SEARCH_DESCRIPTION : def.description,
        inputSchema: isSearch ? EXPORTED_TOOL_SEARCH_INPUT_SCHEMA : def.parameters,
        annotations: studioToolAnnotations(def.actionKind),
        // The HOT SET is exactly the internal tools plus `vex_ToolSearch`, and
        // `vex_ToolSearch` IS an internal tool, so the predicate is the lane.
        alwaysLoad: true,
        ...(def.requiresEnv === undefined ? {} : { requiresEnv: def.requiresEnv }),
      });
      continue;
    }

    const manifest = getProtocolManifest(exported.toolId);
    if (manifest === undefined) continue;
    protocol.push({
      kind: "protocol",
      publicName: manifest.publicName,
      toolId: manifest.toolId,
      namespace: manifest.namespace,
      title: requireTitle(manifest.publicName),
      description: protocolToolDescription(manifest),
      inputSchema: protocolToolInputSchema(manifest),
      annotations: studioToolAnnotations(manifest.actionKind),
      alwaysLoad: false,
      ...(manifest.requiresEnv === undefined ? {} : { requiresEnv: manifest.requiresEnv }),
    });
  }

  internal.sort((a, b) => byBytes(a.publicName, b.publicName));
  protocol.sort(
    (a, b) =>
      byBytes(a.namespace ?? "", b.namespace ?? "")
      || byBytes(a.publicName, b.publicName),
  );
  return [...internal, ...protocol];
}

/** The hot set: the names `_meta["anthropic/alwaysLoad"]` is true for. */
export function studioAlwaysLoadNames(): readonly string[] {
  return buildStudioInventory()
    .filter((tool) => tool.alwaysLoad)
    .map((tool) => tool.publicName);
}
