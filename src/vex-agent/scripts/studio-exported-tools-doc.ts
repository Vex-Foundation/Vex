/**
 * Generator for `tool-surface-spec/studio-mcp/exported-tools.md`, the reviewed
 * record of what the Vex Studio MCP server exports.
 *
 * The document is an OUTPUT, never a source. It is regenerated from the live
 * inventory (`mcp/inventory/`) so it cannot drift from the surface an external
 * agent actually sees, and it is committed because the diff is the review
 * signal: adding a tool, renaming one, re-titling one or changing an annotation
 * shows up as a reviewable change in the same commit that caused it.
 *
 *   regenerate:  pnpm generate:studio-tools-doc
 *   verify (CI): pnpm generate:studio-tools-doc --check
 *
 * `--check` writes nothing and exits non-zero when the file on disk differs
 * from what the inventory produces, naming the first differing line. It does
 * not print the whole expected document: the remedy is to run the generator.
 *
 * DESCRIPTIONS ARE NOT REPRODUCED HERE. They are up to 6.5 KB each and the
 * registry is their one home; copying 155 of them into a Markdown file would
 * create a second, immediately stale source for the text a model reads. The
 * document carries the exported CONTRACT - name, title, lane, annotations,
 * always-load and the required environment variable - plus each description's
 * byte length, which is the number the O23 budget lint is about.
 *
 * THE SAME ARGUMENT DECIDES THE TWO CONTRACT COLUMNS. `returns` and `vexFee`
 * are authored TEXT (a result shape is up to 1.4 KB, a fee sentence several
 * hundred bytes), and reproducing them for 168 tools would roughly double this
 * file with prose that already has one home - the same second-stale-source
 * mistake the descriptions are kept out for. What the columns carry instead is
 * whether the fact EXISTS, and for a fee the rate itself, because an unauthored
 * money fact is exactly what a reviewer needs to see in a diff. The text is
 * read from `vex_ToolDescribe`, whose result no client truncates.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildStudioInventory } from "../mcp/inventory/index.js";
import { authoredContractFields } from "../mcp/tool-describe-export.js";
import type { StudioTool } from "../mcp/inventory/types.js";

const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../tools/tool-surface-spec/studio-mcp/exported-tools.md",
);

function cell(value: string): string {
  // Only the pipe can break a Markdown table row. Names and titles are
  // authored ASCII, so this is a guard, not a transformation.
  return value.replace(/\|/g, "\\|");
}

/**
 * The fee cell: the RATE when one is charged, `none` for an authored free path,
 * and `-` for a tool that has authored nothing. The three are deliberately
 * distinguishable, because `-` and `none` are different facts about money.
 */
function feeCell(tool: StudioTool): string {
  const { vexFee } = authoredContractFields(tool);
  if (vexFee === undefined) return "-";
  return "none" in vexFee ? "none" : `${String(vexFee.bps)} bps`;
}

function row(tool: StudioTool): string {
  return [
    "",
    cell(tool.publicName),
    cell(tool.title),
    tool.kind,
    tool.annotations.readOnlyHint ? "yes" : "no",
    tool.annotations.destructiveHint ? "yes" : "no",
    tool.alwaysLoad ? "yes" : "no",
    tool.requiresEnv ?? "-",
    String(Buffer.byteLength(tool.description, "utf8")),
    authoredContractFields(tool).returns === undefined ? "-" : "yes",
    feeCell(tool),
    "",
  ].join(" | ").trim();
}

export function renderExportedToolsDoc(): string {
  const inventory = buildStudioInventory();
  const internal = inventory.filter((t) => t.kind === "internal");
  const protocol = inventory.filter((t) => t.kind === "protocol");
  const namespaces = [...new Set(protocol.map((t) => t.namespace ?? ""))];

  const lines: string[] = [
    "# Vex Studio MCP - exported tools",
    "",
    "GENERATED FILE. Do not edit by hand.",
    "",
    "Regenerate with `pnpm generate:studio-tools-doc`; CI runs the same command",
    "with `--check` and fails when this file and the live inventory disagree.",
    "",
    "Source of truth: `src/vex-agent/mcp/inventory/` (order, annotations,",
    "always-load), `src/vex-agent/mcp/export-scope.ts` (which tools export) and",
    "`src/vex-agent/mcp/inventory/titles.ts` (the authored titles).",
    "",
    "The order below IS the `tools/list` order: internal tools byte-wise by name,",
    "then protocol tools byte-wise by (namespace, name). It is identical for every",
    "project, every client and every environment.",
    "",
    "`read only` and `destructive` are the two MCP annotations Vex emits, pinned to",
    "owner decision O7. `idempotentHint` and `openWorldHint` are deliberately",
    "omitted rather than defaulted. `always load` is",
    '`_meta["anthropic/alwaysLoad"]`. `requires env` travels on the wire as',
    '`_meta["vex/requiresEnv"]`, an array of variable NAMES and never values. It',
    "is metadata only: the list never varies by environment, and an unmet",
    "variable is answered at call time with a typed `configuration_unavailable`",
    "result naming the variable and the remedy.",
    "",
    "`description bytes` is the length of the WHOLE description the tool exports.",
    "Nothing is cut at the source; the budget lint asserts the risk class and the",
    "preconditions appear inside the first 2000 bytes, and an ALWAYS-LOADED",
    "description additionally fits whole inside the 2048 CHARACTERS a client",
    "shows before truncating (measured 2026-09-03;",
    "`ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS`). `vex_ToolDescribe` returns any",
    "tool's whole contract in a RESULT, which no client truncates.",
    "",
    "`returns` says whether the tool authored a machine-readable result shape,",
    "and `vex fee` is its authored fee: the RATE when Vex charges, `none` for a",
    "path authored as free, and `-` when nothing is authored. Those last two are",
    "DIFFERENT FACTS and are never collapsed: `vex_ToolDescribe` reports an",
    "unauthored fee as unknown, never as free. Both texts live on the tool",
    "(`ToolDef` and `ProtocolToolManifest`) and are read whole from",
    "`vex_ToolDescribe`, not reproduced here.",
    "",
    "## Totals",
    "",
    `- exported tools: ${String(inventory.length)}`,
    `- internal: ${String(internal.length)}`,
    `- protocol: ${String(protocol.length)} across ${String(namespaces.length)} namespaces`,
    `- always loaded: ${String(inventory.filter((t) => t.alwaysLoad).length)}`,
    `- read-only: ${String(inventory.filter((t) => t.annotations.readOnlyHint).length)}`,
    `- destructive: ${String(inventory.filter((t) => t.annotations.destructiveHint).length)}`,
    "",
    "## Internal tools",
    "",
    "| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...internal.map(row),
    "",
    "## Protocol tools",
    "",
  ];

  for (const namespace of namespaces) {
    lines.push(
      `### ${namespace}`,
      "",
      "| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...protocol.filter((t) => t.namespace === namespace).map(row),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** `undefined` when the file matches, otherwise the first difference. */
export function firstDifference(expected: string, actual: string): string | undefined {
  if (expected === actual) return undefined;
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const limit = Math.max(expectedLines.length, actualLines.length);
  for (let i = 0; i < limit; i++) {
    if (expectedLines[i] !== actualLines[i]) {
      return (
        `line ${String(i + 1)}:\n`
        + `  on disk:  ${actualLines[i] ?? "<end of file>"}\n`
        + `  expected: ${expectedLines[i] ?? "<end of file>"}`
      );
    }
  }
  return "the files differ only in trailing content";
}

function main(): void {
  const expected = renderExportedToolsDoc();
  const checkOnly = process.argv.includes("--check");

  if (!checkOnly) {
    writeFileSync(DOC_PATH, expected, "utf8");
    process.stdout.write(`wrote ${DOC_PATH}\n`);
    return;
  }

  let actual: string;
  try {
    actual = readFileSync(DOC_PATH, "utf8");
  } catch {
    process.stderr.write(
      `${DOC_PATH} is missing. Run \`pnpm generate:studio-tools-doc\` and commit it.\n`,
    );
    process.exit(1);
    return;
  }

  const difference = firstDifference(expected, actual);
  if (difference === undefined) {
    process.stdout.write("studio exported-tools doc is up to date\n");
    return;
  }
  process.stderr.write(
    "studio exported-tools doc is stale.\n"
      + `${difference}\n`
      + "Run `pnpm generate:studio-tools-doc` and review the diff as a contract change.\n",
  );
  process.exit(1);
}

// Run only as a script, never as a side effect of the test importing the
// renderer. Same direct-invocation check the other scripts in this directory
// use, so a symlinked or relative invocation is still recognized.
const invoked = process.argv[1];
if (
  invoked !== undefined
  && import.meta.url === pathToFileURL(realpathSync(invoked)).href
) {
  main();
}
