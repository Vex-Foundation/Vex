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
import { HYPERVEXING_ALIAS_NAMES } from "../hypervexing-aliases.js";

/**
 * Ordered, visibility-coherent categorization of the agent-surface tools
 * used to render the `# Available Tool Map` system-prompt section. The
 * map's ORDER carries model-priority intent (e.g. protocol discovery /
 * execution first because everything mutating routes through them; reads
 * before writes within each substrate; runtime safety nets like
 * `compact_now` next to the substrate they protect). Do NOT alphabetize
 * within categories — the declaration order is the LLM-facing order.
 *
 * Subagent tools (`registry/subagents.ts`) are dormant (empty array); if
 * re-enabled in the future, add a `Subagent control` category here and
 * extend the integrity test in
 * `__tests__/vex-agent/tools/registry-tool-map.test.ts`.
 */
export interface ToolMapCategory {
  /** Visible label rendered before the comma-separated tool names. */
  label: string;
  /** Tool names in render order. Must resolve to registered ToolDefs. */
  toolNames: readonly string[];
}

export const TOOL_MAP_CATEGORIES: readonly ToolMapCategory[] = [
  { label: "Protocol discovery/execution", toolNames: ["discover_tools", "execute_tool"] },
  { label: "Live state reads", toolNames: ["wallet_balances", "chain_read", "portfolio"] },
  { label: "Local-chain token pinning (Robinhood — DB bookmark, no tx)", toolNames: ["wallet_track_token"] },
  {
    label: "Khalani read shortcuts",
    toolNames: [
      "khalani_chains_list",
      "khalani_tokens_top",
      "token_find",
      "khalani_tokens_balances",
    ],
  },
  {
    label: "Swap & bridge previews (read-only)",
    toolNames: ["swap_quote", "token_check", "bridge_quote", "bridge_status"],
  },
  { label: "Swap & bridge execution (on-chain — quote first)", toolNames: ["swap", "bridge"] },
  { label: "Research", toolNames: ["web_research", "twitter_account"] },
  { label: "Runtime overflow recovery", toolNames: ["tool_output_read"] },
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
  { label: "Context compaction — pressure only", toolNames: ["compact_now"] },
  { label: "Wallet transfers", toolNames: ["wallet_send_prepare", "wallet_send_confirm"] },
  { label: "Mission setup draft", toolNames: ["mission_draft_update"] },
  { label: "Mission run stop", toolNames: ["mission_stop"] },
  { label: "Mission run scheduling", toolNames: ["loop_defer"] },
  { label: "Plan mode (session-scoped — author the action plan)", toolNames: ["plan_write"] },
  { label: "Setup/onboarding", toolNames: ["polymarket_setup"] },
  { label: "Hyperliquid workspace", toolNames: ["hyperliquid_enter"] },
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
  const hotAliases = HYPERVEXING_ALIAS_NAMES.filter(name => visibleNames.has(name));
  if (hotAliases.length > 0) {
    result.push({ label: "Hypervexing Hyperliquid hot set", toolNames: hotAliases });
  }
  return result;
}
