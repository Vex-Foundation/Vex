/**
 * Tool Map — the system-prompt-facing categorization of currently-visible
 * agent tools. Generated dynamically from the SAME filter chain used by
 * `getOpenAITools` so the LLM's tool catalog (the `tools` array on the
 * chat-completion call) and its mental map of "what can I call right now"
 * never drift.
 *
 * Rendering contract:
 *   - Categories listed in `TOOL_MAP_CATEGORIES` order (registry.ts) —
 *     order carries model-priority intent (orientation → reads → memory →
 *     compaction → knowledge → mutations → mission control).
 *   - Tool names within a category preserve their declared order — NOT
 *     alphabetized, because PR3's GREEN-LIGHT design treats ordering as
 *     intent ("read before write" within Wallet, etc).
 *   - Empty categories (every tool filtered out) are dropped — model
 *     should not see stale affordances.
 *   - At pressure barrier+, the dispatcher's hard-deny still backstops
 *     this projection; the Map is the soft signal, the deny is the runtime
 *     enforcement.
 *
 * The builder runs synchronously and is pure — its input is the
 * `ToolVisibilityContext` already computed in `runTurnLoop` for tool
 * projection. No DB, no async, no env reads beyond what `getVisibleToolDefs`
 * already performs internally.
 */

import { getVisibleToolsByCategory, type ToolVisibilityContext } from "../../tools/registry.js";
import { coreMarketReadToolIds } from "../../tools/registry/core-market-reads.js";
import { toInjectedToolName } from "../../tools/registry/injected-protocol-tools.js";

/**
 * T-5: name the preloaded core market reads in the Map, from the SAME
 * predicate that puts them in the tools array (`core-market-reads.ts`). The
 * prompt's protocol rules say a protocol tool needs a `ToolSearch` result
 * first; this line is the stated exception, present only while the preload is.
 * No line at all when the switch is off or in mission setup, so that path
 * renders byte for byte as before.
 */
function coreMarketReadsLine(ctx: ToolVisibilityContext): string | null {
  const names = coreMarketReadToolIds(ctx).map(toInjectedToolName);
  if (names.length === 0) return null;
  return "**Preloaded market reads (protocol tools already in your tool list with full schemas; "
    + `call them directly, no ToolSearch needed):** ${names.join(", ")}`;
}

export function buildToolCatalogPrompt(ctx: ToolVisibilityContext): string {
  const categories = getVisibleToolsByCategory(ctx);
  if (categories.length === 0) {
    // No agent-surface tools visible (unlikely in practice). Suppress the
    // section entirely rather than render an empty heading —
    // `buildPromptStack` already skips empty strings.
    return "";
  }

  const lines: string[] = [];
  lines.push("# Available Tool Map");
  lines.push("");
  for (const cat of categories) {
    lines.push(`**${cat.label}:** ${cat.toolNames.join(", ")}`);
  }
  const preloaded = coreMarketReadsLine(ctx);
  if (preloaded !== null) lines.push(preloaded);
  return lines.join("\n");
}
