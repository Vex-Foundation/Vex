/**
 * Protocol meta-tools — discover_tools + execute_tool.
 *
 * The two tools through which the LLM reaches all protocol capabilities
 * (everything not declared as an internal `kind: "internal"` tool here).
 */

import type { ToolDef, JsonSchema } from "../types.js";
import { buildDiscoverNamespaceDescription } from "../protocols/descriptions.js";
import { DEFAULT_DISCOVERY_LIMIT, MAX_DISCOVERY_LIMIT } from "../protocols/discovery.js";

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
  // The literal envelope shape appeared nowhere the model could read it; one
  // worked example is the cheapest correction available and ships every request.
  'Example: {"toolId":"dexscreener.search","params":{"query":"VEX","chainIds":"base"}}',
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
      "Protocol/product names are allowed in the query as hints: Khalani, KyberSwap, Jupiter, DexScreener. Passing an exact toolId you already saw is fine — it returns that tool first. Do not invent dotted toolIds or internal implementation names; execute only toolIds returned by this response.",
      "list:true with namespace returns EVERY tool of that protocol as one-line rows (no param schemas) — follow up with a query or the toolId to get params.",
      "Examples: 'estimate moving 250 USDC from Ethereum to Solana', 'use KyberSwap to preview a USDC to ETH swap on Base', 'use Jupiter to see USDC earn rates', 'show trending meme coins on Solana'.",
      "Optional namespace narrows search to one advertised namespace — the `namespace` parameter's own description lists them. Empty query returns an unranked catalog slice; prefer a refined intent query for normal use.",
      "Results include toolId, mutating, actionKind, score, whyMatched, params, warnings, hasMore, totalCount, and retrieval.method (dense|lexical|catalog). Every advertised tool is active and executable; build the call from the `params` schema and call the tool DIRECTLY by its function name in the same session — the returned toolId with every dot replaced by a double underscore, e.g. `kyberswap.swap.quote` becomes the tool `kyberswap__swap__quote`, whose parameters are exactly this row's `params`.",
      "Reading the `params` schema: each entry is {key, type, description} plus, when they apply, `required: true`, `unit`, and `enum`. A param is REQUIRED only when it carries `required: true` — a param with no `required` key at all is OPTIONAL, and so is an explicit `required: false`. `unit` names the domain unit of a numeric param when the bare type is too weak (\"bps\" means basis points, where 100 = 1%); when a param has no `unit`, its description states the unit and you must follow it exactly — an amount is either raw base units or human decimals and the two differ by orders of magnitude. Defaults, value formats, and anything else the schema cannot express are stated in the param's own `description`: read every description of every param you intend to send, and of every param you intend to omit. Each row also carries `required` (the required keys as a list), `exampleParams` (a working call), and `constraints` when params are mutually exclusive. Types and units are literal: a `type: \"number\"` param must be a JSON number, not a string, and an amount param is raw base units or human decimals exactly as its name and description say. Do not convert, round, or guess a unit — resolve decimals with token_find first. Never invent a param the schema does not list; an unknown param is rejected by name, not ignored.",
      "Pressure advisory: when context usage is at barrier or critical (≥ 88%), mutating result rows are tagged `unavailable_at_pressure: true`. The dispatcher will hard-deny a direct call to those tools — stay on read-only / preview variants in the same namespace while the runtime compacts. Absent flag means available at the current band.",
    ].join(" "),
    parameters: { type: "object", properties: {
      query: { type: "string", description: "Short English intent/capability phrase. Include protocol/product names when useful (Khalani, KyberSwap, Jupiter, DexScreener). An exact toolId you already saw is also accepted and is returned first; do not invent dotted tool IDs or internal implementation names." },
      namespace: { type: "string", description: buildDiscoverNamespaceDescription() },
      limit: { type: "number", description: `Max tools to return (default: ${DEFAULT_DISCOVERY_LIMIT}, max ${MAX_DISCOVERY_LIMIT}). Ask for as many as the job needs, up to the max; a higher value is rejected, not clamped. Ignored in list mode.` },
      list: { type: "boolean", description: "List mode: with `namespace`, return EVERY tool of that protocol as one-line rows (toolId, mutating, actionKind, description, requiredParams — no param schemas), unranked and untruncated. Follow up with a query or the toolId to get the full schema before calling. Requires `namespace`." },
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
