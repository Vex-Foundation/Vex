/**
 * Tool registry OpenAI projection - `getOpenAITools`.
 *
 * Thin wrapper over `getVisibleToolDefs` + the OpenAI projection - keeps the
 * filter chain in one place. Imports `toOpenAITools` from the canonical
 * `../types.js`; never imports the `registry.js` façade (cycle).
 */

import type { OpenAITool } from "../types.js";
import { toOpenAITools } from "../types.js";

import { getVisibleToolDefs, type ToolVisibilityContext } from "./visibility.js";
import { buildInjectedProtocolTools } from "./injected-protocol-tools.js";
import { buildUserMcpTools } from "../user-mcp/admitted.js";

/**
 * Get tools as OpenAI format, filtered for the given session context.
 *
 * Thin wrapper over `getVisibleToolDefs` + the OpenAI projection - keeps
 * the filter chain in one place.
 *
 * INJECTED PROTOCOL TOOLS (owner decision 2026-08-03, SPEC §7 Q1). The tools
 * this session DISCOVERED are appended as real function schemas so the
 * provider enforces their required params instead of the model re-reading a
 * prior tool result. Two properties of this call site are load-bearing:
 *
 *  - POSITIONALLY LAST. The internal tool block is stable across turns; the
 *    injected block is not. Keeping the volatile part at the end preserves
 *    the longest possible stable prefix for providers that prefix-cache tool
 *    definitions (Anthropic caches tool defs in the prompt prefix).
 *  - CACHE CHURN IS ACCEPTED, NOT AVOIDED. Every `ToolSearch` call that
 *    returns a new toolId changes the tools array, which invalidates that
 *    prefix cache for the following turn. That is the priced-in cost of
 *    moving `required` into the one channel a provider can enforce; the
 *    alternative (prose-only params) is what produced the live
 *    missing-required-param loops. Do not "fix" the churn by caching a stale
 *    tools array - a schema the model can see but the dispatcher would reject
 *    is worse than a cache miss.
 *
 * THE USER'S OWN MCP TOOLS (F12) come third and last: the tools the user
 * turned on in Settings, in interactive agent sessions only. They change only
 * when Settings or a recheck changes them, so they sit after the injected
 * block and leave the stable prefix alone.
 */
export function getOpenAITools(ctx: ToolVisibilityContext): OpenAITool[] {
  return [
    ...toOpenAITools(getVisibleToolDefs(ctx)),
    ...buildInjectedProtocolTools(ctx),
    ...buildUserMcpTools(ctx),
  ];
}
