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
 *  - A DOTTED tool name is itself a protocol `toolId` (main canonicalizes the
 *    injected wire name), and resolves through the same curated exact-id path
 *    as `execute_tool`'s args-borne id.
 *  - A manifest that MULTIPLEXES preview and execution behind a `dryRun`
 *    parameter (`relay.bridge`, `khalani.bridge`, every mutating Pendle
 *    manifest) may not claim EXECUTED on a dry run — see `mutatingUnlessDryRun`.
 *  - `execute_tool` carries its real target in the `toolId` inside UNTRUSTED
 *    args. Untrusted text may only ever DOWNGRADE a claim, never upgrade one,
 *    so a `toolId` is read for one purpose only: a `quote` segment (e.g.
 *    `kyberswap.swap.quote`, `khalani.quote.get`) proves a PREVIEW and earns
 *    the "Quote" label. Mutating identity is NEVER derived from a PARSED
 *    `toolId` shape — every other curated `execute_tool` act is `unproven` and
 *    is labelled.
 *  - The ONE exception is the CURATED EXACT-ID map below (`TOOL_ID_OPERATIONS`,
 *    Trench Express and pools.fun today). Those protocols have no top-level tool name of
 *    their own — the engine dispatches them by that exact `toolId` string — so
 *    the id is load-bearing ROUTING input, matched here whole against a set we
 *    wrote, never a shape inferred from attacker-chosen text. A name outside
 *    the set falls through to the fail-closed rules above unchanged.
 *  - An `execute_tool` whose namespace is not curated (`protocol === null`,
 *    per `toolIdentity.ts`'s provenance gate) gets NO legs at all.
 *
 * Pure: no React, no IO.
 */

import { isDottedProtocolToolId } from "./toolIdentity.js";

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
 * through `execute_tool` (Trench Express, `tools/protocols/trench/manifests/`,
 * Morpho, `tools/protocols/morpho/manifests/`, and pools.fun,
 * `tools/protocols/pools/manifests/`).
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

  // pools.fun (`tools/protocols/pools/manifests/`). The five reads carry no
  // money legs at all; without these rows the fall-through would label each one
  // "unproven" and draw a leg line under a market-data call.
  ["pools.tokens", null],
  ["pools.search", null],
  ["pools.candles", null],
  ["pools.token", null],
  ["pools.my_launches", null],
  // `launch_request_form` drafts a row and spends nothing, exactly like its
  // Trench counterpart. `launch_preview` is ADVISORY: it prices a launch and
  // writes a `previewed` intent row, but signs nothing, so it is a quote and
  // must never render as an executed launch.
  ["pools.launch_request_form", null],
  ["pools.launch_preview", "quote"],
  ["pools.launch_execute", "mutating"],
  ["pools.claim_fees", "mutating"],

  // Swap and bridge acts, verified against the manifests. Relay's mutating tool
  // is the two-segment `relay.bridge` and its quote is `relay.quote.get`; same
  // for Khalani. Pendle's mutating ids are deliberately NOT listed: their leg
  // keys have not been checked against `toolLegs.ts`, and a labelled `unproven`
  // line is the honest default until someone verifies them against a capture.
  ["kyberswap.swap.quote", "quote"],
  ["kyberswap.swap.execute", "mutating"],
  ["uniswap.swap.quote", "quote"],
  ["uniswap.swap.execute", "mutating"],
  ["solana.swap.quote", "quote"],
  ["solana.swap.execute", "mutating"],
  ["relay.quote.get", "quote"],
  ["relay.bridge", "mutating"],
  ["khalani.quote.get", "quote"],
  ["khalani.bridge", "mutating"],

  // Morpho lending, verified against `tools/protocols/morpho/manifests/*` and
  // the funded probe of 2026-08-17. The nine reads move nothing and carry no
  // legs. `morpho.vault.quote` is the read-only preview of a supply/redeem.
  // The two executing ids are the vault supply and redeem the probe settled on
  // Base; BOTH take `dryRun` (mutation-matrix `previewSupport: true`), whose
  // preview returns `success: true` and signs nothing, so their `mutating`
  // verdict is routed through `mutatingUnlessDryRun` exactly like the bridges.
  // Without these rows both executions fell through to the fail-closed
  // `unproven` label, which under-claimed a settled deposit.
  ["morpho.markets.discover", null],
  ["morpho.market.get", null],
  ["morpho.markets.activity", null],
  ["morpho.vaults.discover", null],
  ["morpho.vault.get", null],
  ["morpho.rewards.get", null],
  ["morpho.positions.get", null],
  ["morpho.wallet.balance", null],
  ["morpho.vault.quote", "quote"],
  ["morpho.vault.deposit", "mutating"],
  ["morpho.vault.withdraw", "mutating"],

  // Morpho BLUE market acts. `morpho.market.quote` is the read-only preview of
  // a market operation and signs nothing. The four executes each move exactly
  // one token: the wallet SENDS on `supplyCollateral` / `repay` and RECEIVES on
  // `withdrawCollateral` / `borrow`. Their `mutating` verdict is routed through
  // `mutatingUnlessDryRun` like every other one here, so a rehearsal that
  // returns `success: true` without signing can never claim an execution.
  ["morpho.market.quote", "quote"],
  ["morpho.market.supplyCollateral", "mutating"],
  ["morpho.market.withdrawCollateral", "mutating"],
  ["morpho.market.borrow", "mutating"],
  ["morpho.market.repay", "mutating"],
]);

/**
 * A manifest that multiplexes preview and execution behind `dryRun`
 * (`relay.bridge`, `khalani.bridge`, every Pendle mutating manifest) may not
 * claim EXECUTED on a dry run: those previews return `success: true`, and an
 * unlabelled "executed bridge" for a call that moved nothing is exactly the
 * rule-90 failure the leg ladder exists to prevent.
 *
 * STRICT TRI-STATE — anything that is not a proven boolean claims LESS:
 *
 *   dryRun === true                      -> "quote"     (a preview that succeeded)
 *   dryRun === false, or absent          -> "mutating"
 *   dryRun present with any other value  -> "unproven"  (null, "true", 1, {} …)
 *   args unreadable / truncated / not an object -> "unproven"
 *   top-level and nested values BOTH present and disagreeing -> "unproven"
 *
 * PRECEDENCE, stated because "read both" is ambiguous: a DOTTED call is a direct
 * manifest call and its params ARE the top-level record, so only the top level
 * is read. A legacy `execute_tool` call carries them under `params`, so only
 * `params` is read. The conflict rule exists for the malformed case where a
 * legacy envelope also carries a top-level `dryRun`.
 *
 * `"unproven"` (not `null`) is the right fail-closed value: it still renders a
 * VISIBLY LABELLED "Completed" line rather than silently dropping the act's legs.
 */
function mutatingUnlessDryRun(
  toolArgs: string | null,
  lane: "dotted" | "envelope",
): ToolOperation {
  const record = parseArgsRecord(toolArgs);
  if (record === null) return "unproven";

  const topLevel = record["dryRun"];
  if (lane === "dotted") return dryRunToOperation(topLevel);

  const nested = readParamsRecord(record);
  const nestedValue = nested === null ? undefined : nested["dryRun"];
  if (topLevel !== undefined && nestedValue !== undefined && topLevel !== nestedValue) {
    return "unproven"; // two sources, disagreeing — prove nothing
  }
  return dryRunToOperation(nestedValue ?? topLevel);
}

function dryRunToOperation(value: unknown): ToolOperation {
  if (value === undefined || value === false) return "mutating";
  if (value === true) return "quote";
  return "unproven";
}

/** The `params` sub-object of a legacy `execute_tool` envelope, if it is one. */
function readParamsRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  const params = record["params"];
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  return params as Record<string, unknown>;
}

/** The sanitized args parsed as a plain object, or null at any failure. */
function parseArgsRecord(toolArgs: string | null): Record<string, unknown> | null {
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
  return parsed as Record<string, unknown>;
}

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
  // A dotted name IS the protocol toolId — read before the lower-casing below,
  // because `dexscreener.tokenPairs` must keep its case.
  if (isDottedProtocolToolId(toolName)) {
    return operationForToolId(toolName, curatedProtocol, toolArgs, "dotted");
  }

  const name = toolName.toLowerCase();

  if (QUOTE_TOOLS.has(name)) return "quote";
  if (MUTATING_TOOLS.has(name)) return "mutating";

  if (name === "execute_tool") {
    return operationForToolId(parseToolId(toolArgs), curatedProtocol, toolArgs, "envelope");
  }

  // A swap/bridge-family name we do not know by name: legs, always labelled.
  if (name.startsWith("swap_") || name.startsWith("bridge_")) return "unproven";

  return null;
}

/**
 * One curated-id path, shared by the dotted lane and the legacy `execute_tool`
 * envelope. Every `mutating` verdict is routed through `mutatingUnlessDryRun`,
 * so a manifest that gains a `dryRun` parameter tomorrow is safe by default.
 */
function operationForToolId(
  toolId: string | null,
  curatedProtocol: string | null,
  toolArgs: string | null,
  lane: "dotted" | "envelope",
): ToolOperation | null {
  if (curatedProtocol === null) return null; // unproven venue → no legs
  if (toolId !== null && TOOL_ID_OPERATIONS.has(toolId)) {
    const operation = TOOL_ID_OPERATIONS.get(toolId) ?? null;
    return operation === "mutating" ? mutatingUnlessDryRun(toolArgs, lane) : operation;
  }
  return toolIdIsQuote(toolId) ? "quote" : "unproven";
}
