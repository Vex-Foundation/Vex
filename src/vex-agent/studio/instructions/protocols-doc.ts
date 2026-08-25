/**
 * `.vex/protocols.md`: the RICH declarations the `AGENTS.md` managed block
 * deliberately does not carry.
 *
 * The managed block is compact because it sits inside a file every agent loads
 * on every turn. The full picture - which protocols exist, which tools each one
 * exports, which of them move funds and which environment variable a tool needs
 * - belongs in a document an agent reads when it wants it. Same split as the
 * MCP handshake string versus `tools/list`.
 *
 * GENERATED FROM THE LIVE INVENTORY, exactly like
 * `tool-surface-spec/studio-mcp/exported-tools.md`, and reviewed the same way:
 * `pnpm generate:studio-protocols-doc` writes the committed copy and
 * `--check` fails CI when it drifts. A project's `.vex/protocols.md` is a copy
 * of these bytes, so the committed artifact IS what agents read.
 *
 * Descriptions are NOT reproduced here, for the same reason the exported-tools
 * doc omits them: the registry is their one home, and copying 159 of them into
 * a Markdown file would create a second, immediately stale source for the text
 * a model acts on. Nothing is cut - what is omitted is named, and the whole
 * description is always available from `tools/list`.
 */

import { buildStudioInventory } from "../../mcp/inventory/index.js";
import type { StudioTool } from "../../mcp/inventory/types.js";

/** Escape the only character that can break a Markdown table row. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function toolRow(tool: StudioTool): string {
  return [
    "",
    cell(tool.publicName),
    cell(tool.title),
    tool.annotations.readOnlyHint ? "read-only" : "mutating",
    tool.annotations.destructiveHint ? "yes" : "no",
    tool.requiresEnv ?? "-",
    "",
  ].join(" | ").trim();
}

const TABLE_HEADER = [
  "| tool | title | access | destructive | requires env |",
  "| --- | --- | --- | --- | --- |",
];

export function renderStudioProtocolsDoc(): string {
  const inventory = buildStudioInventory();
  const internal = inventory.filter((tool) => tool.kind === "internal");
  const protocol = inventory.filter((tool) => tool.kind === "protocol");
  const namespaces = [...new Set(protocol.map((tool) => tool.namespace ?? ""))];

  const lines: string[] = [
    "# Vex protocols and tools",
    "",
    "GENERATED FILE. Do not edit by hand.",
    "",
    "Regenerate with `pnpm generate:studio-protocols-doc`; CI runs the same",
    "command with `--check` and fails when this file and the live inventory",
    "disagree. Vex copies these bytes into a project as `.vex/protocols.md`.",
    "",
    "## How to use this",
    "",
    "Every tool below is callable directly by the name in the `tool` column,",
    "through the `vex` MCP server. There is no activation step. Call",
    "`vex_ToolSearch` (read-only, runs nothing) when you know what you want to do",
    "but not which tool does it.",
    "",
    "`access` is the MCP `readOnlyHint`. `destructive` is the MCP",
    "`destructiveHint`: it marks the tools that broadcast a user-wallet",
    "transaction or otherwise cause an irreversible effect. In a restricted",
    "project those calls pause for the user's approval in Vex and can be declined",
    "or expire - read the result, and never retry a call that reports an unknown",
    "or indeterminate outcome.",
    "",
    "`requires env` names an environment variable the tool needs. It is metadata",
    "only: an unmet variable is answered at call time with a typed",
    "`configuration_unavailable` result naming the variable and the remedy.",
    "",
    "Argument contracts and units are on each tool's own description in",
    "`tools/list`, which is their single home. Units are PER FIELD - human",
    "decimals or raw smallest units - so read the field description and never",
    "guess.",
    "",
    "## Totals",
    "",
    `- tools: ${String(inventory.length)}`,
    `- Vex tools: ${String(internal.length)}`,
    `- protocol tools: ${String(protocol.length)} across ${String(namespaces.length)} protocols`,
    `- destructive: ${String(inventory.filter((t) => t.annotations.destructiveHint).length)}`,
    "",
    "## Vex tools",
    "",
    ...TABLE_HEADER,
    ...internal.map(toolRow),
    "",
    "## Protocols",
    "",
  ];

  for (const namespace of namespaces) {
    lines.push(
      `### ${namespace}`,
      "",
      ...TABLE_HEADER,
      ...protocol.filter((tool) => tool.namespace === namespace).map(toolRow),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
