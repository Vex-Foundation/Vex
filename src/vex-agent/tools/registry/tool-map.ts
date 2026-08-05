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
 * `compact_apply` next to the substrate they protect). Do NOT alphabetize
 * within categories — the declaration order is the LLM-facing order.
 */
export interface ToolMapCategory {
  /** Visible label rendered before the comma-separated tool names. */
  label: string;
  /** Tool names in render order. Must resolve to registered ToolDefs. */
  toolNames: readonly string[];
}

export const TOOL_MAP_CATEGORIES: readonly ToolMapCategory[] = [
  // Discovery ONLY. A discovered protocol tool is injected as a real function
  // schema (`registry/injected-protocol-tools.ts`) and called by its own dot
  // name, so there is no model-facing execution wrapper left to list here;
  // `execute_tool` is withheld from the model surface (`registry/visibility.ts`)
  // and its dispatch route survives solely for approval resume.
  // `describe_tools` is reveal-gated (R5): it appears here only once this
  // session has produced a successful discover_tools result, which is exactly
  // when the follow-up fetch becomes meaningful.
  { label: "Protocol discovery", toolNames: ["discover_tools", "describe_tools"] },
  { label: "Live state reads", toolNames: ["wallet_balances", "chain_read", "agent_scan"] },
  { label: "Local-chain token pinning (Robinhood — DB bookmark, no tx)", toolNames: ["wallet_track_token"] },
  { label: "Token resolution", toolNames: ["token_find"] },
  {
    label: "Swap & bridge previews (read-only)",
    // `bridge_quote_relay` mirrors `swap_quote_uniswap`: a hidden, route-bound
    // reveal pair (see registry/relay-reveal.ts) that sits right after its
    // always-visible counterpart once revealed.
    toolNames: [
      "swap_quote",
      "swap_quote_uniswap",
      "token_check",
      "bridge_quote",
      "bridge_quote_relay",
      "bridge_status",
    ],
  },
  {
    label: "Swap & bridge execution (on-chain — quote first)",
    // `bridge_execute_relay` mirrors `swap_execute_uniswap` (hidden reveal pair).
    toolNames: ["swap_execute", "swap_execute_uniswap", "bridge", "bridge_execute_relay"],
  },
  { label: "Research", toolNames: ["web_research", "twitter_account"] },
  {
    label: "Session memory — this conversation/mission only",
    toolNames: ["session_memory_search", "session_memory_resolve_item"],
  },
  {
    label: "Long-term memory recall — durable cross-session lessons (search/get/history)",
    toolNames: ["long_memory_search", "long_memory_get", "long_memory_history"],
  },
  {
    label: "Long-term memory — suggest a durable cross-session lesson (staged, not written)",
    toolNames: ["long_memory_suggest"],
  },
  { label: "Context compaction — applies the prepared summary", toolNames: ["compact_apply"] },
  { label: "Wallet transfers", toolNames: ["wallet_send_prepare", "wallet_send_confirm"] },
  { label: "Mission setup draft", toolNames: ["mission_draft_update"] },
  { label: "Mission run stop", toolNames: ["mission_stop"] },
  // NOT mission-only: owner decree 2026-08-03 made waiting available to full
  // agent sessions too (`requiresAutonomousLoop`), so the label names the
  // PATTERN — the same one `engine/prompts/execution-policy.ts` teaches — and
  // no longer implies a mission-run-scheduling niche.
  { label: "Waiting — park the loop until an event you cannot make happen sooner", toolNames: ["loop_defer"] },
  { label: "Plan mode (session-scoped — author the action plan)", toolNames: ["plan_write"] },
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
