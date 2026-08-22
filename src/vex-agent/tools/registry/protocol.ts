/**
 * The protocol meta-tool - `ToolSearch`.
 *
 * ONE registration, three modes (search / select / namespace listing), always
 * visible. It is the only entry point to the protocol surface, which is why it
 * carries no visibility gate at all: owner decision D2 retires the manifest-
 * fetch reveal, because select is now a MODE of a tool the model is already
 * using rather than a second tool that appears from nowhere.
 *
 * WHAT DIED HERE, AND WHERE IT WENT.
 *  - The two retired discovery tools merged into this one ToolDef
 *    (`tool-surface-spec/toolsearch-design.md`). Both old spellings resolve
 *    through the alias table (`./name-resolution.ts`).
 *  - `execute_tool`'s ToolDef is RETIRED. The `{toolId, params}` envelope is
 *    not a registered tool any more; it is internal machinery with exactly one
 *    live producer, the approval envelope
 *    (`engine/core/approval-runtime/tool-call-envelope.ts`), and its dispatch
 *    route stays alive in `dispatcher/protocol-route.ts` so a cold approval
 *    resume still runs. Its doctrine moved to `engine/prompts/safety-contract.ts`
 *    and `engine/prompts/execution-policy.ts` first, per
 *    `toolsearch-design.md` §6 - that relocation was the prerequisite for the
 *    deletion, not a follow-up.
 *
 * DESCRIPTION BUDGET. The old search tool's description was roughly 4 KB, most
 * of it protocol doctrine rather than a statement of what searching does. The
 * schema-reading rules, the name mapping and the do-not-invent-ids rule live in
 * `engine/prompts/tool-model.ts`; the pressure advisory in
 * `engine/prompts/context-pressure.ts`. Do not bring them back here.
 */

import type { ToolDef } from "../types.js";
import { buildDiscoverNamespaceDescription } from "../protocols/descriptions.js";
import {
  DEFAULT_DISCOVERY_LIMIT,
  MAX_DISCOVERY_LIMIT,
  MAX_SELECT_TOOL_NAMES,
} from "../protocols/discovery.js";

/**
 * The reserved prefix that turns the free-text `query` field into select mode.
 *
 * ONE string field carries both the intent phrase and the explicit selection
 * (the Claude Code core form the owner selected). The cost is a small grammar
 * at a model-facing boundary; it is paid for by having exactly one parser own
 * it (`dispatcher/tool-search-args.ts`) with by-name rejection on every
 * malformed spelling.
 */
export const TOOL_SEARCH_SELECT_PREFIX = "select:";

const TOOL_SEARCH_DESCRIPTION = [
  "Search the protocol tool catalog and make the tools you pick callable.",
  "Three modes:",
  `(1) SEARCH - \`query\` is a short English intent phrase describing what you want to do, with assets, chains, or venue names (Khalani, KyberSwap, Jupiter, DexScreener) as hints. Returns the ${DEFAULT_DISCOVERY_LIMIT} best-ranked matches by default; raise \`limit\` up to ${MAX_DISCOVERY_LIMIT} when the job needs a bigger working set. Optional \`namespace\` narrows the ranking to one protocol.`,
  `(2) SELECT - \`query: "${TOOL_SEARCH_SELECT_PREFIX}Name1,Name2"\` makes tools you already know the name of callable, 1 to ${MAX_SELECT_TOOL_NAMES} public names per call. Use it after a namespace listing, and to recover a tool whose schema the conversation compacted away.`,
  "(3) NAMESPACE LISTING - `namespace` alone, with no `query`, returns EVERY tool of that protocol as one-line rows carrying its required parameter keys. A listing is a menu: it changes nothing until you select from it.",
  "SEARCH answers with names, one-line summaries and match evidence. SELECT answers with acknowledgement rows only - the name and whether it is now callable - because you already know what you asked for. Neither returns parameter schemas: each tool they return is added to your tool list as a real function carrying its full schema, callable FROM YOUR NEXT MESSAGE and not from this one.",
  `SEARCH also answers with \`count\`, \`totalCount\` and \`hasMore\`: hasMore is true when more capabilities matched than the rows you were shown, and the only way to reach them is a higher \`limit\` (maximum ${MAX_DISCOVERY_LIMIT}) or a narrower query - there is no cursor, page or offset on this tool. A namespace listing always answers hasMore false, because a listing is the whole namespace.`,
  "For a curated internal tool, read the Tool Map instead of searching. For a name that is already callable this session, call it directly rather than selecting it again.",
].join(" ");

export const PROTOCOL_TOOLS: readonly ToolDef[] = [
  {
    name: "ToolSearch", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: TOOL_SEARCH_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Either a short English intent phrase to rank the catalog against, or the reserved form "
            + `\`${TOOL_SEARCH_SELECT_PREFIX}Name1,Name2\` to make tools you already know callable. `
            + "An exact tool name you have already seen is also accepted as a phrase and is returned first, "
            + "as is an unambiguous prefix of one.",
        },
        namespace: { type: "string", description: buildDiscoverNamespaceDescription() },
        limit: {
          type: "number",
          description:
            `Search mode only. Ranked rows to return (default ${DEFAULT_DISCOVERY_LIMIT}, max ${MAX_DISCOVERY_LIMIT}). `
            + "Ask for as many as the job needs, up to the max; a value above it is rejected by name, not clamped.",
        },
      },
      // Mirrors the handler's strict boundary: the provider refuses an unknown
      // argument up front instead of the model learning about it from a
      // rejection. There is deliberately NO `required` array - a bare
      // `namespace` is the listing, a bare `query` is the search, and a call
      // with neither is rejected by name with all three modes stated.
      additionalProperties: false,
    },
  },
];
