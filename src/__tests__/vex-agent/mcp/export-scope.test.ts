/**
 * The exported surface predicate, checked against the LIVE registry, the LIVE
 * catalog, and the owner's scope document.
 *
 * The direction matters: `mcp-export-scope.md` is verified FROM the predicate,
 * never the reverse. The predicate is what the executor enforces, so the doc is
 * the artifact that can be wrong.
 *
 * Every registry entry and every manifest is checked BY NAME, not by count: a
 * new undocumented internal tool must fail here naming itself, because a count
 * drift can be "fixed" by editing a number while a name cannot.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  EXECUTE_TOOL_ENVELOPE_NAME,
  EXPORTED_TOOL_SEARCH_NAME,
  NON_EXPORTED_INTERNAL_TOOLS,
  NON_EXPORTED_PROTOCOL_TOOLS,
  isExportedInternalTool,
  isExportedProtocolTool,
  listExportedTools,
} from "@vex-agent/mcp/export-scope.js";
import { getAllTools } from "@vex-agent/tools/registry.js";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SCOPE_DOC = resolve(
  REPO_ROOT,
  "src/vex-agent/tools/tool-surface-spec/mcp-export-scope.md",
);

/**
 * The doc writes the tool surface in its own legacy snake_case spelling; the
 * registry is the PascalCase live name. The mapping is stated here, in the
 * test, because it is a documentation concern - production code must not carry
 * a second vocabulary for the same tools (rule 03). A doc name with no live
 * tool, or a live tool with no doc row, fails below.
 */
const DOC_NAME_TO_LIVE_NAME: Readonly<Record<string, string>> = {
  token_find: "TokenFind",
  token_check: "TokenCheck",
  swap_quote: "SwapQuote",
  swap_execute: "SwapExecute",
  swap_quote_uniswap: "SwapQuoteUniswap",
  swap_execute_uniswap: "SwapExecuteUniswap",
  bridge: "BridgeExecute",
  bridge_quote: "BridgeQuote",
  bridge_status: "BridgeStatus",
  bridge_quote_relay: "BridgeQuoteRelay",
  bridge_execute_relay: "BridgeExecuteRelay",
  wallet_balances: "WalletBalances",
  wallet_track_token: "WalletTrackToken",
  wallet_send_prepare: "WalletSendPrepare",
  wallet_send_confirm: "WalletSendConfirm",
  wallet_evm_transaction_prepare: "WalletEvmTransactionPrepare",
  wallet_evm_transaction_confirm: "WalletEvmTransactionConfirm",
  wallet_solana_transaction_prepare: "WalletSolanaTransactionPrepare",
  wallet_solana_transaction_confirm: "WalletSolanaTransactionConfirm",
  wallet_wrap_prepare: "WalletWrapPrepare",
  wallet_wrap_confirm: "WalletWrapConfirm",
  chain_read: "ChainRead",
  agent_scan: "AgentScan",
  web_research: "WebResearch",
  twitter_account: "TwitterAccount",
  units_convert: "UnitsConvert",
  session_memory_search: "SessionMemorySearch",
  session_memory_resolve_item: "SessionMemoryResolve",
  long_memory_suggest: "MemorySuggest",
  long_memory_search: "MemorySearch",
  long_memory_get: "MemoryGet",
  long_memory_history: "MemoryHistory",
  mission_draft_update: "MissionDraftUpdate",
  mission_stop: "MissionStop",
  loop_defer: "LoopDefer",
  compact_apply: "CompactApply",
  plan_write: "PlanWrite",
  board_compose: "BoardCompose",
};

/** Group rows of the decision table that enumerate concrete tool names. */
interface DocGroupRow {
  readonly group: string;
  readonly exported: boolean;
  readonly docNames: readonly string[];
}

function parseDecisionTable(markdown: string): readonly DocGroupRow[] {
  const rows: DocGroupRow[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    // ["", group, export, tools, ""]
    if (cells.length < 5) continue;
    const [, group, exportCell, toolsCell] = cells as [string, string, string, string];
    if (group === "Group" || group.startsWith("---")) continue;
    const docNames = toolsCell
      .split(",")
      .map((name) => name.trim())
      .filter((name) => /^[a-z][a-z0-9_]*$/.test(name));
    if (docNames.length === 0) continue;
    rows.push({ group, exported: exportCell.startsWith("YES"), docNames });
  }
  return rows;
}

const DOC_ROWS = parseDecisionTable(readFileSync(SCOPE_DOC, "utf8"));

describe("Studio MCP export scope - predicate versus the live registry", () => {
  it("classifies EVERY registered internal tool", () => {
    const undecided = getAllTools()
      .map((tool) => tool.name)
      .filter((name) => !isExportedInternalTool(name) && !NON_EXPORTED_INTERNAL_TOOLS.has(name));
    // A name here is a tool nobody decided about: it is neither exported nor on
    // the session-bound exclusion list. Decide it in `export-scope.ts` AND in
    // `mcp-export-scope.md`, do not delete this assertion.
    expect(undecided).toEqual([]);
  });

  it("every excluded name is a real registered tool", () => {
    const live = new Set(getAllTools().map((tool) => tool.name));
    const stale = [...NON_EXPORTED_INTERNAL_TOOLS].filter((name) => !live.has(name));
    expect(stale).toEqual([]);
  });

  it("exports ToolSearch and never the execute_tool envelope", () => {
    expect(isExportedInternalTool(EXPORTED_TOOL_SEARCH_NAME)).toBe(true);
    expect(isExportedInternalTool(EXECUTE_TOOL_ENVELOPE_NAME)).toBe(false);
  });

  it("answers false for a name the registry does not know", () => {
    expect(isExportedInternalTool("NotARealVexTool")).toBe(false);
  });

  // CONTRACT CHANGE (2026-09-04): this used to assert "exports EVERY protocol
  // manifest in the catalog, all namespaces". That is no longer the contract -
  // `NON_EXPORTED_PROTOCOL_TOOLS` names the exceptions - so the assertion is
  // RESTATED rather than weakened: every catalog manifest is still checked by
  // name, and the only ids allowed to be unexported are the ones the set names.
  it("exports every catalog manifest except the ids the exclusion set names", () => {
    const unexpected = PROTOCOL_TOOLS
      .filter((manifest) => !isExportedProtocolTool(manifest.toolId))
      .map((manifest) => manifest.toolId)
      .filter((toolId) => !NON_EXPORTED_PROTOCOL_TOOLS.has(toolId));
    expect(unexpected).toEqual([]);
    expect(isExportedProtocolTool("khalani.not.a.real.tool")).toBe(false);
  });

  it("answers false for every id on the protocol exclusion set", () => {
    const stillExported = [...NON_EXPORTED_PROTOCOL_TOOLS].filter(isExportedProtocolTool);
    expect(stillExported).toEqual([]);
  });

  it("keeps every excluded protocol id out of listExportedTools", () => {
    const listedIds = new Set(
      listExportedTools().flatMap((entry) => (entry.kind === "protocol" ? [entry.toolId] : [])),
    );
    const leaked = [...NON_EXPORTED_PROTOCOL_TOOLS].filter((toolId) => listedIds.has(toolId));
    expect(leaked).toEqual([]);
  });

  it("listExportedTools is the union of both surfaces, deterministic", () => {
    const listed = listExportedTools();
    const internalNames = listed
      .filter((entry) => entry.kind === "internal")
      .map((entry) => (entry.kind === "internal" ? entry.name : ""));
    const expectedInternal = getAllTools()
      .map((tool) => tool.name)
      .filter((name) => isExportedInternalTool(name));
    expect(internalNames).toEqual(expectedInternal);

    const protocolIds = listed
      .filter((entry) => entry.kind === "protocol")
      .map((entry) => (entry.kind === "protocol" ? entry.toolId : ""));
    expect(protocolIds).toEqual(
      PROTOCOL_TOOLS
        .map((manifest) => manifest.toolId)
        .filter((toolId) => isExportedProtocolTool(toolId)),
    );

    // Deterministic: two reads produce the same order.
    expect(listExportedTools()).toEqual(listed);
  });
});

describe("Studio MCP export scope - the document agrees with the predicate", () => {
  it("parses the decision table", () => {
    expect(DOC_ROWS.length).toBeGreaterThan(0);
  });

  it("every documented tool name is a live registered tool", () => {
    const live = new Set(getAllTools().map((tool) => tool.name));
    const unresolved: string[] = [];
    for (const row of DOC_ROWS) {
      for (const docName of row.docNames) {
        const liveName = DOC_NAME_TO_LIVE_NAME[docName];
        if (liveName === undefined || !live.has(liveName)) unresolved.push(docName);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("every documented export decision matches the predicate", () => {
    const disagreements: string[] = [];
    for (const row of DOC_ROWS) {
      for (const docName of row.docNames) {
        const liveName = DOC_NAME_TO_LIVE_NAME[docName];
        if (liveName === undefined) {
          disagreements.push(`${row.group}: no live mapping for ${docName}`);
          continue;
        }
        const actual = isExportedInternalTool(liveName);
        if (actual !== row.exported) {
          disagreements.push(
            `${row.group}: doc says ${row.exported ? "YES" : "NO"} for ${docName} `
            + `(${liveName}), predicate says ${actual ? "YES" : "NO"}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("every live internal tool appears in the document", () => {
    const documented = new Set<string>();
    for (const row of DOC_ROWS) {
      for (const name of row.docNames) {
        const liveName = DOC_NAME_TO_LIVE_NAME[name];
        if (liveName === undefined) throw new Error(`no live mapping for ${name}`);
        documented.add(liveName);
      }
    }
    // `ToolSearch` and `execute_tool` are decided in the meta row, which names
    // them in prose rather than in the comma list the parser reads.
    documented.add(EXPORTED_TOOL_SEARCH_NAME);
    const undocumented = getAllTools()
      .map((tool) => tool.name)
      .filter((name) => !documented.has(name));
    // A name here is a tool that exists but whose export decision is nowhere in
    // `mcp-export-scope.md`. Record the decision in the doc.
    expect(undocumented).toEqual([]);
  });
});

/**
 * The protocol exclusion set and its section of `mcp-export-scope.md`, checked
 * in BOTH directions by name.
 *
 * Deliberately parsed from a bullet list rather than a table: the decision-table
 * parser above reads every line that starts with `| `, so a second table in the
 * same document would be swallowed by it and silently reinterpreted as internal
 * tool names.
 */
describe("Studio MCP export scope - the protocol exclusion set matches the document", () => {
  /** Every ``- `some.tool.id` `` bullet under the exclusion section. */
  function parseDocumentedExclusions(markdown: string): readonly string[] {
    const section = markdown.split("## Protocol tools not exported")[1] ?? "";
    const untilNextHeading = section.split("\n## ")[0] ?? "";
    const ids: string[] = [];
    for (const line of untilNextHeading.split("\n")) {
      const match = /^- `([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)`/.exec(line);
      if (match?.[1] !== undefined) ids.push(match[1]);
    }
    return ids;
  }

  const DOCUMENTED = parseDocumentedExclusions(readFileSync(SCOPE_DOC, "utf8"));

  it("finds the documented exclusion section", () => {
    expect(DOCUMENTED.length).toBeGreaterThan(0);
  });

  it("every documented exclusion is on the predicate's set", () => {
    const missingFromCode = DOCUMENTED.filter((id) => !NON_EXPORTED_PROTOCOL_TOOLS.has(id));
    expect(missingFromCode).toEqual([]);
  });

  it("every excluded id is documented", () => {
    const documented = new Set(DOCUMENTED);
    const missingFromDoc = [...NON_EXPORTED_PROTOCOL_TOOLS].filter((id) => !documented.has(id));
    // A name here is an export decision made in code and recorded nowhere.
    expect(missingFromDoc).toEqual([]);
  });
});
