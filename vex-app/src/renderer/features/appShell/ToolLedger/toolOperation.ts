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
 *    the "Quote" label. Mutating identity is NEVER derived from args — every
 *    other curated `execute_tool` act is `unproven` and is labelled. There is
 *    therefore no input to this module that makes `execute_tool` render the
 *    bare executed summary.
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

/** True when the `toolId` in the args names a quote step (`…​.quote…`). */
function toolIdIsQuote(toolArgs: string | null): boolean {
  if (toolArgs === null || toolArgs.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolArgs);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const toolId = (parsed as Record<string, unknown>)["toolId"];
  if (typeof toolId !== "string") return false;
  return toolId.split(".").includes("quote");
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
    return toolIdIsQuote(toolArgs) ? "quote" : "unproven";
  }

  // A swap/bridge-family name we do not know by name: legs, always labelled.
  if (name.startsWith("swap_") || name.startsWith("bridge_")) return "unproven";

  return null;
}
