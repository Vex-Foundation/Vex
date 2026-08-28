/**
 * Tool Map (system-prompt-facing categorization).
 *
 * Ordered, visibility-coherent categorization of the agent-surface tools used
 * to render the `# Available Tool Map` system-prompt section, plus the
 * per-context projection (`getVisibleToolsByCategory`). Consumes
 * `getVisibleToolDefs` from `./visibility.js`; never imports the `registry.js`
 * façade (cycle).
 */

import { getVisibleToolDefs, type ToolVisibilityContext } from "./visibility.js";

/**
 * Ordered, visibility-coherent categorization of the agent-surface tools
 * used to render the `# Available Tool Map` system-prompt section. The
 * map's ORDER carries model-priority intent (e.g. protocol discovery /
 * execution first because everything mutating routes through them; reads
 * before writes within each substrate; runtime safety nets like
 * `CompactApply` next to the substrate they protect). Do NOT alphabetize
 * within categories — the declaration order is the LLM-facing order.
 */
export interface ToolMapCategory {
  /** Visible label rendered before the comma-separated tool names. */
  label: string;
  /** Tool names in render order. Must resolve to registered ToolDefs. */
  toolNames: readonly string[];
}

export const TOOL_MAP_CATEGORIES: readonly ToolMapCategory[] = [
  // ONE entry, always present. `ToolSearch` carries all three modes (search,
  // select, namespace listing) and is the only entry point to the protocol
  // surface, which is why it has no visibility gate: hiding the door is not a
  // security control, and D2 retired the reveal that used to hide half of it.
  // A selected protocol tool is injected as a real function schema
  // (`registry/injected-protocol-tools.ts`) and called by its own name, so
  // there is no model-facing execution wrapper to list here either — the
  // `execute_tool` ToolDef is deleted and its dispatch route survives solely
  // for approval resume.
  { label: "Protocol tool search", toolNames: ["ToolSearch"] },
  { label: "Live state reads", toolNames: ["WalletBalances", "ChainRead", "AgentScan"] },
  { label: "Local-chain token pinning (Robinhood — DB bookmark, no tx)", toolNames: ["WalletTrackToken"] },
  { label: "Token resolution", toolNames: ["TokenFind"] },
  // Sits with the reads because it is one: exact arithmetic the model must not
  // do in its head (wei/gwei, raw/human, bps, USD).
  { label: "Unit and fee math (exact, no rounding up)", toolNames: ["UnitsConvert"] },
  {
    // VENUE PREFERENCE, stated not enforced (owner decision D4). The venue
    // tools are always visible; the label is where the model learns which one
    // to reach for first, because hiding a venue is what used to "enforce" the
    // preference and that cost the agent its fallback exactly when the primary
    // venue failed. Approval, not visibility, is what protects the money.
    label: "Swap & bridge previews (read-only) — KyberSwap is the primary swap route and Khalani the primary bridge route; the venue-named tools are alternatives for when the primary cannot serve the pair or route",
    toolNames: [
      "SwapQuote",
      "SwapQuoteUniswap",
      "TokenCheck",
      "BridgeQuote",
      "BridgeQuoteRelay",
      "BridgeStatus",
    ],
  },
  {
    label: "Swap & bridge execution (on-chain — quote first, same venue) — SwapExecute and BridgeExecute are the primary routes; execute on the venue you quoted on",
    toolNames: ["SwapExecute", "SwapExecuteUniswap", "BridgeExecute", "BridgeExecuteRelay"],
  },
  { label: "Research", toolNames: ["WebResearch", "TwitterAccount"] },
  {
    label: "Session memory — this conversation/mission only",
    toolNames: ["SessionMemorySearch", "SessionMemoryResolve"],
  },
  {
    label: "Long-term memory recall — durable cross-session lessons (search/get/history)",
    toolNames: ["MemorySearch", "MemoryGet", "MemoryHistory"],
  },
  {
    label: "Long-term memory — suggest a durable cross-session lesson (staged, not written)",
    toolNames: ["MemorySuggest"],
  },
  { label: "Context compaction — applies the prepared summary", toolNames: ["CompactApply"] },
  { label: "Wallet transfers", toolNames: ["WalletSendPrepare", "WalletSendConfirm"] },
  // Its own category, not an entry under "Wallet transfers": a transfer intent
  // and a generic transaction intent live in different tables with different
  // confirms, and neither confirm may consume the other's row.
  {
    label: "Arbitrary transaction signing (decoded and fee-capped)",
    toolNames: [
      "WalletEvmTransactionPrepare",
      "WalletEvmTransactionConfirm",
      "WalletSolanaTransactionPrepare",
      "WalletSolanaTransactionConfirm",
    ],
  },
  // Also its own category, and for the same reason: a wrap intent has its own
  // table and its own confirm. The label names the venue refusal because that
  // is the situation an agent is usually in when it needs this pair.
  {
    label: "Native <-> wrapped-native conversion (1:1, no route; the answer when a swap venue refuses that pair)",
    toolNames: ["WalletWrapPrepare", "WalletWrapConfirm"],
  },
  { label: "Mission setup draft", toolNames: ["MissionDraftUpdate"] },
  { label: "Mission run stop", toolNames: ["MissionStop"] },
  // NOT mission-only: owner decree 2026-08-03 made waiting available to full
  // agent sessions too (`requiresAutonomousLoop`), so the label names the
  // PATTERN — the same one `engine/prompts/execution-policy.ts` teaches — and
  // no longer implies a mission-run-scheduling niche.
  { label: "Waiting — park the loop until an event you cannot make happen sooner", toolNames: ["LoopDefer"] },
  { label: "Plan mode (session-scoped — author the action plan)", toolNames: ["PlanWrite"] },
  // Last, because it ENDS a turn: once a board is staged the runtime refuses
  // every further tool call until the reply is written.
  {
    label: "Presentation - show market analysis as a board attached to your final reply (terminal: call it alone, then reply)",
    toolNames: ["BoardCompose"],
  },
];

/**
 * Project the Tool Map for a given visibility context — drops categories
 * whose every tool is hidden by the filter chain, preserves declared
 * order within each surviving category. Consumed by
 * `buildToolCatalogPrompt` to render the system-prompt Tool Map section.
 */
export interface VisibleToolMapCategory {
  label: string;
  toolNames: readonly string[];
}

export function getVisibleToolsByCategory(
  ctx: ToolVisibilityContext,
): readonly VisibleToolMapCategory[] {
  const visibleNames = new Set(getVisibleToolDefs(ctx).map(t => t.name));
  const result: VisibleToolMapCategory[] = [];
  for (const category of TOOL_MAP_CATEGORIES) {
    const surviving = category.toolNames.filter(name => visibleNames.has(name));
    if (surviving.length > 0) {
      result.push({ label: category.label, toolNames: surviving });
    }
  }
  return result;
}
