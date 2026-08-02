/**
 * OPERATION IDENTITY for a tool act — the QUOTE / EXECUTION distinction the
 * money-path law (rules/90) makes non-negotiable.
 *
 * `SessionMessageDto.success` means THE TOOL CALL SUCCEEDED. It does not mean
 * funds moved. A successful `swap_quote` is a read-only PREVIEW; a successful
 * `swap_execute` is a broadcast trade. A card that renders both as the same
 * bare "1.5 SOL → 240.31 USDC" summary tells the user a preview was a trade.
 *
 * SOURCE OF TRUTH: `src/vex-agent/tools/registry/action-aliases.ts` — the
 * engine's action-alias registry, where each alias declares `mutating`. The
 * two sets below MIRROR it by exact name; when that registry gains or renames
 * an alias, this map is the renderer-side counterpart to update. It is stated
 * as data here rather than derived, because the renderer is an untrusted-UI
 * process and must not import engine modules (rules/90 process boundaries).
 *
 * FAIL-CLOSED DIRECTION. Everything unproven degrades toward CLAIMING LESS:
 *
 *  - A `swap_*` / `bridge_*` name we do not recognise by exact name (a future
 *    venue variant) is `unproven` — legs render, but always labelled, never as
 *    a bare completed trade.
 *  - `execute_tool` carries its real target in the `toolId` inside UNTRUSTED
 *    args. Untrusted text may only ever DOWNGRADE a claim, never upgrade one,
 *    so a `toolId` is read for one purpose only: a `quote` segment (e.g.
 *    `kyberswap.swap.quote`, `khalani.quote.get`) proves a PREVIEW and earns
 *    the "Quote" label. Mutating identity is NEVER derived from a PARSED
 *    `toolId` shape — every other curated `execute_tool` act is `unproven` and
 *    is labelled.
 *  - The ONE exception is the CURATED EXACT-ID map below (`TOOL_ID_OPERATIONS`,
 *    Trench Express today). Those protocols have no top-level tool name of
 *    their own — the engine dispatches them by that exact `toolId` string — so
 *    the id is load-bearing ROUTING input, matched here whole against a set we
 *    wrote, never a shape inferred from attacker-chosen text. A name outside
 *    the set falls through to the fail-closed rules above unchanged.
 *  - An `execute_tool` whose namespace is not curated (`protocol === null`,
 *    per `toolIdentity.ts`'s provenance gate) gets NO legs at all.
 *
 * Pure: no React, no IO.
 */

/**
 * What kind of money operation this act is:
 *  - `quote`    — proven read-only preview.
 *  - `mutating` — proven fund-moving operation (the only kind that may render
 *                 a bare executed summary).
 *  - `unproven` — a money-shaped act whose kind we cannot prove; always
 *                 labelled.
 * `null` (the absence of an operation) means: not a leg-bearing act at all.
 */
export type ToolOperation = "quote" | "mutating" | "unproven";

/** Read-only preview aliases — mirrors `mutating: false` in action-aliases.ts. */
const QUOTE_TOOLS: ReadonlySet<string> = new Set([
  "swap_quote",
  "swap_quote_uniswap",
  "bridge_quote",
  "bridge_quote_relay",
]);

/**
 * Fund-moving aliases — mirrors `mutating: true` in action-aliases.ts. Note
 * `bridge` is an EXACT name with no `bridge_` prefix; it is the primary
 * mutating bridge and a prefix-only rule silently misses it.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "swap_execute",
  "swap_execute_uniswap",
  "bridge",
  "bridge_execute_relay",
]);

/**
 * Curated EXACT `toolId` → operation, for protocols the engine addresses only
 * through `execute_tool` (Trench Express, `tools/protocols/trench/manifests/`).
 * `null` means the act carries no money legs at all: a read, or a `local_write`
 * that drafts a row and spends nothing (`trench.launch_request_form`, which the
 * manifest marks `mutating: true` for APPROVAL-GATE reasons — no funds move, so
 * the card must not claim an execution).
 *
 * Mirrors those manifests by exact name; when one is added or renamed, this map
 * is the renderer-side counterpart to update. An id absent here is unaffected.
 */
const TOOL_ID_OPERATIONS: ReadonlyMap<string, ToolOperation | null> = new Map<
  string,
  ToolOperation | null
>([
  ["trench.tokens", null],
  ["trench.search", null],
  ["trench.trades", null],
  ["trench.images", null],
  ["trench.my_launches", null],
  ["trench.launch_request_form", null],
  ["trench.trade_quote", "quote"],
  ["trench.launch_preview", "quote"],
  ["trench.trade_execute", "mutating"],
  ["trench.launch_execute", "mutating"],
]);

/** The `toolId` string inside the sanitized args, or null at any failure. */
function parseToolId(toolArgs: string | null): string | null {
  if (toolArgs === null || toolArgs.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolArgs);
  } catch {
    return null; // truncated or malformed — never guess the tail
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const toolId = (parsed as Record<string, unknown>)["toolId"];
  return typeof toolId === "string" && toolId.length > 0 ? toolId : null;
}

/** True when the `toolId` in the args names a quote step (`…​.quote…`). */
function toolIdIsQuote(toolId: string | null): boolean {
  return toolId !== null && toolId.split(".").includes("quote");
}

/**
 * Resolve the operation kind for one act, or `null` when the act carries no
 * money legs. `curatedProtocol` is `ToolIdentity.protocol` — already gated by
 * `isCuratedProtocol`, so an unknown namespace never reaches the leg parser.
 */
export function resolveToolOperation(
  toolName: string,
  curatedProtocol: string | null,
  toolArgs: string | null,
): ToolOperation | null {
  const name = toolName.toLowerCase();

  if (QUOTE_TOOLS.has(name)) return "quote";
  if (MUTATING_TOOLS.has(name)) return "mutating";

  if (name === "execute_tool") {
    if (curatedProtocol === null) return null; // unproven venue → no legs
    const toolId = parseToolId(toolArgs);
    if (toolId !== null && TOOL_ID_OPERATIONS.has(toolId)) {
      return TOOL_ID_OPERATIONS.get(toolId) ?? null;
    }
    return toolIdIsQuote(toolId) ? "quote" : "unproven";
  }

  // A swap/bridge-family name we do not know by name: legs, always labelled.
  if (name.startsWith("swap_") || name.startsWith("bridge_")) return "unproven";

  return null;
}
