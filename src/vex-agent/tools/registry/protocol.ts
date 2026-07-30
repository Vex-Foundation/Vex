/**
 * Protocol meta-tools — discover_tools + execute_tool.
 *
 * The two tools through which the LLM reaches all protocol capabilities
 * (everything not declared as an internal `kind: "internal"` tool here).
 */

import type { ToolDef, JsonSchema } from "../types.js";
import { buildDiscoverNamespaceDescription } from "../protocols/descriptions.js";

const EXECUTE_TOOL_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    toolId: { type: "string", description: "Protocol tool ID from discover_tools (e.g. 'dexscreener.trending', 'kyberswap.swap.execute'). Must come from a discover_tools result in this session — never from memory, examples, or guesswork." },
    params: { type: "object", description: "Parameters matching the tool's manifest (fields, types). Build the call from the `params` schema returned by discover_tools." },
  },
  required: ["toolId", "params"],
};

const EXECUTE_TOOL_DESCRIPTION = [
  "Execute a discovered protocol tool.",
  "Contract:",
  "- `toolId` must come from `discover_tools` (same session). Long-memory recall may hint at which namespace or approach to try, but the authoritative toolId still comes from discover.",
  "- `params` must match the tool's manifest schema — types, required fields, and value formats as returned by discover (build the call from the `params` schema).",
  "- Mutating tools (check the `mutating` flag from discover) require approval in `restricted`/`off` loop modes. A preview / dryRun variant is a READ: it needs no approval and is safe for iterative planning. Everything mutating needs approval — there is no approval-free mutation.",
  "- On error, diagnose and adapt — do not retry the same call in a tight loop. Present the error and next step to the user or the mission loop.",
].join(" ");

export const PROTOCOL_TOOLS: readonly ToolDef[] = [
  {
    name: "discover_tools", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: [
      "Search advertised protocol tools by short English intent. Write what the user wants to do, including assets, chains, venue, or product hints when useful.",
      "Protocol/product names are allowed in the query as hints: Khalani, KyberSwap, Jupiter, DexScreener. Do not invent dotted toolIds or internal implementation names; use only toolIds returned by this response.",
      "Examples: 'estimate moving 250 USDC from Ethereum to Solana', 'use KyberSwap to preview a USDC to ETH swap on Base', 'use Jupiter to see USDC earn rates', 'show trending meme coins on Solana'.",
      "Optional namespace narrows search to one advertised namespace — the `namespace` parameter's own description lists them. Empty query returns an unranked catalog slice; prefer a refined intent query for normal use.",
      "Results include toolId, mutating, score, whyMatched, params, warnings, hasMore, totalCount, and retrieval.method (dense|lexical|catalog). Every advertised tool is active and executable; build the call from the `params` schema and use the returned toolId with execute_tool in the same session.",
      "Pressure advisory: when context usage is at barrier or critical (≥ 88%), mutating result rows are tagged `unavailable_at_pressure: true`. The dispatcher will hard-deny `execute_tool` on those rows — stay on read-only / preview variants in the same namespace while the runtime compacts. Absent flag means available at the current band.",
    ].join(" "),
    parameters: { type: "object", properties: {
      query: { type: "string", description: "Short English intent/capability phrase. Include protocol/product names when useful (Khalani, KyberSwap, Jupiter, DexScreener), but do not pass dotted tool IDs or internal implementation names." },
      namespace: { type: "string", description: buildDiscoverNamespaceDescription() },
      limit: { type: "number", description: "Max tools to return (default: 5)" },
    } },
  },
  {
    // Wrapper itself is read-only; runtime stamps the TARGET protocol tool's
    // derived actionKind via `executeProtocolTool::deriveProtocolActionKind`,
    // so consumers of `ToolResult.actionKind` see the target classification.
    // See `protocols/runtime.ts` + `taxonomy.ts`.
    name: "execute_tool", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: EXECUTE_TOOL_DESCRIPTION,
    parameters: EXECUTE_TOOL_PARAMS,
  },
];
