/**
 * Tool registry - single source of truth for all tools the LLM can call.
 *
 * Defines internal tools (handled in-process) and two protocol meta-tools
 * (ToolSearch) that gives access to protocol capabilities.
 *
 * Public API module. ToolDef arrays live in `./registry/<domain>.ts` (one
 * file per cohesive domain) - this barrel concatenates them and exposes the
 * lookup / filtering / projection functions consumers depend on. Adding a
 * new tool = touch one domain file plus this barrel's import + concat.
 *
 * The lookup / visibility / OpenAI-projection / Tool-Map implementations live
 * in `./registry/{lookup,visibility,openai-tools,tool-map}.ts`; this module is
 * the re-export façade that preserves the public surface consumers depend on.
 *
 * No trade_log - runtime captures automatically.
 * No legacy memory-management tools - long-term memory is manager-owned; the agent only suggests (`MemorySuggest`).
 */

export {
  getToolDef,
  isInternalTool,
  isMutatingTool,
  getPressureSafety,
  getActionKind,
  getAllTools,
} from "./registry/lookup.js";

export {
  defaultVisibilityContext,
  getVisibleToolDefs,
} from "./registry/visibility.js";
export type {
  ToolVisibilityContext,
  ToolVisibilityBase,
} from "./registry/visibility.js";

export { getOpenAITools } from "./registry/openai-tools.js";

export {
  TOOL_MAP_CATEGORIES,
  getVisibleToolsByCategory,
} from "./registry/tool-map.js";
export type {
  ToolMapCategory,
  VisibleToolMapCategory,
} from "./registry/tool-map.js";
